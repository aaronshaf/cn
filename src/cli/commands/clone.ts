import chalk from 'chalk';
import ora from 'ora';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigManager, type Config } from '../../lib/config.js';
import { EXIT_CODES } from '../../lib/errors.js';
import { SyncEngine } from '../../lib/sync/index.js';
import { createProgressReporter } from '../utils/progress-reporter.js';

const SEPARATOR = '='.repeat(60);

export interface CloneCommandOptions {
  spaceKeys: string[];
}

/**
 * Clone command - clones one or more Confluence spaces to new local directories
 */
export async function cloneCommand(options: CloneCommandOptions): Promise<void> {
  const configManager = new ConfigManager();
  const config = await configManager.getConfig();

  if (!config) {
    console.error(chalk.red('Not configured. Please run "cn setup" first.'));
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  // Check for duplicate space keys
  const uniqueKeys = new Set(options.spaceKeys);
  if (uniqueKeys.size !== options.spaceKeys.length) {
    const duplicates = options.spaceKeys.filter((key, index) => options.spaceKeys.indexOf(key) !== index);
    console.error(chalk.red('Duplicate space keys detected.'));
    console.log(chalk.gray(`Duplicates: ${[...new Set(duplicates)].join(', ')}`));
    process.exit(EXIT_CODES.INVALID_ARGUMENTS);
  }

  const results: Array<{ spaceKey: string; status: 'success' | 'error'; error?: string }> = [];

  // Clone each space sequentially
  for (let i = 0; i < options.spaceKeys.length; i++) {
    const spaceKey = options.spaceKeys[i];
    const isMultiSpace = options.spaceKeys.length > 1;

    if (isMultiSpace) {
      console.log(chalk.blue(`\n${SEPARATOR}`));
      console.log(chalk.blue(`Cloning ${i + 1}/${options.spaceKeys.length}: ${chalk.bold(spaceKey)}`));
      console.log(chalk.blue(SEPARATOR));
    }

    try {
      await cloneSingleSpace({ spaceKey, directory: spaceKey }, config);
      results.push({ spaceKey, status: 'success' });
    } catch (error) {
      results.push({
        spaceKey,
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Check for failures
  const successes = results.filter((r) => r.status === 'success');
  const failures = results.filter((r) => r.status === 'error');

  // Display summary if multiple spaces were cloned
  if (options.spaceKeys.length > 1) {
    console.log(chalk.blue(`\n${SEPARATOR}`));
    console.log(chalk.bold('Clone Summary'));
    console.log(chalk.blue(SEPARATOR));

    if (successes.length > 0) {
      console.log(chalk.green(`✓ Successfully cloned: ${successes.map((r) => r.spaceKey).join(', ')}`));
    }

    if (failures.length > 0) {
      console.log(chalk.red(`✗ Failed to clone: ${failures.map((r) => r.spaceKey).join(', ')}`));
      for (const failure of failures) {
        console.log(chalk.red(`  ${failure.spaceKey}: ${failure.error}`));
      }
    }
  }

  // Exit with error if any failures occurred
  if (failures.length > 0) {
    process.exit(EXIT_CODES.GENERAL_ERROR);
  }
}

/**
 * Clone a single space - extracted from original cloneCommand
 */
async function cloneSingleSpace(options: { spaceKey: string; directory?: string }, config: Config): Promise<void> {
  const syncEngine = new SyncEngine(config);

  // Determine target directory
  const targetDir = options.directory || options.spaceKey;
  const fullPath = resolve(process.cwd(), targetDir);

  // Check if directory already exists
  if (existsSync(fullPath)) {
    throw new Error(`Directory "${targetDir}" already exists.`);
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

    // Perform initial pull - wrapped separately so init failures clean up but sync failures don't
    let syncFailed = false;
    try {
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
        syncFailed = true;
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
    } catch (_syncError) {
      // Sync failed but clone succeeded - don't clean up, provide recovery guidance
      console.log('');
      console.log(chalk.yellow('Initial pull failed. You can retry with:'));
      syncFailed = true;
    }

    console.log('');
    console.log(chalk.gray(`  cd ${targetDir}`));
    if (syncFailed) {
      console.log(chalk.gray('  cn pull'));
    }
  } catch (error) {
    spinner.fail('Failed to clone space');

    // Clean up directory on failure (only for init failures, not sync failures)
    if (existsSync(fullPath)) {
      try {
        rmSync(fullPath, { recursive: true });
      } catch {
        // Ignore cleanup errors - directory may be partially created
      }
    }

    if (error instanceof Error && error.message.includes('not found')) {
      throw new Error(`Space "${options.spaceKey}" not found. Check the space key and try again.`);
    }

    throw error;
  }
}
