import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPageLookupMapFromCache, confluenceLinkToRelativePath } from '../markdown/link-converter.js';
import { buildPageStateFromFiles, type PageStateCache } from '../page-state.js';
import type { SpaceConfigWithState } from '../space-config.js';

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
 * Result of second pass link resolution
 */
export interface LinkResolutionResult {
  filesUpdated: number;
  linksResolved: number;
  warnings: string[];
}

/**
 * Extract unresolved Confluence links from markdown content
 * These are links that couldn't be resolved in the first pass and remain as:
 * - Raw HTML: <ac:link><ri:page ri:content-title="..."/></ac:link>
 * - Confluence URLs: [text](https://site.atlassian.net/wiki/...)
 *
 * @param content - Markdown content to scan
 * @returns Array of {title, fullMatch} for each unresolved link
 */
function extractUnresolvedLinks(content: string): Array<{ title: string; fullMatch: string; linkText: string }> {
  const unresolvedLinks: Array<{ title: string; fullMatch: string; linkText: string }> = [];

  // Match <ac:link> elements with ri:page
  // Pattern: <ac:link>...<ri:page ri:content-title="Title" .../>...</ac:link>
  const acLinkPattern =
    /<ac:link>\s*<ri:page[^>]*ri:content-title=["']([^"']+)["'][^>]*\/>\s*(?:<ac:plain-text-link-body><!\[CDATA\[([^\]]*)\]\]><\/ac:plain-text-link-body>)?\s*<\/ac:link>/g;

  let match: RegExpExecArray | null;
  while ((match = acLinkPattern.exec(content)) !== null) {
    // Decode HTML entities in title (e.g., "Page &amp; Info" -> "Page & Info")
    const decodedTitle = decodeHtmlEntities(match[1]);
    const decodedLinkText = match[2] ? decodeHtmlEntities(match[2]) : decodedTitle;

    unresolvedLinks.push({
      title: decodedTitle,
      fullMatch: match[0],
      linkText: decodedLinkText,
    });
  }

  return unresolvedLinks;
}

/**
 * Perform second pass link resolution on all markdown files
 *
 * After the initial pull, some links couldn't be resolved because their target pages
 * hadn't been pulled yet. This function rebuilds the page lookup map and resolves
 * those links.
 *
 * Per ADR-0022: Converts Confluence page links to relative markdown paths
 *
 * @param directory - Space directory containing markdown files
 * @param config - Space configuration with page mappings
 * @returns Result with count of files and links updated
 */
export function resolveLinksSecondPass(directory: string, config: SpaceConfigWithState): LinkResolutionResult {
  const result: LinkResolutionResult = {
    filesUpdated: 0,
    linksResolved: 0,
    warnings: [],
  };

  // Rebuild page state cache from all files
  const pageStateBuildResult = buildPageStateFromFiles(directory, config.pages);
  const pageState: PageStateCache = pageStateBuildResult;
  result.warnings.push(...pageStateBuildResult.warnings);

  // Rebuild page lookup map with complete set of pages
  const pageLookupMap = buildPageLookupMapFromCache(pageState, false);

  // Scan all tracked pages for unresolved links
  for (const [_pageId, localPath] of Object.entries(config.pages)) {
    const fullPath = join(directory, localPath);

    let content: string;
    try {
      content = readFileSync(fullPath, 'utf-8');
    } catch (error) {
      result.warnings.push(`Could not read ${localPath}: ${error}`);
      continue;
    }

    // Find unresolved links in this file
    const unresolvedLinks = extractUnresolvedLinks(content);
    if (unresolvedLinks.length === 0) {
      continue; // No unresolved links, skip this file
    }

    // Try to resolve each link
    let updatedContent = content;
    let linksResolvedInFile = 0;

    for (const link of unresolvedLinks) {
      // Try to convert to relative path
      const relativePath = confluenceLinkToRelativePath(link.title, localPath, pageLookupMap);

      if (relativePath) {
        // Replace the unresolved link with markdown link
        const markdownLink = `[${link.linkText}](${relativePath})`;
        updatedContent = updatedContent.replace(link.fullMatch, markdownLink);
        linksResolvedInFile++;
      }
      // If still can't resolve, leave it as-is (page might be in different space or deleted)
    }

    // Write updated content if any links were resolved
    if (linksResolvedInFile > 0) {
      try {
        writeFileSync(fullPath, updatedContent, 'utf-8');
        result.filesUpdated++;
        result.linksResolved += linksResolvedInFile;
      } catch (error) {
        result.warnings.push(`Failed to update ${localPath}: ${error}`);
      }
    }
  }

  return result;
}
