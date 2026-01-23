/**
 * Health check utilities for detecting issues in synced spaces
 * Detects duplicate page_ids, orphaned files, stale files, etc.
 */

import { readFileSync, readdirSync, statSync, type Stats } from 'node:fs';
import { join, relative } from 'node:path';
import { EXCLUDED_DIRS, RESERVED_FILENAMES } from './file-scanner.js';
import { parseMarkdown, type PageFrontmatter } from './markdown/index.js';

/**
 * Information about a scanned markdown file
 */
export interface ScannedFile {
  path: string;
  pageId?: string;
  parentId?: string | null;
  version?: number;
  title?: string;
  syncedAt?: string;
  mtime: Date;
}

/**
 * Information about a duplicate page_id
 */
export interface DuplicatePageId {
  pageId: string;
  files: ScannedFile[];
}

/**
 * Result of a health check scan
 */
export interface HealthCheckResult {
  /** All scanned files with their metadata */
  files: ScannedFile[];
  /** Files with duplicate page_ids */
  duplicates: DuplicatePageId[];
  /** Files without page_id (new/untracked) */
  newFiles: ScannedFile[];
  /** Files with page_id (tracked) */
  trackedFiles: ScannedFile[];
}

/**
 * Scan a directory and collect file metadata for health checks
 */
export function scanFilesForHealthCheck(directory: string): ScannedFile[] {
  const files: ScannedFile[] = [];

  function scan(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      if (EXCLUDED_DIRS.has(entry)) continue;

      const fullPath = join(dir, entry);
      let stat: Stats;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        scan(fullPath);
      } else if (stat.isFile() && entry.endsWith('.md')) {
        if (RESERVED_FILENAMES.has(entry.toLowerCase())) continue;

        const relativePath = relative(directory, fullPath);
        let content: string;
        try {
          content = readFileSync(fullPath, 'utf-8');
        } catch {
          continue;
        }

        const { frontmatter } = parseMarkdown(content);

        files.push({
          path: relativePath,
          pageId: frontmatter.page_id,
          parentId: frontmatter.parent_id,
          version: frontmatter.version,
          title: frontmatter.title,
          syncedAt: frontmatter.synced_at,
          mtime: stat.mtime,
        });
      }
    }
  }

  scan(directory);
  return files;
}

/**
 * Find duplicate page_ids in scanned files
 */
export function findDuplicatePageIds(files: ScannedFile[]): DuplicatePageId[] {
  const pageIdToFiles = new Map<string, ScannedFile[]>();

  for (const file of files) {
    if (!file.pageId) continue;

    const existing = pageIdToFiles.get(file.pageId) || [];
    existing.push(file);
    pageIdToFiles.set(file.pageId, existing);
  }

  const duplicates: DuplicatePageId[] = [];
  for (const [pageId, fileList] of pageIdToFiles) {
    if (fileList.length > 1) {
      // Sort by syncedAt (newest first) to help identify the "correct" one
      fileList.sort((a, b) => {
        if (!a.syncedAt && !b.syncedAt) return 0;
        if (!a.syncedAt) return 1;
        if (!b.syncedAt) return -1;
        return new Date(b.syncedAt).getTime() - new Date(a.syncedAt).getTime();
      });

      duplicates.push({ pageId, files: fileList });
    }
  }

  return duplicates;
}

/**
 * Run a full health check on a directory
 */
export function runHealthCheck(directory: string): HealthCheckResult {
  const files = scanFilesForHealthCheck(directory);
  const duplicates = findDuplicatePageIds(files);
  const newFiles = files.filter((f) => !f.pageId);
  const trackedFiles = files.filter((f) => f.pageId);

  return {
    files,
    duplicates,
    newFiles,
    trackedFiles,
  };
}

/**
 * Find the "best" file for a duplicate (newest synced_at, highest version)
 * Returns the file that should be kept
 * @throws Error if files array is empty
 */
export function findBestDuplicate(files: ScannedFile[]): ScannedFile {
  if (files.length === 0) {
    throw new Error('findBestDuplicate called with empty array');
  }
  return files.reduce((best, current) => {
    // Prefer higher version
    if ((current.version || 0) > (best.version || 0)) return current;
    if ((current.version || 0) < (best.version || 0)) return best;

    // Same version, prefer newer syncedAt
    if (!best.syncedAt) return current;
    if (!current.syncedAt) return best;

    return new Date(current.syncedAt) > new Date(best.syncedAt) ? current : best;
  });
}

/**
 * Find stale duplicates (files that should be deleted)
 */
export function findStaleDuplicates(duplicate: DuplicatePageId): ScannedFile[] {
  const best = findBestDuplicate(duplicate.files);
  return duplicate.files.filter((f) => f.path !== best.path);
}

/**
 * Check if a specific file has duplicates
 */
export function checkFileForDuplicates(
  directory: string,
  filePath: string,
): { hasDuplicates: boolean; duplicates: ScannedFile[]; currentFile: ScannedFile | null } {
  const files = scanFilesForHealthCheck(directory);
  const currentFile = files.find((f) => f.path === filePath) || null;

  if (!currentFile?.pageId) {
    return { hasDuplicates: false, duplicates: [], currentFile };
  }

  const duplicates = files.filter((f) => f.pageId === currentFile.pageId && f.path !== filePath);

  return {
    hasDuplicates: duplicates.length > 0,
    duplicates,
    currentFile,
  };
}
