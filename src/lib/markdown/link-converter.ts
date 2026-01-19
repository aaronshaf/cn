import { dirname, relative, resolve } from 'node:path';
import type { PageSyncInfo, SpaceConfigWithState } from '../space-config.js';

/**
 * Decode common HTML entities in a string
 * Handles the most common entities: &amp; &lt; &gt; &quot; &#39;
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

/**
 * Page lookup map for link conversion
 */
export interface PageLookupMap {
  // Title -> PageSyncInfo mapping for quick lookup
  titleToPage: Map<string, PageSyncInfo>;
  // PageId -> PageSyncInfo mapping
  idToPage: Map<string, PageSyncInfo>;
  // LocalPath -> PageSyncInfo mapping for O(1) path lookups
  pathToPage: Map<string, PageSyncInfo>;
}

/**
 * Build a lookup map from sync state for efficient link conversion
 *
 * @param syncState - Space configuration with page sync state
 * @param warnDuplicates - If true, log warnings for duplicate titles
 * @returns Page lookup map with three indices for efficient lookups
 */
export function buildPageLookupMap(syncState: SpaceConfigWithState, warnDuplicates = false): PageLookupMap {
  const titleToPage = new Map<string, PageSyncInfo>();
  const idToPage = new Map<string, PageSyncInfo>();
  const pathToPage = new Map<string, PageSyncInfo>();

  for (const [pageId, pageInfo] of Object.entries(syncState.pages)) {
    idToPage.set(pageId, pageInfo);
    pathToPage.set(pageInfo.localPath, pageInfo);

    const title = pageInfo.title || '';

    // Skip entries without titles
    if (!title) {
      continue;
    }

    // Check for duplicate titles
    const existingPage = titleToPage.get(title);
    if (existingPage) {
      // Use deterministic ordering: prefer page with lexicographically smaller pageId
      // This ensures consistent behavior across runs
      const shouldReplace = pageId < existingPage.pageId;

      if (warnDuplicates) {
        console.warn(
          `Warning: Duplicate page title "${title}" found:\n` +
            `  - ${existingPage.localPath} (page ID: ${existingPage.pageId})\n` +
            `  - ${pageInfo.localPath} (page ID: ${pageId})\n` +
            `  Links to this title will point to ${shouldReplace ? pageInfo.localPath : existingPage.localPath}\n` +
            `  Recommendation: Rename one of these pages in Confluence to make titles unique.`,
        );
      }

      if (shouldReplace) {
        titleToPage.set(title, pageInfo);
      }
      // else: keep existing page
    } else {
      // First page with this title
      titleToPage.set(title, pageInfo);
    }
  }

  return { titleToPage, idToPage, pathToPage };
}

/**
 * Convert Confluence page link to relative markdown path
 *
 * @param targetTitle - Title from ri:content-title attribute
 * @param currentPagePath - Current page's local path (relative to space root)
 * @param lookupMap - Page lookup map for finding target pages
 * @returns Relative path to target page, or null if not found
 *
 * TODO: Add support for cross-space links by accepting optional targetSpaceKey parameter
 * and maintaining separate lookup maps per space. Cross-space links could use a format
 * like `../OTHER-SPACE/path/to/page.md` or a special prefix.
 */
export function confluenceLinkToRelativePath(
  targetTitle: string,
  currentPagePath: string,
  lookupMap: PageLookupMap,
): string | null {
  // Look up target page by title
  const targetPage = lookupMap.titleToPage.get(targetTitle);
  if (!targetPage) {
    return null;
  }

  // Get directory of current page
  const currentDir = dirname(currentPagePath);

  // Calculate relative path from current page to target page
  // Both paths are relative to space root, so we need to resolve them
  const relativePath = relative(currentDir, targetPage.localPath);

  // Ensure path starts with ./ for relative paths in same directory
  // or ../ for parent directories
  if (!relativePath.startsWith('.')) {
    return `./${relativePath}`;
  }

  return relativePath;
}

/**
 * Extract title from Confluence page link element
 * Handles both <ac:link><ri:page> and direct <ri:page> elements
 * Decodes HTML entities in the title
 *
 * @param html - HTML containing Confluence link
 * @returns Page title from ri:content-title attribute (decoded), or null
 */
export function extractPageTitleFromLink(html: string): string | null {
  // Match ri:content-title attribute in ri:page elements
  const match = html.match(/ri:content-title=["']([^"']+)["']/);
  return match ? decodeHtmlEntities(match[1]) : null;
}

/**
 * Convert relative markdown path to Confluence page link components
 *
 * @param relativePath - Relative path from markdown link (e.g., "./path/to/page.md")
 * @param currentPagePath - Current page's local path (relative to space root)
 * @param spaceRoot - Absolute path to space root directory
 * @param lookupMap - Page lookup map for finding target pages
 * @returns Object with title and pageId, or null if not found
 *
 * TODO: Add support for cross-space links by detecting paths like `../OTHER-SPACE/path.md`
 * and looking up pages in different space configs.
 */
export function relativePathToConfluenceLink(
  relativePath: string,
  currentPagePath: string,
  spaceRoot: string,
  lookupMap: PageLookupMap,
): { title: string; pageId: string } | null {
  // Resolve relative path to absolute path
  const currentDir = resolve(spaceRoot, dirname(currentPagePath));
  const targetAbsolutePath = resolve(currentDir, relativePath);

  // Convert back to path relative to space root
  const targetRelativePath = relative(spaceRoot, targetAbsolutePath);

  // O(1) lookup by path
  const pageInfo = lookupMap.pathToPage.get(targetRelativePath);
  if (pageInfo?.title) {
    return {
      title: pageInfo.title,
      pageId: pageInfo.pageId,
    };
  }

  // Page found but missing title, or page not found
  return null;
}
