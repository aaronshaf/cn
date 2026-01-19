import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { existsSync, readFileSync, renameSync, writeFileSync, mkdtempSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { ConfigManager } from '../../lib/config.js';
import { ConfluenceClient, type CreatePageRequest, type UpdatePageRequest } from '../../lib/confluence-client/index.js';
import { EXIT_CODES, PageNotFoundError, VersionConflictError } from '../../lib/errors.js';
import { detectPushCandidates, type PushCandidate } from '../../lib/file-scanner.js';
import {
  buildPageLookupMap,
  HtmlConverter,
  parseMarkdown,
  serializeMarkdown,
  slugify,
  type PageFrontmatter,
} from '../../lib/markdown/index.js';
import {
  hasSpaceConfig,
  readSpaceConfig,
  updatePageSyncInfo,
  writeSpaceConfig,
  type SpaceConfigWithState,
} from '../../lib/space-config.js';

export interface PushCommandOptions {
  file?: string;
  force?: boolean;
  dryRun?: boolean;
}

// Constants
const INDEX_FILES = ['index.md', 'README.md'] as const;
// Confluence Cloud has a ~65k character limit for page content in Storage Format
// This is an approximate limit - the actual limit depends on the complexity of the HTML
// Reference: https://confluence.atlassian.com/doc/confluence-cloud-document-and-restriction-limits-938777919.html
const MAX_PAGE_SIZE = 65000;

/**
 * Result of file rename operation
 */
interface RenameResult {
  finalPath: string;
  wasRenamed: boolean;
}

/**
 * Handle file renaming when title changes
 * Returns the final local path for updating sync state
 * Uses atomic operations: writes to temp file first, then renames
 */
function handleFileRename(
  filePath: string,
  originalRelativePath: string,
  expectedTitle: string,
  updatedMarkdown: string,
): RenameResult {
  const currentFilename = basename(filePath);
  const currentDir = dirname(filePath);
  const expectedSlug = slugify(expectedTitle);
  const expectedFilename = `${expectedSlug}.md`;
  let finalLocalPath = originalRelativePath.replace(/^\.\//, '');

  const isIndexFile = INDEX_FILES.includes(currentFilename as (typeof INDEX_FILES)[number]);

  // Write to temp file first for atomicity
  const tempDir = mkdtempSync(join(tmpdir(), 'cn-push-'));
  const tempFile = join(tempDir, 'temp.md');
  writeFileSync(tempFile, updatedMarkdown, 'utf-8');

  try {
    if (!isIndexFile && expectedFilename !== currentFilename && expectedSlug) {
      const newFilePath = join(currentDir, expectedFilename);

      if (existsSync(newFilePath)) {
        console.log(chalk.yellow(`  Note: Keeping filename "${currentFilename}" (${expectedFilename} already exists)`));
        // Atomic rename: temp file -> original file
        renameSync(tempFile, filePath);
        return { finalPath: finalLocalPath, wasRenamed: false };
      }

      // Warn user about automatic rename
      console.log(chalk.cyan(`  Note: File will be renamed to match page title`));

      // Atomic operations: remove old file, move temp to new location
      const backupPath = `${filePath}.bak`;
      renameSync(filePath, backupPath);
      try {
        renameSync(tempFile, newFilePath);
        // Clean up backup only after successful rename
        try {
          unlinkSync(backupPath);
        } catch {
          // Ignore cleanup errors
        }
      } catch (error) {
        // Restore from backup if rename fails
        try {
          renameSync(backupPath, filePath);
        } catch {
          // If restore fails, log the backup location
          console.error(chalk.red(`  Error: Failed to rename file. Backup available at: ${backupPath}`));
        }
        throw error;
      }

      const relativeDir = dirname(finalLocalPath);
      finalLocalPath = relativeDir === '.' ? expectedFilename : join(relativeDir, expectedFilename);
      console.log(chalk.cyan(`  Renamed: ${currentFilename} → ${expectedFilename}`));
      return { finalPath: finalLocalPath, wasRenamed: true };
    }

    // Atomic rename: temp file -> original file
    renameSync(tempFile, filePath);
    return { finalPath: finalLocalPath, wasRenamed: false };
  } finally {
    // Always clean up temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

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
    if (error instanceof PushError) {
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

  // Get title from frontmatter or filename
  const currentFilename = basename(filePath, '.md');
  const title = frontmatter.title || currentFilename;

  // Warn if no title in frontmatter for new pages
  if (!frontmatter.page_id && !frontmatter.title) {
    console.log(chalk.yellow(`  Note: No title in frontmatter, using filename: "${title}"`));
  }

  // Check if this is a new page (no page_id) or existing page
  if (!frontmatter.page_id) {
    await createNewPage(client, config, spaceConfig, directory, filePath, file, options, frontmatter, content, title);
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
      content,
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

  // Show summary
  const newCount = candidates.filter((c) => c.type === 'new').length;
  const modifiedCount = candidates.filter((c) => c.type === 'modified').length;

  console.log(`Found ${chalk.bold(candidates.length)} file(s) to push:`);
  for (const candidate of candidates) {
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

  for (const candidate of candidates) {
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
      // PushError already printed its message, other errors need printing
      if (!(error instanceof PushError)) {
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
  console.log(chalk.gray('  Converting markdown to HTML...'));
  const converter = new HtmlConverter();
  const pageLookupMap = buildPageLookupMap(spaceConfig);
  const { html, warnings } = converter.convert(
    content,
    directory,
    relativePath.replace(/^\.\//, ''),
    spaceConfig.spaceKey,
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

  // Validate parent_id if specified
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
  }

  // Build create request
  const createRequest: CreatePageRequest = {
    spaceId: spaceConfig.spaceId,
    status: 'current',
    title,
    parentId: frontmatter.parent_id || undefined,
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
    console.log(chalk.gray(`  Space: ${spaceConfig.spaceKey}`));
    if (createRequest.parentId) {
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

    // Build complete frontmatter from response
    const webui = createdPage._links?.webui;
    const newFrontmatter: PageFrontmatter = {
      page_id: createdPage.id,
      title: createdPage.title,
      space_key: spaceConfig.spaceKey,
      created_at: createdPage.createdAt,
      updated_at: createdPage.version?.createdAt,
      version: createdPage.version?.number || 1,
      parent_id: createdPage.parentId,
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
      updatedSpaceConfig = updatePageSyncInfo(updatedSpaceConfig, {
        pageId: createdPage.id,
        version: createdPage.version?.number || 1,
        lastModified: createdPage.version?.createdAt,
        localPath: finalLocalPath,
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
    console.log(chalk.gray('  Converting markdown to HTML...'));
    const converter = new HtmlConverter();
    const pageLookupMap = buildPageLookupMap(spaceConfig);
    const { html, warnings } = converter.convert(
      content,
      directory,
      relativePath.replace(/^\.\//, ''),
      spaceConfig.spaceKey,
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
