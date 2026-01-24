import { existsSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertPathWithinDirectory } from './folder-path.js';

/**
 * Clean up old files that weren't re-downloaded during force sync
 * Per ADR-0024: previouslyTrackedPages is Record<string, string> (pageId -> localPath)
 *
 * @param directory - Space directory
 * @param previouslyTrackedPages - Pages tracked before force sync
 * @param currentPages - Current page mappings after sync
 * @returns Array of warning messages for failed cleanups
 */
export function cleanupOldFiles(
  directory: string,
  previouslyTrackedPages: Record<string, string>,
  currentPages: Record<string, string>,
): string[] {
  const warnings: string[] = [];
  const newTrackedPaths = new Set(Object.values(currentPages));

  for (const [pageId, localPath] of Object.entries(previouslyTrackedPages)) {
    // Skip if this path was re-used by a new page
    if (newTrackedPaths.has(localPath)) continue;
    // Skip if page was re-downloaded (exists in new config)
    if (currentPages[pageId]) continue;

    try {
      assertPathWithinDirectory(directory, localPath);
      const fullPath = join(directory, localPath);
      if (existsSync(fullPath)) {
        unlinkSync(fullPath);
        // Clean up empty parent directories
        let parentDir = dirname(fullPath);
        while (parentDir !== directory) {
          if (existsSync(parentDir) && readdirSync(parentDir).length === 0) {
            rmSync(parentDir, { recursive: true });
            parentDir = dirname(parentDir);
          } else {
            break;
          }
        }
      }
    } catch (err) {
      warnings.push(`Failed to clean up old file ${localPath}: ${err}`);
    }
  }

  return warnings;
}
