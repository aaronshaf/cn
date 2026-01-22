import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigManager } from '../../lib/config.js';
import { EXIT_CODES } from '../../lib/errors.js';
import { SyncEngine, type SyncProgressReporter } from '../../lib/sync/index.js';

/**
 * Create a progress reporter for the initial pull during clone
 */
function createProgressReporter(): SyncProgressReporter {
  let spinner: Ora | undefined;

  return {
    onFetchStart: () => {
      spinner = ora({
        text: 'Fetching pages from Confluence...',
        hideCursor: false,
        discardStdin: false,
      }).start();
    },
    onFetchComplete: (pageCount, folderCount) => {
      const folderText = folderCount > 0 ? ` and ${folderCount} folders` : '';
      spinner?.succeed(`Found ${pageCount} pages${folderText}`);
      spinner = undefined;
    },
    onDiffComplete: (added, modified, deleted) => {
      const total = added + modified + deleted;
      if (total === 0) {
        console.log(chalk.green('  Already up to date'));
      } else {
        const parts = [];
        if (added > 0) parts.push(chalk.green(`${added} new`));
        if (modified > 0) parts.push(chalk.yellow(`${modified} modified`));
        if (deleted > 0) parts.push(chalk.red(`${deleted} deleted`));
        console.log(`  ${parts.join(', ')}`);
        console.log('');
      }
    },
    onPageStart: (_index, _total, _title, _type) => {
      // No-op - we show progress on complete only
    },
    onPageComplete: (_index, _total, _title, localPath) => {
      const icon = localPath ? chalk.green('✓') : chalk.red('×');
      console.log(`  ${icon} ${localPath || 'deleted'}`);
    },
    onPageError: (title, error) => {
      console.log(`  ${chalk.red('✗')} ${title}: ${error}`);
    },
  };
}

export interface CloneCommandOptions {
  spaceKey: string;
  directory?: string;
}

/**
 * Clone command - clones a Confluence space to a new local directory
 */
export async function cloneCommand(options: CloneCommandOptions): Promise<void> {
  const configManager = new ConfigManager();
  const config = await configManager.getConfig();

  if (!config) {
    console.error(chalk.red('Not configured. Please run "cn setup" first.'));
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const syncEngine = new SyncEngine(config);

  // Determine target directory
  const targetDir = options.directory || options.spaceKey;
  const fullPath = resolve(process.cwd(), targetDir);

  // Check if directory already exists
  if (existsSync(fullPath)) {
    console.error(chalk.red(`Directory "${targetDir}" already exists.`));
    process.exit(EXIT_CODES.GENERAL_ERROR);
  }

  const spinner = ora({
    text: `Cloning space ${options.spaceKey} into ${targetDir}...`,
    hideCursor: false,
    discardStdin: false,
  }).start();

  try {
    // Create directory
    mkdirSync(fullPath, { recursive: true });

    // Initialize space config
    const spaceConfig = await syncEngine.initSync(fullPath, options.spaceKey);
    spinner.succeed(`Cloned space "${spaceConfig.spaceName}" (${spaceConfig.spaceKey}) into ${targetDir}`);

    // Perform initial pull
    console.log('');
    const progressReporter = createProgressReporter();
    const result = await syncEngine.sync(fullPath, {
      progress: progressReporter,
    });

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

    // Final summary
    const { added, modified, deleted } = result.changes;
    const total = added.length + modified.length + deleted.length;
    if (total > 0) {
      console.log('');
      const parts = [];
      if (added.length > 0) parts.push(`${added.length} added`);
      if (modified.length > 0) parts.push(`${modified.length} modified`);
      if (deleted.length > 0) parts.push(`${deleted.length} deleted`);
      console.log(chalk.green(`✓ Clone complete: ${parts.join(', ')}`));
    }

    console.log('');
    console.log(chalk.gray(`  cd ${targetDir}`));
  } catch (error) {
    spinner.fail('Failed to clone space');

    // Clean up directory on failure
    if (existsSync(fullPath)) {
      try {
        rmSync(fullPath, { recursive: true });
      } catch {
        // Ignore cleanup errors - directory may be partially created
      }
    }

    if (error instanceof Error && error.message.includes('not found')) {
      console.error(chalk.red(`\nSpace "${options.spaceKey}" not found.`));
      console.log(chalk.gray('Check the space key and try again.'));
      process.exit(EXIT_CODES.SPACE_NOT_FOUND);
    }

    console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
    process.exit(EXIT_CODES.GENERAL_ERROR);
  }
}
