import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { ConfluenceClient, User } from '../confluence-client/index.js';
import { SyncError } from '../errors.js';
import { RESERVED_FILENAMES } from '../file-scanner.js';
import { buildPageLookupMapFromCache, type MarkdownConverter } from '../markdown/index.js';
import { buildPageStateFromFiles } from '../page-state.js';
import {
  readSpaceConfig,
  updateLastSync,
  updatePageSyncInfo,
  writeSpaceConfig,
  type SpaceConfigWithState,
} from '../space-config.js';
import type { SyncOptions, SyncResult } from './sync-engine.js';

/**
 * Create a cached user fetcher to avoid redundant API calls
 */
function createUserFetcher(client: ConfluenceClient): (accountId: string | undefined) => Promise<User | undefined> {
  const cache = new Map<string, User | undefined>();
  return async (accountId: string | undefined): Promise<User | undefined> => {
    if (!accountId) return undefined;
    if (cache.has(accountId)) {
      return cache.get(accountId);
    }
    try {
      const user = await client.getUser(accountId);
      cache.set(accountId, user);
      return user;
    } catch {
      cache.set(accountId, undefined);
      return undefined;
    }
  };
}

/**
 * Validate that a path stays within a base directory (prevents path traversal)
 */
function assertPathWithinDirectory(baseDir: string, targetPath: string): void {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(baseDir, targetPath);
  if (!resolvedTarget.startsWith(`${resolvedBase}/`) && resolvedTarget !== resolvedBase) {
    throw new SyncError(`Path traversal detected: "${targetPath}" escapes base directory`);
  }
}

/**
 * Check if a path uses a reserved filename (used by coding agents)
 */
function isReservedPath(path: string): boolean {
  return RESERVED_FILENAMES.has(basename(path).toLowerCase());
}

/**
 * Fast path: resync specific pages without fetching the entire space
 */
export async function syncSpecificPages(
  client: ConfluenceClient,
  converter: MarkdownConverter,
  baseUrl: string,
  directory: string,
  pageRefs: string[],
  options: SyncOptions = {},
): Promise<SyncResult> {
  const result: SyncResult = {
    success: true,
    changes: { added: [], modified: [], deleted: [] },
    warnings: [],
    errors: [],
    cancelled: false,
  };
  const progress = options.progress;

  try {
    let config = readSpaceConfig(directory);
    if (!config) {
      throw new SyncError('No space configuration found.');
    }

    // Build reverse lookup from localPath to pageId
    // Per ADR-0024: config.pages is now Record<string, string> (pageId -> localPath)
    const pathToPageId = new Map<string, string>();
    for (const [pageId, localPath] of Object.entries(config.pages)) {
      pathToPageId.set(localPath, pageId);
    }

    // Resolve page references to IDs
    const pageIds: string[] = [];
    for (const pageRef of pageRefs) {
      const normalizedPath = pageRef.replace(/^\.\//, '');
      const normalizedId = pathToPageId.get(normalizedPath);
      const directId = pathToPageId.get(pageRef);

      if (normalizedId) {
        pageIds.push(normalizedId);
      } else if (directId) {
        pageIds.push(directId);
      } else if (config.pages[pageRef]) {
        pageIds.push(pageRef);
      } else {
        result.warnings.push(`Could not find page for: ${pageRef}`);
      }
    }

    if (pageIds.length === 0) {
      return result;
    }

    progress?.onFetchStart?.();
    progress?.onFetchComplete?.(pageIds.length, 0);

    // Build diff - all specified pages are "modified"
    // Per ADR-0024: config.pages[pageId] is now just the localPath string
    for (const pageId of pageIds) {
      const localPath = config.pages[pageId];
      if (localPath) {
        const title =
          localPath
            .split('/')
            .pop()
            ?.replace('.md', '')
            .replace(/readme$/i, '') || pageId;
        result.changes.modified.push({
          type: 'modified',
          pageId,
          title,
          localPath,
        });
      }
    }

    progress?.onDiffComplete?.(0, result.changes.modified.length, 0);

    if (options.dryRun) {
      return result;
    }

    // Create cached user fetcher
    const fetchUser = createUserFetcher(client);

    // Build page state and lookup map for link conversion (ADR-0022, ADR-0024)
    // Enable duplicate title warnings during sync
    const pageStateBuildResult = buildPageStateFromFiles(directory, config.pages);
    result.warnings.push(...pageStateBuildResult.warnings);
    const pageLookupMap = buildPageLookupMapFromCache(pageStateBuildResult, true);

    // Process each page
    let currentChange = 0;
    const totalChanges = result.changes.modified.length;

    for (const change of result.changes.modified) {
      currentChange++;
      progress?.onPageStart?.(currentChange, totalChanges, change.title, 'modified');

      // Skip reserved filenames (used by coding agents)
      if (change.localPath && isReservedPath(change.localPath)) {
        result.warnings.push(`Skipping page "${change.title}": reserved filename ${basename(change.localPath)}`);
        continue;
      }

      try {
        const fullPage = await client.getPage(change.pageId, true);
        const labels = await client.getAllLabels(change.pageId);

        // Per ADR-0024: config.pages[id] is just localPath, get parent title from path
        let parentTitle: string | undefined;
        const parentLocalPath = fullPage.parentId ? config.pages[fullPage.parentId] : undefined;
        if (parentLocalPath) {
          parentTitle = parentLocalPath.split('/').pop()?.replace('.md', '');
        }

        // Get author and last modifier user information (cached)
        const author = await fetchUser(fullPage.authorId);
        const lastModifier = await fetchUser(fullPage.version?.authorId);

        const localPath = change.localPath ?? '';

        // Convert to markdown with link conversion (ADR-0022)
        // Note: childCount is undefined for specific-page syncs (requires full sync to compute)
        const { markdown, warnings } = converter.convertPage(
          fullPage,
          labels,
          parentTitle,
          baseUrl,
          author,
          lastModifier,
          localPath,
          pageLookupMap,
          undefined, // childCount not available in specific-page sync
        );
        result.warnings.push(...warnings.map((w) => `${fullPage.title}: ${w}`));

        assertPathWithinDirectory(directory, localPath);
        const fullPath = join(directory, localPath);
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, markdown, 'utf-8');

        // Per ADR-0024: Only store pageId -> localPath mapping
        // Version, title, timestamps are in frontmatter
        config = updatePageSyncInfo(config, { pageId: change.pageId, localPath });
        writeSpaceConfig(directory, config);

        progress?.onPageComplete?.(currentChange, totalChanges, change.title, localPath);
      } catch (error) {
        result.errors.push(`Failed to sync page "${change.title}": ${error}`);
        result.success = false;
        progress?.onPageError?.(change.title, String(error));
      }
    }

    config = updateLastSync(config);
    writeSpaceConfig(directory, config);
  } catch (error) {
    result.errors.push(`Sync failed: ${error}`);
    result.success = false;
  }

  return result;
}
