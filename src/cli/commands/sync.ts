import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import { ConfigManager } from '../../lib/config.js';
import { EXIT_CODES } from '../../lib/errors.js';
import { getFormatter } from '../../lib/formatters.js';
import { readSpaceConfig, hasSpaceConfig } from '../../lib/space-config.js';
import { SyncEngine, type SyncProgressReporter } from '../../lib/sync/index.js';

/**
 * Create a progress reporter for sync operations
 */
function createProgressReporter(spinner: Ora): SyncProgressReporter {
  return {
    onFetchStart: () => {
      spinner.text = 'Fetching pages from Confluence...';
    },
    onFetchComplete: (pageCount, folderCount) => {
      const folderText = folderCount > 0 ? ` and ${folderCount} folders` : '';
      spinner.text = `Found ${pageCount} pages${folderText}, comparing with local state...`;
    },
    onDiffComplete: (added, modified, deleted) => {
      const total = added + modified + deleted;
      if (total === 0) {
        spinner.succeed('Already up to date');
      } else {
        spinner.stop();
        const parts = [];
        if (added > 0) parts.push(chalk.green(`${added} new`));
        if (modified > 0) parts.push(chalk.yellow(`${modified} modified`));
        if (deleted > 0) parts.push(chalk.red(`${deleted} deleted`));
        console.log(`  ${parts.join(', ')}`);
        console.log('');
      }
    },
    onPageStart: (index, total, title, type) => {
      const icon = type === 'added' ? chalk.green('↓') : type === 'modified' ? chalk.yellow('↓') : chalk.red('×');
      const label = type === 'added' ? 'new' : type === 'modified' ? 'modified' : 'deleted';
      process.stdout.write(`  [${index}/${total}] ${icon} ${title} (${label})...`);
    },
    onPageComplete: (_index, _total, _title, localPath) => {
      // Clear line and show completed path
      process.stdout.write(`\r\x1b[K`);
      const icon = localPath ? chalk.green('✓') : chalk.red('×');
      console.log(`  ${icon} ${localPath || 'deleted'}`);
    },
    onPageError: (title, error) => {
      process.stdout.write(`\r\x1b[K`);
      console.log(`  ${chalk.red('✗')} ${title}: ${error}`);
    },
  };
}

export interface SyncCommandOptions {
  init?: string;
  dryRun?: boolean;
  force?: boolean;
  depth?: number;
}

/**
 * Sync command - syncs a Confluence space to the local directory
 */
export async function syncCommand(options: SyncCommandOptions): Promise<void> {
  const configManager = new ConfigManager();
  const config = await configManager.getConfig();

  if (!config) {
    console.error(chalk.red('Not configured. Please run "cn setup" first.'));
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const syncEngine = new SyncEngine(config);
  const directory = process.cwd();
  const formatter = getFormatter(false);

  // Initialize new space
  if (options.init) {
    const spinner = ora(`Initializing sync for space ${options.init}...`).start();

    try {
      const spaceConfig = await syncEngine.initSync(directory, options.init);
      spinner.succeed(`Initialized sync for space "${spaceConfig.spaceName}" (${spaceConfig.spaceKey})`);

      console.log('');
      console.log(chalk.gray('Space configuration saved to .confluence.json'));
      console.log(chalk.gray('Run "cn sync" to download pages.'));
    } catch (error) {
      spinner.fail('Failed to initialize sync');

      if (error instanceof Error && error.message.includes('not found')) {
        console.error(chalk.red(`\nSpace "${options.init}" not found.`));
        console.log(chalk.gray('Check the space key and try again.'));
        process.exit(EXIT_CODES.SPACE_NOT_FOUND);
      }

      console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
      process.exit(EXIT_CODES.GENERAL_ERROR);
    }

    return;
  }

  // Check if space is configured
  if (!hasSpaceConfig(directory)) {
    console.error(chalk.red('No space configured in this directory.'));
    console.log(chalk.gray('Run "cn sync --init <SPACE_KEY>" to initialize.'));
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  // Get space info for display
  const spaceConfig = readSpaceConfig(directory);
  if (spaceConfig) {
    console.log(chalk.bold(`Syncing space: ${spaceConfig.spaceName} (${spaceConfig.spaceKey})`));
  }

  // Perform sync
  const spinner = ora(options.dryRun ? 'Checking for changes...' : 'Fetching pages...').start();
  const progressReporter = options.dryRun ? undefined : createProgressReporter(spinner);

  try {
    const result = await syncEngine.sync(directory, {
      dryRun: options.dryRun,
      force: options.force,
      depth: options.depth,
      progress: progressReporter,
    });

    // For dry run, stop spinner and show diff
    if (options.dryRun) {
      spinner.stop();
      console.log('');
      console.log(formatter.formatSyncDiff(result.changes));
    }

    // Show warnings
    if (result.warnings.length > 0) {
      console.log('');
      console.log(chalk.yellow('Warnings:'));
      for (const warning of result.warnings) {
        console.log(chalk.yellow(`  ! ${warning}`));
      }
    }

    // Show errors
    if (result.errors.length > 0) {
      console.log('');
      console.log(chalk.red('Errors:'));
      for (const error of result.errors) {
        console.log(chalk.red(`  x ${error}`));
      }
    }

    // If dry run, offer to sync
    if (options.dryRun) {
      const totalChanges = result.changes.added.length + result.changes.modified.length + result.changes.deleted.length;

      if (totalChanges > 0) {
        console.log('');
        console.log(chalk.gray('This was a dry run. No changes were made.'));
      }
    } else if (!result.success) {
      console.log('');
      console.error(chalk.red('Sync completed with errors.'));
      process.exit(EXIT_CODES.GENERAL_ERROR);
    } else {
      const { added, modified, deleted } = result.changes;
      const total = added.length + modified.length + deleted.length;
      if (total > 0) {
        console.log('');
        const parts = [];
        if (added.length > 0) parts.push(`${added.length} added`);
        if (modified.length > 0) parts.push(`${modified.length} modified`);
        if (deleted.length > 0) parts.push(`${deleted.length} deleted`);
        console.log(chalk.green(`✓ Sync complete: ${parts.join(', ')}`));
      }
    }
  } catch (error) {
    spinner.fail('Sync failed');
    console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
    process.exit(EXIT_CODES.GENERAL_ERROR);
  }
}
