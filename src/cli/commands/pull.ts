import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../lib/config.js';
import { EXIT_CODES } from '../../lib/errors.js';
import { getFormatter } from '../../lib/formatters.js';
import {
  findBestDuplicate,
  findDuplicatePageIds,
  findStaleDuplicates,
  scanFilesForHealthCheck,
} from '../../lib/health-check.js';
import { readSpaceConfig, hasSpaceConfig } from '../../lib/space-config.js';
import { SyncEngine } from '../../lib/sync/index.js';
import { createProgressReporter } from '../utils/progress-reporter.js';

export interface PullCommandOptions {
  dryRun?: boolean;
  force?: boolean;
  depth?: number;
  pages?: string[]; // Page IDs or local paths to force resync
}

interface CleanupContext {
  sigintHandler: () => void;
  stdinHandler: (data: Buffer | string) => void;
  restoreRawMode: boolean | undefined;
}

/**
 * Clean up signal handlers and restore stdin state
 */
function cleanupHandlers(ctx: CleanupContext): void {
  process.off('SIGINT', ctx.sigintHandler);
  process.off('SIGTERM', ctx.sigintHandler);
  if (process.stdin.isTTY) {
    process.stdin.off('data', ctx.stdinHandler);
    process.stdin.pause();
  }
  if (ctx.restoreRawMode !== undefined && process.stdin.setRawMode) {
    try {
      process.stdin.setRawMode(ctx.restoreRawMode);
    } catch {
      // Ignore errors restoring raw mode
    }
  }
}

/**
 * Pull command - pulls a Confluence space to the local directory
 */
export async function pullCommand(options: PullCommandOptions): Promise<void> {
  const configManager = new ConfigManager();
  const config = await configManager.getConfig();

  if (!config) {
    console.error(chalk.red('Not configured. Please run "cn setup" first.'));
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const syncEngine = new SyncEngine(config);
  const directory = process.cwd();
  const formatter = getFormatter(false);

  // Check if space is configured
  if (!hasSpaceConfig(directory)) {
    console.error(chalk.red('No space configured in this directory.'));
    console.log(chalk.gray('Run "cn clone <SPACE_KEY>" to clone a space.'));
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  // Get space info for display
  const spaceConfig = readSpaceConfig(directory);
  if (spaceConfig) {
    console.log(chalk.bold(`Pulling space: ${spaceConfig.spaceName} (${spaceConfig.spaceKey})`));
  }

  // Check for duplicate page_ids before proceeding
  const allFiles = scanFilesForHealthCheck(directory);
  const duplicates = findDuplicatePageIds(allFiles);

  if (duplicates.length > 0) {
    console.log('');
    console.log(chalk.red('Duplicate page_ids detected:'));
    for (const dup of duplicates) {
      const best = findBestDuplicate(dup.files);
      console.log(chalk.yellow(`\n  page_id: ${dup.pageId}`));
      for (const file of dup.files) {
        const isBest = file.path === best.path;
        const marker = isBest ? chalk.green(' (keep)') : chalk.red(' (stale)');
        const version = file.version ? `v${file.version}` : 'v?';
        console.log(`    ${isBest ? chalk.green('*') : chalk.red('x')} ${file.path}${marker} - ${version}`);
      }
    }
    console.log('');

    // Offer to auto-fix
    const shouldFix = await confirm({
      message: 'Delete stale files before pulling?',
      default: true,
    });

    if (shouldFix) {
      for (const dup of duplicates) {
        const stale = findStaleDuplicates(dup);
        for (const file of stale) {
          try {
            unlinkSync(join(directory, file.path));
            console.log(chalk.green(`  Deleted: ${file.path}`));
          } catch (error) {
            console.log(
              chalk.red(`  Failed to delete ${file.path}: ${error instanceof Error ? error.message : 'Unknown error'}`),
            );
          }
        }
      }
      console.log('');
    }
  }

  // Cancellation signal - shared between handler and sync engine
  const signal = { cancelled: false };

  // Force raw mode to capture Ctrl+C as data when Bun doesn't deliver SIGINT.
  let restoreRawMode: boolean | undefined;
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    try {
      restoreRawMode = process.stdin.isRaw ?? false;
      process.stdin.setRawMode(true);
    } catch {
      restoreRawMode = undefined;
    }
  }

  // Handle Ctrl+C via SIGINT
  const sigintHandler = (): void => {
    if (signal.cancelled) return;
    signal.cancelled = true;
    console.log('');
    console.log(chalk.yellow('Cancelling pull...'));
  };
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigintHandler);

  // Fallback: Handle Ctrl+C as raw byte (0x03/ETX) when terminal is in raw mode
  // This catches Ctrl+C even when SIGINT isn't generated
  const stdinHandler = (data: Buffer | string): void => {
    const isCtrlC = typeof data === 'string' ? data.includes('\u0003') : data.includes(0x03);
    if (isCtrlC) {
      // ETX byte = Ctrl+C
      if (signal.cancelled) return;
      signal.cancelled = true;
      console.log('');
      console.log(chalk.yellow('Cancelling pull...'));
    }
  };
  if (process.stdin.isTTY) {
    process.stdin.on('data', stdinHandler);
    process.stdin.resume();
  }

  // Perform sync
  const progressReporter = options.dryRun ? undefined : createProgressReporter();

  try {
    const result = await syncEngine.sync(directory, {
      dryRun: options.dryRun,
      force: options.force,
      forcePages: options.pages,
      depth: options.depth,
      progress: progressReporter,
      signal,
    });

    // Clean up handlers
    cleanupHandlers({ sigintHandler, stdinHandler, restoreRawMode });

    // For dry run, show diff
    if (options.dryRun) {
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

    // Handle cancellation
    if (result.cancelled) {
      console.log('');
      console.log(chalk.yellow('Pull cancelled. Run "cn pull" again to resume.'));
      process.exit(130);
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
      console.error(chalk.red('Pull completed with errors.'));
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
        console.log(chalk.green(`✓ Pull complete: ${parts.join(', ')}`));
      }
    }
  } catch (error) {
    // Clean up handlers
    cleanupHandlers({ sigintHandler, stdinHandler, restoreRawMode });
    console.error(chalk.red('Pull failed'));
    console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
    process.exit(EXIT_CODES.GENERAL_ERROR);
  }
}
