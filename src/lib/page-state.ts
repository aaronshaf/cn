/**
 * Page state module - builds full page info from frontmatter
 * Per ADR-0024: Frontmatter is the source of truth for sync state
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { EXCLUDED_DIRS, RESERVED_FILENAMES } from './file-scanner.js';
import { parseMarkdown, type PageFrontmatter } from './markdown/index.js';

/**
 * Default version for pages without a version in frontmatter
 */
const DEFAULT_VERSION = 1;

/**
 * Full page information combining mapping and frontmatter data
 */
export interface FullPageInfo {
  pageId: string;
  localPath: string;
  title: string;
  version: number;
  updatedAt?: string;
  syncedAt?: string;
}

/**
 * Cache of all page information built from files
 */
export interface PageStateCache {
  pages: Map<string, FullPageInfo>;
  pathToPageId: Map<string, string>;
}

/**
 * Result of building page state, including any warnings
 */
export interface PageStateBuildResult extends PageStateCache {
  warnings: string[];
}

/**
 * Build full page state by scanning markdown files and reading frontmatter
 *
 * @param directory - Space root directory
 * @param pageMappings - Page mappings from .confluence.json (pageId -> localPath)
 * @returns PageStateBuildResult with all page info and any warnings
 */
export function buildPageStateFromFiles(directory: string, pageMappings: Record<string, string>): PageStateBuildResult {
  const pages = new Map<string, FullPageInfo>();
  const pathToPageId = new Map<string, string>();
  const warnings: string[] = [];

  // Read frontmatter from each mapped file
  // Only add to pathToPageId if page is successfully parsed
  const resolvedDirectory = resolve(directory);

  for (const [pageId, localPath] of Object.entries(pageMappings)) {
    const fullPath = resolve(directory, localPath);

    // Path traversal protection: ensure resolved path is within directory
    if (!fullPath.startsWith(resolvedDirectory)) {
      warnings.push(`Skipping path outside directory for page ${pageId}: ${localPath}`);
      continue;
    }

    if (!existsSync(fullPath)) {
      // File doesn't exist - skip (might have been deleted)
      warnings.push(`File not found for page ${pageId}: ${localPath}`);
      continue;
    }

    try {
      const content = readFileSync(fullPath, 'utf-8');
      const { frontmatter } = parseMarkdown(content);

      // Warn if frontmatter page_id doesn't match mapping key
      if (frontmatter.page_id && frontmatter.page_id !== pageId) {
        warnings.push(
          `Page ID mismatch for ${localPath}: mapping has "${pageId}", frontmatter has "${frontmatter.page_id}"`,
        );
      }

      const pageInfo: FullPageInfo = {
        pageId,
        localPath,
        title: frontmatter.title || '',
        version: frontmatter.version || DEFAULT_VERSION,
        updatedAt: frontmatter.updated_at,
        syncedAt: frontmatter.synced_at,
      };

      pages.set(pageId, pageInfo);
      pathToPageId.set(localPath, pageId);
    } catch (error) {
      // Failed to read/parse file - skip but warn
      const errorMsg = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to parse frontmatter for ${localPath}: ${errorMsg}`);
    }
  }

  return { pages, pathToPageId, warnings };
}

/**
 * Get page info for a single file by reading its frontmatter
 *
 * @param directory - Space root directory
 * @param localPath - Relative path to the file
 * @returns FullPageInfo or null if file doesn't exist or has no page_id
 */
export function getPageInfoByPath(directory: string, localPath: string): FullPageInfo | null {
  const fullPath = join(directory, localPath);

  if (!existsSync(fullPath)) {
    return null;
  }

  try {
    const content = readFileSync(fullPath, 'utf-8');
    const { frontmatter } = parseMarkdown(content);

    // Must have page_id to be a tracked page
    if (!frontmatter.page_id) {
      return null;
    }

    return {
      pageId: frontmatter.page_id,
      localPath,
      title: frontmatter.title || '',
      version: frontmatter.version || DEFAULT_VERSION,
      updatedAt: frontmatter.updated_at,
      syncedAt: frontmatter.synced_at,
    };
  } catch {
    return null;
  }
}

/**
 * Scan directory for all markdown files and build page state
 * This is used when we need full state but don't have mappings (e.g., initial scan)
 *
 * @param directory - Space root directory
 * @returns PageStateCache with all discovered pages
 */
export function scanDirectoryForPages(directory: string): PageStateCache {
  const pages = new Map<string, FullPageInfo>();
  const pathToPageId = new Map<string, string>();

  function scanDir(dir: string): void {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      // Skip hidden files/directories
      if (entry.startsWith('.')) {
        continue;
      }

      // Skip excluded directories
      if (EXCLUDED_DIRS.has(entry)) {
        continue;
      }

      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.endsWith('.md')) {
        // Skip reserved filenames (used by coding agents)
        if (RESERVED_FILENAMES.has(entry.toLowerCase())) {
          continue;
        }

        const localPath = relative(directory, fullPath);
        const pageInfo = getPageInfoByPath(directory, localPath);

        if (pageInfo) {
          pages.set(pageInfo.pageId, pageInfo);
          pathToPageId.set(localPath, pageInfo.pageId);
        }
      }
    }
  }

  scanDir(directory);

  return { pages, pathToPageId };
}
