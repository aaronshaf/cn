/**
 * cn doctor - Health check command for detecting issues in synced spaces
 */

import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  findBestDuplicate,
  findStaleDuplicates,
  runHealthCheck,
  type DuplicatePageId,
} from '../../lib/health-check.js';
import { hasSpaceConfig, readSpaceConfig } from '../../lib/space-config.js';

export interface DoctorOptions {
  fix?: boolean;
  xml?: boolean;
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return 'never';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Escape special XML characters for attribute values
 */
function escapeXmlAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function printDuplicateInfo(duplicate: DuplicatePageId): void {
  const best = findBestDuplicate(duplicate.files);
  const stale = findStaleDuplicates(duplicate);

  console.log(chalk.yellow(`\n  Duplicate page_id: ${duplicate.pageId}`));

  for (const file of duplicate.files) {
    const isBest = file.path === best.path;
    const marker = isBest ? chalk.green(' (keep)') : chalk.red(' (stale)');
    const version = file.version ? `v${file.version}` : 'v?';
    const synced = formatDate(file.syncedAt);

    console.log(`    ${isBest ? chalk.green('*') : chalk.red('x')} ${file.path}${marker}`);
    console.log(chalk.gray(`      ${version}, synced ${synced}`));
  }

  if (stale.length > 0) {
    console.log(chalk.gray(`    Recommendation: Delete ${stale.map((f) => f.path).join(', ')}`));
  }
}

function printXmlOutput(result: ReturnType<typeof runHealthCheck>): void {
  console.log('<health-check>');
  console.log(
    `  <summary files="${result.files.length}" tracked="${result.trackedFiles.length}" new="${result.newFiles.length}" duplicates="${result.duplicates.length}" />`,
  );

  if (result.duplicates.length > 0) {
    console.log('  <duplicates>');
    for (const dup of result.duplicates) {
      const best = findBestDuplicate(dup.files);
      console.log(`    <duplicate page-id="${escapeXmlAttr(dup.pageId)}">`);
      for (const file of dup.files) {
        const isBest = file.path === best.path;
        console.log(
          `      <file path="${escapeXmlAttr(file.path)}" version="${file.version || '?'}" synced="${file.syncedAt || 'never'}" status="${isBest ? 'keep' : 'stale'}" />`,
        );
      }
      console.log('    </duplicate>');
    }
    console.log('  </duplicates>');
  }

  console.log('</health-check>');
}

export async function doctorCommand(options: DoctorOptions = {}): Promise<void> {
  const directory = process.cwd();

  // Check for space config
  if (!hasSpaceConfig(directory)) {
    console.log(chalk.yellow('Not in a Confluence-synced directory.'));
    console.log(chalk.gray('Run "cn clone <SPACE_KEY>" to initialize a space.'));
    return;
  }

  const config = readSpaceConfig(directory);
  if (!config) {
    console.log(chalk.red('Failed to read space configuration.'));
    return;
  }

  console.log(chalk.bold(`Running health check for ${config.spaceName || config.spaceKey}...\n`));

  const result = runHealthCheck(directory);

  // XML output mode
  if (options.xml) {
    printXmlOutput(result);
    return;
  }

  // Summary
  console.log(chalk.bold('Summary:'));
  console.log(`  Total files: ${result.files.length}`);
  console.log(`  Tracked (with page_id): ${result.trackedFiles.length}`);
  console.log(`  New (no page_id): ${result.newFiles.length}`);

  // Check for issues
  let hasIssues = false;

  // Duplicate page_ids
  if (result.duplicates.length > 0) {
    hasIssues = true;
    console.log(chalk.red(`\n  Duplicate page_ids found: ${result.duplicates.length}`));

    for (const duplicate of result.duplicates) {
      printDuplicateInfo(duplicate);
    }
  }

  if (!hasIssues) {
    console.log(chalk.green('\n  No issues found.'));
    return;
  }

  // Offer to fix issues
  if (options.fix || result.duplicates.length > 0) {
    console.log('');

    for (const duplicate of result.duplicates) {
      const stale = findStaleDuplicates(duplicate);
      if (stale.length === 0) continue;

      for (const file of stale) {
        const shouldDelete =
          options.fix ||
          (await confirm({
            message: `Delete stale file ${file.path}?`,
            default: true,
          }));

        if (shouldDelete) {
          const fullPath = join(directory, file.path);
          try {
            unlinkSync(fullPath);
            console.log(chalk.green(`  Deleted: ${file.path}`));
          } catch (error) {
            console.log(
              chalk.red(`  Failed to delete ${file.path}: ${error instanceof Error ? error.message : 'Unknown error'}`),
            );
          }
        }
      }
    }
  }
}
