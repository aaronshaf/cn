import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import {
  checkFileForDuplicates,
  findBestDuplicate,
  findDuplicatePageIds,
  scanFilesForHealthCheck,
  type DuplicatePageId,
} from '../../lib/health-check.js';

/**
 * Display duplicate page_id information
 */
export function displayDuplicates(duplicates: DuplicatePageId[]): void {
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
}

/**
 * Check for duplicate page_ids before push and prompt for confirmation
 * Returns true if push should continue, false if user cancelled
 */
export async function checkDuplicatesBeforePush(directory: string): Promise<boolean> {
  const allFiles = scanFilesForHealthCheck(directory);
  const duplicates = findDuplicatePageIds(allFiles);

  if (duplicates.length === 0) {
    return true;
  }

  displayDuplicates(duplicates);

  const shouldContinue = await confirm({
    message: 'Continue with push? (Stale files may cause version conflicts)',
    default: false,
  });

  if (!shouldContinue) {
    console.log(chalk.gray('Run "cn doctor" to fix duplicate page_ids.'));
    return false;
  }
  console.log('');
  return true;
}

/**
 * Display version conflict guidance, checking for duplicates that may explain the conflict
 * This is called when a version mismatch is detected during push
 */
export function displayVersionConflictGuidance(directory: string, relativePath: string, remoteVersion: number): void {
  const { hasDuplicates, duplicates } = checkFileForDuplicates(directory, relativePath);

  if (hasDuplicates) {
    const newerDuplicate = duplicates.find((d) => (d.version || 0) >= remoteVersion);
    if (newerDuplicate) {
      console.log(chalk.yellow('Found another file with the same page_id:'));
      console.log(chalk.yellow(`  ${newerDuplicate.path} (v${newerDuplicate.version || '?'})`));
      console.log('');
      console.log(chalk.gray('This usually happens when a page was moved on Confluence.'));
      console.log(chalk.gray(`The file at ${relativePath} appears to be stale.`));
      console.log('');
      console.log(chalk.gray('Recommended actions:'));
      console.log(chalk.gray(`  1. Delete the stale file: rm "${relativePath}"`));
      console.log(chalk.gray(`  2. Or run "cn doctor" to fix all duplicates`));
    } else {
      console.log(chalk.yellow('Found duplicate files with the same page_id:'));
      for (const dup of duplicates) {
        console.log(chalk.yellow(`  ${dup.path} (v${dup.version || '?'})`));
      }
      console.log('');
      console.log(chalk.gray('Run "cn doctor" to identify and fix duplicates.'));
    }
  } else {
    console.log(chalk.yellow('The page has been modified on Confluence since your last pull.'));
    console.log(chalk.gray('Options:'));
    console.log(chalk.gray(`  - Run "cn pull --page ${relativePath}" to get the latest version`));
    console.log(chalk.gray(`  - Run "cn push ${relativePath} --force" to overwrite remote changes`));
  }
}
