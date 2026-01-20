import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { ConfigManager } from '../../lib/config.js';
import { ConfluenceClient, type CreatePageRequest, type UpdatePageRequest } from '../../lib/confluence-client/index.js';
import { EXIT_CODES, PageNotFoundError, VersionConflictError } from '../../lib/errors.js';
import { sortByDependencies } from '../../lib/dependency-sorter.js';
import { detectPushCandidates, type PushCandidate } from '../../lib/file-scanner.js';
import {
  buildPageLookupMap,
  extractH1Title,
  HtmlConverter,
  parseMarkdown,
  serializeMarkdown,
  stripH1Title,
  type PageFrontmatter,
} from '../../lib/markdown/index.js';
import {
  hasSpaceConfig,
  readSpaceConfig,
  updatePageSyncInfo,
  writeSpaceConfig,
  type SpaceConfigWithState,
} from '../../lib/space-config.js';
import { handleFileRename } from './file-rename.js';
import { ensureFolderHierarchy, FolderHierarchyError } from './folder-hierarchy.js';

export interface PushCommandOptions {
  file?: string;
  force?: boolean;
  dryRun?: boolean;
}

// Confluence Cloud has a ~65k character limit for page content in Storage Format
// This is an approximate limit - the actual limit depends on the complexity of the HTML
// Reference: https://confluence.atlassian.com/doc/confluence-cloud-document-and-restriction-limits-938777919.html
const MAX_PAGE_SIZE = 65000;

/**
 * Push command - pushes local markdown files to Confluence
 * When file is specified: pushes single file
 * When no file: scans for changed files and prompts for each
 */
export async function pushCommand(options: PushCommandOptions): Promise<void> {
  const configManager = new ConfigManager();
  const config = await configManager.getConfig();

  if (!config) {
    console.error(chalk.red('Not configured. Please run "cn setup" first.'));
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const directory = process.cwd();

  // Check if space is configured
  if (!hasSpaceConfig(directory)) {
    console.error(chalk.red('No space configured in this directory.'));
    console.log(chalk.gray('Run "cn clone <SPACE_KEY>" to clone a space first.'));
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const spaceConfigResult = readSpaceConfig(directory);
  if (!spaceConfigResult || !spaceConfigResult.spaceId || !spaceConfigResult.spaceKey) {
    console.error(chalk.red('Invalid space configuration.'));
    console.log(chalk.gray('The .confluence.json file may be corrupted.'));
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }
  const spaceConfig = spaceConfigResult;

  const client = new ConfluenceClient(config);

  // If no file specified, scan for changes and prompt
  if (!options.file) {
    await pushBatch(client, config, spaceConfig, directory, options);
    return;
  }

  // Single file push - exit with error code on failure
  try {
    await pushSingleFile(client, config, spaceConfig, directory, options.file, options);
  } catch (error) {
    if (error instanceof PushError || error instanceof FolderHierarchyError) {
      process.exit(error.exitCode);
    }
    // Unexpected error - log and exit with general error code
    console.error(chalk.red('Unexpected error:'));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(EXIT_CODES.GENERAL_ERROR);
  }
}

/**
 * Push a single file to Confluence
 */
async function pushSingleFile(
  client: ConfluenceClient,
  config: { confluenceUrl: string },
  spaceConfig: SpaceConfigWithState,
  directory: string,
  file: string,
  options: PushCommandOptions,
): Promise<void> {
  // Resolve and validate file path
  const filePath = resolve(directory, file);
  if (!existsSync(filePath)) {
    console.error(chalk.red(`File not found: ${file}`));
    throw new PushError(`File not found: ${file}`, EXIT_CODES.INVALID_ARGUMENTS);
  }

  // Validate file extension
  if (!filePath.endsWith('.md')) {
    console.error(chalk.red(`Invalid file type: ${file}`));
    console.log(chalk.gray('Only markdown files (.md) are supported.'));
    throw new PushError(`Invalid file type: ${file}`, EXIT_CODES.INVALID_ARGUMENTS);
  }

  // Read and parse the markdown file
  const markdownContent = readFileSync(filePath, 'utf-8');
  const { frontmatter, content } = parseMarkdown(markdownContent);

  // Get title: frontmatter > H1 heading > filename
  const currentFilename = basename(filePath, '.md');
  const h1Title = extractH1Title(content);
  const title = frontmatter.title || h1Title || currentFilename;

  // Strip H1 from content - Confluence displays title separately
  const bodyContent = stripH1Title(content);

  // Warn if using filename fallback for new pages
  if (!frontmatter.page_id && !frontmatter.title && !h1Title) {
    console.log(chalk.yellow(`  Note: No title found, using filename: "${title}"`));
  }

  // Check if this is a new page (no page_id) or existing page
  if (!frontmatter.page_id) {
    await createNewPage(
      client,
      config,
      spaceConfig,
      directory,
      filePath,
      file,
      options,
      frontmatter,
      bodyContent,
      title,
    );
  } else {
    await updateExistingPage(
      client,
      config,
      spaceConfig,
      directory,
      filePath,
      file,
      options,
      frontmatter,
      bodyContent,
      title,
    );
  }
}

/**
 * Scan for changed files and push with y/n prompts
 */
async function pushBatch(
  client: ConfluenceClient,
  config: { confluenceUrl: string },
  spaceConfig: SpaceConfigWithState,
  directory: string,
  options: PushCommandOptions,
): Promise<void> {
  console.log(chalk.gray('Scanning for changes...'));
  console.log('');

  const candidates = detectPushCandidates(directory);

  if (candidates.length === 0) {
    console.log(chalk.green('No changes to push.'));
    return;
  }

  // Sort by dependencies so linked-to pages are pushed first
  const { sorted: sortedCandidates, cycles } = sortByDependencies(candidates, directory);

  // Warn about circular dependencies
  if (cycles.length > 0) {
    console.log(chalk.yellow('Circular link dependencies detected:'));
    for (const cycle of cycles) {
      console.log(chalk.yellow(`  ${cycle.join(' -> ')} -> ${cycle[0]}`));
    }
    console.log('');
  }

  // Show summary
  const newCount = sortedCandidates.filter((c) => c.type === 'new').length;
  const modifiedCount = sortedCandidates.filter((c) => c.type === 'modified').length;

  console.log(`Found ${chalk.bold(sortedCandidates.length)} file(s) to push:`);
  for (const candidate of sortedCandidates) {
    const typeLabel = candidate.type === 'new' ? chalk.cyan('[N]') : chalk.yellow('[M]');
    console.log(`  ${typeLabel} ${candidate.path}`);
  }
  console.log('');

  if (options.dryRun) {
    console.log(chalk.blue('--- DRY RUN MODE ---'));
    console.log(chalk.gray(`Would push ${newCount} new and ${modifiedCount} modified file(s)`));
    console.log(chalk.blue('No changes were made (dry run mode)'));
    return;
  }

  // Process each candidate with y/n prompt
  let pushed = 0;
  let skipped = 0;
  let failed = 0;
  const failedFiles: string[] = [];

  for (const candidate of sortedCandidates) {
    const typeLabel = candidate.type === 'new' ? 'create' : 'update';
    const shouldPush = await confirm({
      message: `Push ${candidate.path}? (${typeLabel})`,
      default: true,
    });

    if (!shouldPush) {
      skipped++;
      continue;
    }

    try {
      await pushSingleFile(client, config, spaceConfig, directory, candidate.path, {
        ...options,
        file: candidate.path,
      });
      pushed++;
    } catch (error) {
      // Don't exit on individual failures in batch mode
      // PushError/FolderHierarchyError already printed their message, other errors need printing
      if (!(error instanceof PushError) && !(error instanceof FolderHierarchyError)) {
        console.error(chalk.red(`  Failed: ${error instanceof Error ? error.message : 'Unknown error'}`));
      }
      failed++;
      failedFiles.push(candidate.path);
    }

    console.log('');
  }

  // Summary
  console.log(chalk.bold('Push complete:'));
  if (pushed > 0) console.log(chalk.green(`  ${pushed} pushed`));
  if (skipped > 0) console.log(chalk.gray(`  ${skipped} skipped`));
  if (failed > 0) {
    console.log(chalk.red(`  ${failed} failed`));
    console.log('');
    console.log(chalk.gray('Failed files:'));
    for (const file of failedFiles) {
      console.log(chalk.gray(`  ${file}`));
    }
  }
}

/**
 * Error thrown during push operations
 */
class PushError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = 'PushError';
  }
}

/**
 * Handle push errors - formats error and throws PushError
 */
function handlePushError(error: unknown, filePath: string): never {
  if (error instanceof PageNotFoundError) {
    console.error('');
    console.error(chalk.red(`Page not found on Confluence (ID: ${error.pageId}).`));
    console.log(chalk.gray('The page may have been deleted.'));
    throw new PushError(`Page not found: ${error.pageId}`, EXIT_CODES.PAGE_NOT_FOUND);
  }

  if (error instanceof VersionConflictError) {
    console.error('');
    console.error(chalk.red('Version conflict: remote version has changed.'));
    console.log(chalk.gray(`Run "cn pull --page ${filePath}" to get the latest version.`));
    throw new PushError('Version conflict', EXIT_CODES.VERSION_CONFLICT);
  }

  console.error('');
  console.error(chalk.red('Push failed'));
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(chalk.red(message));
  throw new PushError(message, EXIT_CODES.GENERAL_ERROR);
}

/**
 * Create a new page on Confluence
 */
async function createNewPage(
  client: ConfluenceClient,
  config: { confluenceUrl: string },
  spaceConfig: SpaceConfigWithState,
  directory: string,
  filePath: string,
  relativePath: string,
  options: PushCommandOptions,
  frontmatter: Partial<PageFrontmatter>,
  content: string,
  title: string,
): Promise<void> {
  console.log(chalk.bold(`Creating: ${title}`));
  console.log(chalk.cyan('  (New page - no page_id in frontmatter)'));

  // Convert markdown to HTML with link conversion (ADR-0022)
  // Re-read config to get the latest sync state (important for batch pushes where
  // earlier files may have been pushed and updated the sync state)
  console.log(chalk.gray('  Converting markdown to HTML...'));
  const converter = new HtmlConverter();
  const freshConfig = readSpaceConfig(directory) || spaceConfig;
  const pageLookupMap = buildPageLookupMap(freshConfig);
  const { html, warnings } = converter.convert(
    content,
    directory,
    relativePath.replace(/^\.\//, ''),
    freshConfig.spaceKey,
    pageLookupMap,
  );

  // Validate content size
  if (html.length > MAX_PAGE_SIZE) {
    console.error('');
    console.error(chalk.red(`Content too large: ${html.length} characters (max: ${MAX_PAGE_SIZE})`));
    console.log(chalk.gray('Confluence has a page size limit. Consider splitting into multiple pages.'));
    throw new PushError(`Content too large: ${html.length} characters`, EXIT_CODES.INVALID_ARGUMENTS);
  }

  // Show conversion warnings
  if (warnings.length > 0) {
    console.log('');
    console.log(chalk.yellow('Conversion warnings:'));
    for (const warning of warnings) {
      console.log(chalk.yellow(`  ! ${warning}`));
    }
    console.log('');
  }

  // Determine parent handling - either explicit parent_id or auto-create folder hierarchy
  let parentId: string | undefined = frontmatter.parent_id ?? undefined;
  let intendedParentId: string | undefined; // Track intended parent for retry on move failure
  let shouldUseMoveWorkaround = false;
  let currentConfig = spaceConfig;

  // Validate explicit parent_id if specified
  if (frontmatter.parent_id) {
    try {
      console.log(chalk.gray('  Validating parent page...'));
      await client.getPage(frontmatter.parent_id, false);
    } catch (error) {
      if (error instanceof PageNotFoundError) {
        console.error('');
        console.error(chalk.red(`Parent page not found (ID: ${frontmatter.parent_id}).`));
        console.log(chalk.gray('Remove parent_id from frontmatter or use a valid page ID.'));
        throw new PushError(`Parent page not found: ${frontmatter.parent_id}`, EXIT_CODES.PAGE_NOT_FOUND);
      }
      throw error;
    }
  } else {
    // No explicit parent_id - check if file is in a subdirectory
    // If so, ensure folder hierarchy exists (ADR-0023)
    const result = await ensureFolderHierarchy(client, spaceConfig, directory, relativePath, options.dryRun);
    parentId = result.parentId;
    intendedParentId = result.parentId; // Save for potential retry
    shouldUseMoveWorkaround = result.shouldUseMoveWorkaround;
    currentConfig = result.updatedConfig;
  }

  // Build create request
  // Note: If shouldUseMoveWorkaround is true, we create page at space root first, then move to folder
  // This is because Confluence v2 API doesn't support creating pages directly under folders
  const createRequest: CreatePageRequest = {
    spaceId: currentConfig.spaceId,
    status: 'current',
    title,
    parentId: shouldUseMoveWorkaround ? undefined : parentId,
    body: {
      representation: 'storage',
      value: html,
    },
  };

  // Dry run mode - show what would be done without actually creating
  if (options.dryRun) {
    console.log('');
    console.log(chalk.blue('--- DRY RUN MODE ---'));
    console.log(chalk.gray('Would create new page:'));
    console.log(chalk.gray(`  Title: ${title}`));
    console.log(chalk.gray(`  Space: ${currentConfig.spaceKey}`));
    if (shouldUseMoveWorkaround && parentId) {
      console.log(chalk.gray(`  Would move to folder ID: ${parentId}`));
    } else if (createRequest.parentId) {
      console.log(chalk.gray(`  Parent ID: ${createRequest.parentId}`));
    }
    console.log(chalk.gray(`  Content size: ${html.length} characters`));
    console.log('');
    console.log(chalk.blue('No changes were made (dry run mode)'));
    return;
  }

  try {
    // Create page on Confluence
    console.log(chalk.gray('  Creating page on Confluence...'));
    const createdPage = await client.createPage(createRequest);

    // Move page to folder if needed (ADR-0023)
    let moveSucceeded = false;
    if (shouldUseMoveWorkaround && parentId) {
      console.log(chalk.gray(`  Moving page into folder...`));
      try {
        await client.movePage(createdPage.id, parentId, 'append');
        console.log(chalk.green(`  Moved page to folder`));
        moveSucceeded = true;
      } catch (moveError) {
        // If move fails, warn but don't fail the entire operation
        // The page was created successfully, just not in the right location
        // Preserve intendedParentId in frontmatter so user can retry
        const moveErrorMsg = moveError instanceof Error ? moveError.message : String(moveError);
        console.log(chalk.yellow(`  Warning: Could not move page to folder. Page created at space root.`));
        console.log(chalk.gray(`  Move error: ${moveErrorMsg}`));
        console.log(chalk.yellow(`  The intended parent_id will be preserved for retry.`));
        console.log(chalk.yellow(`  Run "cn push ${relativePath}" again to retry the move.`));
      }
    }

    // Set editor property to v2 to enable the new editor
    // This is needed because the V2 API with storage format defaults to legacy editor
    // See: https://community.developer.atlassian.com/t/confluence-rest-api-v2-struggling-to-create-a-page-with-the-new-editor/75235
    try {
      await client.setEditorV2(createdPage.id);
    } catch {
      // Non-fatal: page was created but may use legacy editor
      console.log(chalk.yellow('  Warning: Could not set editor to v2. Page may use legacy editor.'));
    }

    // Fetch updated page to get correct parentId after move (only if move succeeded)
    const finalPage = moveSucceeded ? await client.getPage(createdPage.id, false) : createdPage;

    // Build complete frontmatter from response
    // If move failed, preserve the intended parent_id so user can retry
    const webui = finalPage._links?.webui || createdPage._links?.webui;
    const effectiveParentId = moveSucceeded
      ? (finalPage.parentId ?? undefined)
      : (intendedParentId ?? finalPage.parentId ?? undefined);
    const newFrontmatter: PageFrontmatter = {
      page_id: createdPage.id,
      title: createdPage.title,
      space_key: currentConfig.spaceKey,
      created_at: createdPage.createdAt,
      updated_at: createdPage.version?.createdAt,
      version: createdPage.version?.number || 1,
      parent_id: effectiveParentId,
      author_id: createdPage.authorId,
      last_modifier_id: createdPage.version?.authorId,
      url: webui ? `${config.confluenceUrl}/wiki${webui}` : undefined,
      synced_at: new Date().toISOString(),
    };

    // Preserve any extra frontmatter fields the user may have added
    const updatedFrontmatter: PageFrontmatter = {
      ...frontmatter,
      ...newFrontmatter,
    };

    const updatedMarkdown = serializeMarkdown(updatedFrontmatter, content);

    // Handle file rename if title changed
    const { finalPath: finalLocalPath } = handleFileRename(filePath, relativePath, createdPage.title, updatedMarkdown);

    // Update .confluence.json sync state
    let updatedSpaceConfig = readSpaceConfig(directory);
    if (updatedSpaceConfig) {
      // First, merge in any folder updates from ensureFolderHierarchy
      if (currentConfig.folders) {
        updatedSpaceConfig = { ...updatedSpaceConfig, folders: currentConfig.folders };
      }
      updatedSpaceConfig = updatePageSyncInfo(updatedSpaceConfig, {
        pageId: createdPage.id,
        version: createdPage.version?.number || 1,
        lastModified: createdPage.version?.createdAt,
        localPath: finalLocalPath,
        title: createdPage.title,
      });
      writeSpaceConfig(directory, updatedSpaceConfig);
    }

    // Success!
    console.log('');
    console.log(chalk.green(`✓ Created: ${createdPage.title} (page_id: ${createdPage.id})`));

    if (webui) {
      console.log(chalk.gray(`  ${config.confluenceUrl}/wiki${webui}`));
    }
  } catch (error) {
    handlePushError(error, relativePath);
  }
}

/**
 * Update an existing page on Confluence
 */
async function updateExistingPage(
  client: ConfluenceClient,
  config: { confluenceUrl: string },
  spaceConfig: SpaceConfigWithState,
  directory: string,
  filePath: string,
  relativePath: string,
  options: PushCommandOptions,
  frontmatter: Partial<PageFrontmatter>,
  content: string,
  title: string,
): Promise<void> {
  // Verify page_id exists (should be guaranteed by caller)
  if (!frontmatter.page_id) {
    throw new Error('updateExistingPage called without page_id');
  }

  const pageId = frontmatter.page_id;
  const localVersion = frontmatter.version || 1;

  console.log(chalk.bold(`Pushing: ${title}`));

  try {
    // Fetch current page to check version
    console.log(chalk.gray('  Checking remote version...'));
    const remotePage = await client.getPage(pageId, false);
    const remoteVersion = remotePage.version?.number || 1;

    // Check version match (unless --force)
    if (!options.force && localVersion !== remoteVersion) {
      console.error('');
      console.error(chalk.red(`Version conflict detected.`));
      console.error(chalk.red(`  Local version:  ${localVersion}`));
      console.error(chalk.red(`  Remote version: ${remoteVersion}`));
      console.error('');
      console.log(chalk.yellow('The page has been modified on Confluence since your last pull.'));
      console.log(chalk.gray('Options:'));
      console.log(chalk.gray(`  - Run "cn pull --page ${relativePath}" to get the latest version`));
      console.log(chalk.gray(`  - Run "cn push ${relativePath} --force" to overwrite remote changes`));
      throw new PushError('Version conflict', EXIT_CODES.VERSION_CONFLICT);
    }

    // Warn if title differs
    if (remotePage.title !== title) {
      console.log(chalk.yellow(`  Warning: Title differs (local: "${title}", remote: "${remotePage.title}")`));
      console.log(chalk.yellow('  The remote title will be updated to match local.'));
    }

    // Convert markdown to HTML with link conversion (ADR-0022)
    // Re-read config to get the latest sync state (important for batch pushes where
    // earlier files may have been pushed and updated the sync state)
    console.log(chalk.gray('  Converting markdown to HTML...'));
    const converter = new HtmlConverter();
    const freshConfig = readSpaceConfig(directory) || spaceConfig;
    const pageLookupMap = buildPageLookupMap(freshConfig);
    const { html, warnings } = converter.convert(
      content,
      directory,
      relativePath.replace(/^\.\//, ''),
      freshConfig.spaceKey,
      pageLookupMap,
    );

    // Validate content size
    if (html.length > MAX_PAGE_SIZE) {
      console.error('');
      console.error(chalk.red(`Content too large: ${html.length} characters (max: ${MAX_PAGE_SIZE})`));
      console.log(chalk.gray('Confluence has a page size limit. Consider splitting into multiple pages.'));
      throw new PushError(`Content too large: ${html.length} characters`, EXIT_CODES.INVALID_ARGUMENTS);
    }

    // Show conversion warnings
    if (warnings.length > 0) {
      console.log('');
      console.log(chalk.yellow('Conversion warnings:'));
      for (const warning of warnings) {
        console.log(chalk.yellow(`  ! ${warning}`));
      }
      console.log('');
    }

    // Build update request
    const newVersion = (options.force ? remoteVersion : localVersion) + 1;
    const updateRequest: UpdatePageRequest = {
      id: pageId,
      status: 'current',
      title,
      body: {
        representation: 'storage',
        value: html,
      },
      version: {
        number: newVersion,
      },
    };

    // Dry run mode - show what would be done without actually updating
    if (options.dryRun) {
      console.log('');
      console.log(chalk.blue('--- DRY RUN MODE ---'));
      console.log(chalk.gray('Would update page:'));
      console.log(chalk.gray(`  Page ID: ${pageId}`));
      console.log(chalk.gray(`  Title: ${title}`));
      console.log(chalk.gray(`  Version: ${localVersion} → ${newVersion}`));
      if (options.force) {
        console.log(chalk.yellow('  Force mode: Would overwrite remote changes'));
      }
      console.log(chalk.gray(`  Content size: ${html.length} characters`));
      console.log('');
      console.log(chalk.blue('No changes were made (dry run mode)'));
      return;
    }

    // Push to Confluence
    console.log(chalk.gray(`  Pushing to Confluence (version ${localVersion} → ${newVersion})...`));
    const updatedPage = await client.updatePage(updateRequest);

    // Update local frontmatter with new metadata from response
    const webui = updatedPage._links?.webui;
    const updatedFrontmatter: PageFrontmatter = {
      ...frontmatter,
      page_id: pageId,
      title: updatedPage.title,
      space_key: frontmatter.space_key || spaceConfig.spaceKey || '',
      version: updatedPage.version?.number || newVersion,
      updated_at: updatedPage.version?.createdAt,
      last_modifier_id: updatedPage.version?.authorId,
      url: webui ? `${config.confluenceUrl}/wiki${webui}` : frontmatter.url,
      synced_at: new Date().toISOString(),
    };
    const updatedMarkdown = serializeMarkdown(updatedFrontmatter, content);

    // Handle file rename if title changed
    const { finalPath: finalLocalPath } = handleFileRename(filePath, relativePath, updatedPage.title, updatedMarkdown);

    // Update .confluence.json sync state
    let updatedSpaceConfig = readSpaceConfig(directory);
    if (updatedSpaceConfig) {
      updatedSpaceConfig = updatePageSyncInfo(updatedSpaceConfig, {
        pageId,
        version: updatedPage.version?.number || newVersion,
        lastModified: updatedPage.version?.createdAt,
        localPath: finalLocalPath,
        title: updatedPage.title,
      });
      writeSpaceConfig(directory, updatedSpaceConfig);
    }

    // Success!
    console.log('');
    console.log(
      chalk.green(
        `✓ Pushed: ${updatedPage.title} (version ${localVersion} → ${updatedPage.version?.number || newVersion})`,
      ),
    );

    if (webui) {
      console.log(chalk.gray(`  ${config.confluenceUrl}/wiki${webui}`));
    }
  } catch (error) {
    handlePushError(error, relativePath);
  }
}
