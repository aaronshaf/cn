import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ConfluenceClient } from '../confluence-client/index.js';
import { SyncError } from '../errors.js';
import type { MarkdownConverter } from '../markdown/index.js';
import {
  readSpaceConfig,
  updateLastSync,
  updatePageSyncInfo,
  writeSpaceConfig,
  type PageSyncInfo,
  type SpaceConfigWithState,
} from '../space-config.js';
import type { SyncOptions, SyncResult } from './sync-engine.js';

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
    const pathToPageId = new Map<string, string>();
    for (const [pageId, pageInfo] of Object.entries(config.pages)) {
      pathToPageId.set(pageInfo.localPath, pageId);
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
    for (const pageId of pageIds) {
      const pageInfo = config.pages[pageId];
      if (pageInfo) {
        const title =
          pageInfo.localPath
            .split('/')
            .pop()
            ?.replace('.md', '')
            .replace(/readme$/i, '') || pageId;
        result.changes.modified.push({
          type: 'modified',
          pageId,
          title,
          localPath: pageInfo.localPath,
        });
      }
    }

    progress?.onDiffComplete?.(0, result.changes.modified.length, 0);

    if (options.dryRun) {
      return result;
    }

    // Process each page
    let currentChange = 0;
    const totalChanges = result.changes.modified.length;

    for (const change of result.changes.modified) {
      currentChange++;
      progress?.onPageStart?.(currentChange, totalChanges, change.title, 'modified');

      try {
        const fullPage = await client.getPage(change.pageId, true);
        const labels = await client.getAllLabels(change.pageId);

        let parentTitle: string | undefined;
        if (fullPage.parentId && config.pages[fullPage.parentId]) {
          parentTitle = config.pages[fullPage.parentId].localPath.split('/').pop()?.replace('.md', '');
        }

        const { markdown, warnings } = converter.convertPage(fullPage, config.spaceKey, labels, parentTitle, baseUrl);
        result.warnings.push(...warnings.map((w) => `${fullPage.title}: ${w}`));

        const localPath = change.localPath ?? '';
        assertPathWithinDirectory(directory, localPath);
        const fullPath = join(directory, localPath);
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, markdown, 'utf-8');

        const syncInfo: PageSyncInfo = {
          pageId: change.pageId,
          version: fullPage.version?.number || 1,
          lastModified: fullPage.version?.createdAt,
          localPath,
        };
        config = updatePageSyncInfo(config, syncInfo);
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
