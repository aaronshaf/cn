import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import type { SyncProgressReporter } from '../../lib/sync/index.js';

/**
 * Create a progress reporter for sync operations (pull/clone)
 */
export function createProgressReporter(): SyncProgressReporter {
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
    onPageComplete: (index, total, _title, localPath) => {
      const icon = localPath ? chalk.green('✓') : chalk.red('×');
      const progress = chalk.gray(`(${index}/${total})`);
      console.log(`  ${icon} ${progress} ${localPath || 'deleted'}`);
    },
    onPageError: (title, error) => {
      console.log(`  ${chalk.red('✗')} ${title}: ${error}`);
    },
  };
}
