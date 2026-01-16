import chalk from 'chalk';
import { existsSync, readFileSync, renameSync, writeFileSync, mkdtempSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { ConfigManager } from '../../lib/config.js';
import { ConfluenceClient, type CreatePageRequest, type UpdatePageRequest } from '../../lib/confluence-client/index.js';
import { EXIT_CODES, PageNotFoundError, VersionConflictError } from '../../lib/errors.js';
import {
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
  file: string;
  force?: boolean;
  dryRun?: boolean;
}

// Constants
const INDEX_FILES = ['index.md', 'README.md'] as const;
const MAX_PAGE_SIZE = 65000; // Confluence has a ~65k character limit

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
        console.log(chalk.yellow(`  Warning: Cannot rename to "${expectedFilename}" - file already exists`));
        // Atomic rename: temp file -> original file
        renameSync(tempFile, filePath);
        return { finalPath: finalLocalPath, wasRenamed: false };
      }

      // Warn user about automatic rename
      console.log(chalk.cyan(`  Note: File will be renamed to match page title`));

      // Atomic operations: remove old file, move temp to new location
      renameSync(filePath, `${filePath}.bak`);
      renameSync(tempFile, newFilePath);
      // Clean up backup
      try {
        unlinkSync(`${filePath}.bak`);
      } catch {
        // Ignore cleanup errors
      }

      const relativeDir = dirname(finalLocalPath);
      finalLocalPath = relativeDir === '.' ? expectedFilename : join(relativeDir, expectedFilename);
      console.log(chalk.cyan(`  Renamed: ${currentFilename} → ${expectedFilename}`));
      return { finalPath: finalLocalPath, wasRenamed: true };
    }

    // Atomic rename: temp file -> original file
    renameSync(tempFile, filePath);
    return { finalPath: finalLocalPath, wasRenamed: false };
  } catch (error) {
    // Clean up temp file on error
    try {
      unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Push command - pushes a local markdown file to Confluence
 * Creates new pages if page_id is missing, updates existing pages otherwise
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

  // Resolve and validate file path
  const filePath = resolve(directory, options.file);
  if (!existsSync(filePath)) {
    console.error(chalk.red(`File not found: ${options.file}`));
    process.exit(EXIT_CODES.INVALID_ARGUMENTS);
  }

  // Validate file extension
  if (!filePath.endsWith('.md')) {
    console.error(chalk.red(`Invalid file type: ${options.file}`));
    console.log(chalk.gray('Only markdown files (.md) are supported.'));
    process.exit(EXIT_CODES.INVALID_ARGUMENTS);
  }

  // Read and parse the markdown file
  const markdownContent = readFileSync(filePath, 'utf-8');
  const { frontmatter, content } = parseMarkdown(markdownContent);

  // Get title from frontmatter or filename
  const currentFilename = basename(filePath, '.md');
  const title = frontmatter.title || currentFilename;

  const client = new ConfluenceClient(config);

  // Check if this is a new page (no page_id) or existing page
  if (!frontmatter.page_id) {
    await createNewPage(client, config, spaceConfig, directory, filePath, options, frontmatter, content, title);
  } else {
    await updateExistingPage(client, config, spaceConfig, directory, filePath, options, frontmatter, content, title);
  }
}

/**
 * Handle push errors with consistent messaging
 */
function handlePushError(error: unknown, filePath: string): never {
  if (error instanceof PageNotFoundError) {
    console.error('');
    console.error(chalk.red(`Page not found on Confluence (ID: ${error.pageId}).`));
    console.log(chalk.gray('The page may have been deleted.'));
    process.exit(EXIT_CODES.PAGE_NOT_FOUND);
  }

  if (error instanceof VersionConflictError) {
    console.error('');
    console.error(chalk.red('Version conflict: remote version has changed.'));
    console.log(chalk.gray(`Run "cn pull --page ${filePath}" to get the latest version.`));
    process.exit(EXIT_CODES.VERSION_CONFLICT);
  }

  console.error('');
  console.error(chalk.red('Push failed'));
  console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
  process.exit(EXIT_CODES.GENERAL_ERROR);
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
  options: PushCommandOptions,
  frontmatter: Partial<PageFrontmatter>,
  content: string,
  title: string,
): Promise<void> {
  console.log(chalk.bold(`Creating: ${title}`));
  console.log(chalk.cyan('  (New page - no page_id in frontmatter)'));

  // Convert markdown to HTML
  console.log(chalk.gray('  Converting markdown to HTML...'));
  const converter = new HtmlConverter();
  const { html, warnings } = converter.convert(content);

  // Validate content size
  if (html.length > MAX_PAGE_SIZE) {
    console.error('');
    console.error(chalk.red(`Content too large: ${html.length} characters (max: ${MAX_PAGE_SIZE})`));
    console.log(chalk.gray('Confluence has a page size limit. Consider splitting into multiple pages.'));
    process.exit(EXIT_CODES.INVALID_ARGUMENTS);
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
        process.exit(EXIT_CODES.PAGE_NOT_FOUND);
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
    const { finalPath: finalLocalPath } = handleFileRename(filePath, options.file, createdPage.title, updatedMarkdown);

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
    handlePushError(error, options.file);
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
  options: PushCommandOptions,
  frontmatter: Partial<PageFrontmatter>,
  content: string,
  title: string,
): Promise<void> {
  const pageId = frontmatter.page_id!;
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
      console.log(chalk.gray('  - Run "cn pull --page ' + options.file + '" to get the latest version'));
      console.log(chalk.gray('  - Run "cn push ' + options.file + ' --force" to overwrite remote changes'));
      process.exit(EXIT_CODES.VERSION_CONFLICT);
    }

    // Warn if title differs
    if (remotePage.title !== title) {
      console.log(chalk.yellow(`  Warning: Title differs (local: "${title}", remote: "${remotePage.title}")`));
      console.log(chalk.yellow('  The remote title will be updated to match local.'));
    }

    // Convert markdown to HTML
    console.log(chalk.gray('  Converting markdown to HTML...'));
    const converter = new HtmlConverter();
    const { html, warnings } = converter.convert(content);

    // Validate content size
    if (html.length > MAX_PAGE_SIZE) {
      console.error('');
      console.error(chalk.red(`Content too large: ${html.length} characters (max: ${MAX_PAGE_SIZE})`));
      console.log(chalk.gray('Confluence has a page size limit. Consider splitting into multiple pages.'));
      process.exit(EXIT_CODES.INVALID_ARGUMENTS);
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
    const { finalPath: finalLocalPath } = handleFileRename(filePath, options.file, updatedPage.title, updatedMarkdown);

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
    handlePushError(error, options.file);
  }
}
