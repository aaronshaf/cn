import { readFileSync, readdirSync, statSync, type Stats } from 'node:fs';
import { join, relative } from 'node:path';
import { parseMarkdown } from './markdown/index.js';

/**
 * Directories to exclude from scanning
 */
export const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  'out',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
]);

/**
 * Reserved filenames that should not be synced (used by coding agents)
 * Checked case-insensitively
 */
export const RESERVED_FILENAMES = new Set(['claude.md', 'agents.md']);

/**
 * Scans a directory recursively for markdown files.
 * Excludes common build/dependency directories and hidden files.
 *
 * @param directory - Root directory to scan for markdown files
 * @returns Array of relative paths to markdown files, sorted alphabetically
 *
 * @example
 * ```typescript
 * const files = scanMarkdownFiles('/path/to/project');
 * // Returns: ['README.md', 'docs/guide.md', 'docs/api/endpoints.md']
 * ```
 */
export function scanMarkdownFiles(directory: string): string[] {
  const files: string[] = [];

  function scan(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      // Skip hidden files/directories (starting with .)
      if (entry.startsWith('.')) {
        continue;
      }

      // Skip excluded directories
      if (EXCLUDED_DIRS.has(entry)) {
        continue;
      }

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
        // Skip reserved filenames (used by coding agents)
        if (RESERVED_FILENAMES.has(entry.toLowerCase())) {
          continue;
        }
        // Return path relative to the root directory
        files.push(relative(directory, fullPath));
      }
    }
  }

  scan(directory);
  return files.sort();
}

/**
 * Represents a file that may need to be pushed
 */
export interface PushCandidate {
  /** Relative path from directory root */
  path: string;
  /** Whether this is a new file (no page_id) or modified existing file */
  type: 'new' | 'modified';
  /** Title from frontmatter or filename */
  title: string;
  /** Page ID if it exists */
  pageId?: string;
}

/**
 * Detects which markdown files need to be pushed to Confluence.
 *
 * @param directory - Root directory to scan for changed files
 * @returns Array of files that are new or modified since last sync
 *
 * Detection logic:
 * - **New files**: have no `page_id` in frontmatter
 * - **Modified files**: have `page_id` and file mtime > `synced_at` + 1 second
 *
 * The 1-second tolerance accounts for filesystem write timing during pull operations.
 * Files without `synced_at` but with `page_id` are treated as modified.
 *
 * @example
 * ```typescript
 * const candidates = detectPushCandidates('/path/to/project');
 * for (const candidate of candidates) {
 *   console.log(`${candidate.type}: ${candidate.path}`);
 * }
 * ```
 */
export function detectPushCandidates(directory: string): PushCandidate[] {
  const files = scanMarkdownFiles(directory);
  const candidates: PushCandidate[] = [];

  for (const relativePath of files) {
    const fullPath = join(directory, relativePath);

    let content: string;
    try {
      content = readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }

    const { frontmatter } = parseMarkdown(content);

    // Get file title from frontmatter or filename
    const filename = relativePath.split('/').pop()?.replace(/\.md$/, '') ?? relativePath.replace(/\.md$/, '');
    const title = (frontmatter.title as string) || filename;

    // New file - no page_id
    if (!frontmatter.page_id) {
      candidates.push({
        path: relativePath,
        type: 'new',
        title,
      });
      continue;
    }

    // Existing file - check if modified since last sync
    const syncedAt = frontmatter.synced_at as string | undefined;
    if (!syncedAt) {
      // No synced_at means it was never synced, treat as modified
      candidates.push({
        path: relativePath,
        type: 'modified',
        title,
        pageId: frontmatter.page_id as string,
      });
      continue;
    }

    // Compare file mtime to synced_at
    let stat: Stats;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    const syncedAtTime = new Date(syncedAt).getTime();
    const mtimeMs = stat.mtimeMs;

    // Add 1 second tolerance to account for filesystem write timing
    // during pull operations (file mtime is set slightly after synced_at)
    const TOLERANCE_MS = 1000;

    if (mtimeMs > syncedAtTime + TOLERANCE_MS) {
      candidates.push({
        path: relativePath,
        type: 'modified',
        title,
        pageId: frontmatter.page_id as string,
      });
    }
  }

  return candidates;
}
