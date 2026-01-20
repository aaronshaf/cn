/**
 * File rename utilities for push operations
 */

import { existsSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import chalk from 'chalk';
import { slugify, updateReferencesAfterRename } from '../../lib/markdown/index.js';

// Index files that should not be renamed based on title (case-insensitive check)
const INDEX_FILES = new Set(['index.md', 'readme.md']);

/**
 * Result of file rename operation
 */
export interface RenameResult {
  finalPath: string;
  wasRenamed: boolean;
}

/**
 * Handle file renaming when title changes
 * Returns the final local path for updating sync state
 * Uses atomic operations: writes to temp file first, then renames
 * Also updates references in other markdown files when a rename occurs
 */
export function handleFileRename(
  filePath: string,
  originalRelativePath: string,
  expectedTitle: string,
  updatedMarkdown: string,
  spaceRoot?: string,
): RenameResult {
  const currentFilename = basename(filePath);
  const currentDir = dirname(filePath);
  const expectedSlug = slugify(expectedTitle);
  const expectedFilename = `${expectedSlug}.md`;
  let finalLocalPath = originalRelativePath.replace(/^\.\//, '');

  const isIndexFile = INDEX_FILES.has(currentFilename.toLowerCase());

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
      const oldRelativePath = finalLocalPath;
      finalLocalPath = relativeDir === '.' ? expectedFilename : join(relativeDir, expectedFilename);
      console.log(chalk.cyan(`  Renamed: ${currentFilename} → ${expectedFilename}`));

      // Update references in other markdown files that link to the old filename
      if (spaceRoot) {
        const updatedFiles = updateReferencesAfterRename(spaceRoot, oldRelativePath, finalLocalPath);
        if (updatedFiles.length > 0) {
          console.log(chalk.cyan(`  Updated ${updatedFiles.length} file(s) with new link path`));
        }
      }

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
