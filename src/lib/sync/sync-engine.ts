import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  ConfluenceClient,
  isFolder,
  type ContentItem,
  type Folder,
  type Page,
  type PageTreeNode,
} from '../confluence-client/index.js';
import type { Config } from '../config.js';
import { SyncError } from '../errors.js';
import { MarkdownConverter, slugify } from '../markdown/index.js';
import {
  createSpaceConfig,
  readSpaceConfig,
  updateLastSync,
  updatePageSyncInfo,
  writeSpaceConfig,
  type PageSyncInfo,
  type SpaceConfigWithState,
} from '../space-config.js';
import { syncSpecificPages } from './sync-specific.js';

/**
 * Sync diff types
 */
export interface SyncChange {
  type: 'added' | 'modified' | 'deleted';
  pageId: string;
  title: string;
  localPath?: string;
}

export interface SyncDiff {
  added: SyncChange[];
  modified: SyncChange[];
  deleted: SyncChange[];
}

/**
 * Progress reporter for sync operations
 */
export interface SyncProgressReporter {
  onFetchStart?: () => void;
  onFetchComplete?: (pageCount: number, folderCount: number) => void;
  onDiffComplete?: (added: number, modified: number, deleted: number) => void;
  onPageStart?: (index: number, total: number, title: string, type: 'added' | 'modified' | 'deleted') => void;
  onPageComplete?: (index: number, total: number, title: string, localPath: string) => void;
  onPageError?: (title: string, error: string) => void;
}

export interface SyncOptions {
  dryRun?: boolean;
  force?: boolean;
  forcePages?: string[]; // Page IDs or local paths to force resync
  depth?: number;
  progress?: SyncProgressReporter;
  signal?: { cancelled: boolean };
}

export interface SyncResult {
  success: boolean;
  changes: SyncDiff;
  warnings: string[];
  errors: string[];
  cancelled?: boolean;
}

/**
 * Validate that a path stays within a base directory (prevents path traversal)
 * @throws SyncError if path escapes the base directory
 */
function assertPathWithinDirectory(baseDir: string, targetPath: string): void {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(baseDir, targetPath);
  if (!resolvedTarget.startsWith(`${resolvedBase}/`) && resolvedTarget !== resolvedBase) {
    throw new SyncError(`Path traversal detected: "${targetPath}" escapes base directory`);
  }
}

/**
 * SyncEngine handles syncing Confluence spaces to local directories
 * Per ADR-0007: One-way sync from Confluence to local only
 */
export class SyncEngine {
  private client: ConfluenceClient;
  private converter: MarkdownConverter;
  private baseUrl: string;

  constructor(config: Config) {
    this.client = new ConfluenceClient(config);
    this.converter = new MarkdownConverter();
    this.baseUrl = config.confluenceUrl;
  }

  /**
   * Initialize sync for a space in the given directory
   */
  async initSync(directory: string, spaceKey: string): Promise<SpaceConfigWithState> {
    // Get space info
    const space = await this.client.getSpaceByKey(spaceKey);

    // Create space config
    const config = createSpaceConfig(space.key, space.id, space.name);

    // Create directory if it doesn't exist
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }

    // Write config
    writeSpaceConfig(directory, config);

    return config;
  }

  /**
   * Fetch the full page tree for a space
   */
  async fetchPageTree(spaceId: string): Promise<Page[]> {
    return this.client.getAllPagesInSpace(spaceId);
  }

  /**
   * Build a tree structure from flat page list
   */
  buildPageTree(pages: Page[]): PageTreeNode[] {
    const pageMap = new Map<string, PageTreeNode>();
    const roots: PageTreeNode[] = [];

    // Create nodes for all pages
    for (const page of pages) {
      pageMap.set(page.id, { page, children: [] });
    }

    // Build tree structure
    for (const page of pages) {
      const node = pageMap.get(page.id);
      if (!node) continue;
      if (page.parentId && pageMap.has(page.parentId)) {
        pageMap.get(page.parentId)?.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  /**
   * Compute the diff between remote and local state
   * @param forcePageIds - Page IDs to force resync regardless of version
   */
  computeDiff(remotePages: Page[], localConfig: SpaceConfigWithState | null, forcePageIds?: Set<string>): SyncDiff {
    const diff: SyncDiff = {
      added: [],
      modified: [],
      deleted: [],
    };

    const localPages = localConfig?.pages || {};
    const remotePageIds = new Set(remotePages.map((p) => p.id));

    // Find added and modified pages
    for (const page of remotePages) {
      const localPage = localPages[page.id];
      const isForced = forcePageIds?.has(page.id);

      if (!localPage) {
        diff.added.push({
          type: 'added',
          pageId: page.id,
          title: page.title,
        });
      } else {
        const remoteVersion = page.version?.number || 0;
        // Include in modified if version changed OR if page is in forcePageIds
        if (remoteVersion > localPage.version || isForced) {
          diff.modified.push({
            type: 'modified',
            pageId: page.id,
            title: page.title,
            localPath: localPage.localPath,
          });
        }
      }
    }

    // Find deleted pages
    for (const [pageId, pageInfo] of Object.entries(localPages)) {
      if (!remotePageIds.has(pageId)) {
        diff.deleted.push({
          type: 'deleted',
          pageId,
          title: pageInfo.localPath.split('/').pop()?.replace('.md', '') || pageId,
          localPath: pageInfo.localPath,
        });
      }
    }

    return diff;
  }

  /**
   * Generate the local path for a page based on hierarchy
   * Per ADR-0005: Directory structure mirrors page tree
   * Per ADR-0018: Handles folders as parents in the hierarchy
   *
   * Space homepage (root page) becomes README.md at root, its children are at root level
   */
  private generateLocalPath(
    page: Page,
    pages: Page[],
    contentMap: Map<string, ContentItem>,
    existingPaths: Set<string>,
    homepageId?: string,
  ): string {
    // Space homepage becomes README.md at root
    if (page.id === homepageId) {
      const basePath = 'README.md';
      existingPaths.add(basePath);
      return basePath;
    }

    const parentChain: string[] = [];
    let currentId: string | undefined | null = page.parentId;

    // Build parent chain (can include both pages and folders)
    // Skip the homepage - its children should be at root level
    while (currentId && currentId !== homepageId) {
      const parent = contentMap.get(currentId);
      if (parent) {
        parentChain.unshift(slugify(parent.title));
        currentId = parent.parentId;
      } else {
        break;
      }
    }

    // Check if page has children (pages or folders can be parents)
    const hasChildren = pages.some((p) => p.parentId === page.id);
    const slug = slugify(page.title);

    let basePath: string;
    if (hasChildren) {
      // Pages with children use folder with README.md
      basePath = [...parentChain, slug, 'README.md'].join('/');
    } else {
      // Leaf pages are single .md files
      basePath = [...parentChain, `${slug}.md`].join('/');
    }

    // Handle conflicts by appending counter
    if (existingPaths.has(basePath)) {
      let counter = 2;
      const ext = hasChildren ? '/README.md' : '.md';
      const baseWithoutExt = hasChildren ? basePath.replace('/README.md', '') : basePath.replace('.md', '');

      while (existingPaths.has(`${baseWithoutExt}-${counter}${ext}`)) {
        counter++;
      }
      basePath = `${baseWithoutExt}-${counter}${ext}`;
    }

    existingPaths.add(basePath);
    return basePath;
  }

  /**
   * Sync a space to a local directory
   */
  async sync(directory: string, options: SyncOptions = {}): Promise<SyncResult> {
    // Fast path: if only specific pages requested (not full force), use optimized method
    if (options.forcePages && options.forcePages.length > 0 && !options.force) {
      return syncSpecificPages(this.client, this.converter, this.baseUrl, directory, options.forcePages, options);
    }

    const result: SyncResult = {
      success: true,
      changes: { added: [], modified: [], deleted: [] },
      warnings: [],
      errors: [],
      cancelled: false,
    };
    const progress = options.progress;
    const signal = options.signal;

    try {
      // Read existing config
      let config = readSpaceConfig(directory);
      if (!config) {
        throw new SyncError('No space configuration found. Run "cn sync --init <SPACE_KEY>" first.');
      }

      // Fetch all pages and folders (per ADR-0018)
      progress?.onFetchStart?.();
      const { pages: remotePages, folders } = await this.client.getAllContentInSpace(config.spaceId);
      progress?.onFetchComplete?.(remotePages.length, folders.length);

      // Build combined content map for parent lookup (includes both pages and folders)
      const contentMap = new Map<string, ContentItem>();
      for (const page of remotePages) {
        contentMap.set(page.id, page);
      }
      for (const folder of folders) {
        contentMap.set(folder.id, folder);
      }

      // Find the space homepage (root page with no parent)
      // Homepage content goes to README.md, its children are at root level
      const homepage = remotePages.find((p) => !p.parentId);
      const homepageId = homepage?.id;

      // For force sync, save old tracked pages for cleanup after successful download
      // This ensures we don't delete files until new content is confirmed
      const previouslyTrackedPages = options.force ? { ...config.pages } : {};
      if (options.force && !options.dryRun) {
        // Clear tracked pages so everything is treated as "added"
        config = { ...config, pages: {} };
        writeSpaceConfig(directory, config);
      }

      // Resolve forcePages to page IDs (can be page IDs or local paths)
      let forcePageIds: Set<string> | undefined;
      if (options.forcePages && options.forcePages.length > 0) {
        forcePageIds = new Set<string>();
        // Build reverse lookup from localPath to pageId
        const pathToPageId = new Map<string, string>();
        for (const [pageId, pageInfo] of Object.entries(config.pages)) {
          pathToPageId.set(pageInfo.localPath, pageId);
        }

        for (const pageRef of options.forcePages) {
          // Check if it's a page ID (exists in remote pages)
          if (remotePages.some((p) => p.id === pageRef)) {
            forcePageIds.add(pageRef);
          }
          // Check if it's a local path
          else {
            const pageId = pathToPageId.get(pageRef);
            if (pageId !== undefined) {
              forcePageIds.add(pageId);
            }
            // Try normalizing the path (remove leading ./)
            else {
              const normalizedPath = pageRef.replace(/^\.\//, '');
              const normalizedPageId = pathToPageId.get(normalizedPath);
              if (normalizedPageId !== undefined) {
                forcePageIds.add(normalizedPageId);
              } else {
                result.warnings.push(`Could not find page for: ${pageRef}`);
              }
            }
          }
        }
      }

      // Compute diff
      const diff = options.force
        ? {
            added: remotePages.map((p) => ({ type: 'added' as const, pageId: p.id, title: p.title })),
            modified: [],
            deleted: [],
          }
        : this.computeDiff(remotePages, config, forcePageIds);

      result.changes = diff;
      progress?.onDiffComplete?.(diff.added.length, diff.modified.length, diff.deleted.length);

      // If dry run, return without applying changes
      if (options.dryRun) {
        return result;
      }

      // Track existing paths for conflict resolution
      const existingPaths = new Set<string>();
      for (const pageInfo of Object.values(config.pages)) {
        existingPaths.add(pageInfo.localPath);
      }

      // Calculate total changes for progress
      const totalChanges = diff.added.length + diff.modified.length + diff.deleted.length;
      let currentChange = 0;

      // Process added pages
      for (const change of diff.added) {
        // Yield to event loop to allow signal handlers to run (Bun native)
        await Bun.sleep(0);

        // Check for cancellation signal
        if (signal?.cancelled) {
          result.cancelled = true;
          break;
        }
        currentChange++;
        progress?.onPageStart?.(currentChange, totalChanges, change.title, 'added');
        try {
          const page = remotePages.find((p) => p.id === change.pageId);
          if (!page) continue;

          // Get full page content
          const fullPage = await this.client.getPage(page.id, true);

          // Get labels
          const labels = await this.client.getAllLabels(page.id);

          // Get parent title (can be page or folder)
          const parentTitle = page.parentId ? contentMap.get(page.parentId)?.title : undefined;

          // Convert to markdown
          const { markdown, warnings } = this.converter.convertPage(
            fullPage,
            config.spaceKey,
            labels,
            parentTitle,
            this.baseUrl,
          );
          result.warnings.push(...warnings.map((w) => `${page.title}: ${w}`));

          // Generate local path
          const localPath = this.generateLocalPath(page, remotePages, contentMap, existingPaths, homepageId);
          (change as SyncChange).localPath = localPath;

          // Validate path stays within directory (prevents path traversal)
          assertPathWithinDirectory(directory, localPath);

          // Write file
          const fullPath = join(directory, localPath);
          mkdirSync(dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, markdown, 'utf-8');

          // Update sync state and save immediately (for resume support)
          const syncInfo: PageSyncInfo = {
            pageId: page.id,
            version: fullPage.version?.number || 1,
            lastModified: fullPage.version?.createdAt,
            localPath,
          };
          config = updatePageSyncInfo(config, syncInfo);
          writeSpaceConfig(directory, config);
          progress?.onPageComplete?.(currentChange, totalChanges, change.title, localPath);
        } catch (error) {
          const errorMsg = `Failed to sync page "${change.title}": ${error}`;
          result.errors.push(errorMsg);
          result.success = false;
          progress?.onPageError?.(change.title, String(error));
        }
      }

      // Process modified pages
      for (const change of diff.modified) {
        // Yield to event loop to allow signal handlers to run (Bun native)
        await Bun.sleep(0);

        // Check for cancellation signal
        if (signal?.cancelled) {
          result.cancelled = true;
          break;
        }
        currentChange++;
        progress?.onPageStart?.(currentChange, totalChanges, change.title, 'modified');
        try {
          const page = remotePages.find((p) => p.id === change.pageId);
          if (!page) continue;

          // Get full page content
          const fullPage = await this.client.getPage(page.id, true);

          // Get labels
          const labels = await this.client.getAllLabels(page.id);

          // Get parent title (can be page or folder)
          const parentTitle = page.parentId ? contentMap.get(page.parentId)?.title : undefined;

          // Convert to markdown
          const { markdown, warnings } = this.converter.convertPage(
            fullPage,
            config.spaceKey,
            labels,
            parentTitle,
            this.baseUrl,
          );
          result.warnings.push(...warnings.map((w) => `${page.title}: ${w}`));

          // Always generate path based on current title/hierarchy
          // This handles title changes by moving files to new locations
          const newPath = this.generateLocalPath(page, remotePages, contentMap, existingPaths, homepageId);
          const oldPath = change.localPath;

          // If path changed (title or parent changed), delete old file
          if (oldPath && oldPath !== newPath) {
            assertPathWithinDirectory(directory, oldPath);
            const oldFullPath = join(directory, oldPath);
            if (existsSync(oldFullPath)) {
              unlinkSync(oldFullPath);
              // Clean up empty parent directories
              let parentDir = dirname(oldFullPath);
              while (parentDir !== directory) {
                if (existsSync(parentDir) && readdirSync(parentDir).length === 0) {
                  rmSync(parentDir, { recursive: true });
                  parentDir = dirname(parentDir);
                } else {
                  break;
                }
              }
            }
          }

          // Validate new path stays within directory
          assertPathWithinDirectory(directory, newPath);

          // Write file at new location
          const fullPath = join(directory, newPath);
          mkdirSync(dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, markdown, 'utf-8');

          // Update sync state and save immediately (for resume support)
          const syncInfo: PageSyncInfo = {
            pageId: page.id,
            version: fullPage.version?.number || 1,
            lastModified: fullPage.version?.createdAt,
            localPath: newPath,
          };
          config = updatePageSyncInfo(config, syncInfo);
          writeSpaceConfig(directory, config);
          progress?.onPageComplete?.(currentChange, totalChanges, change.title, newPath);
        } catch (error) {
          const errorMsg = `Failed to update page "${change.title}": ${error}`;
          result.errors.push(errorMsg);
          result.success = false;
          progress?.onPageError?.(change.title, String(error));
        }
      }

      // Process deleted pages
      for (const change of diff.deleted) {
        // Yield to event loop to allow signal handlers to run (Bun native)
        await Bun.sleep(0);

        // Check for cancellation signal
        if (signal?.cancelled) {
          result.cancelled = true;
          break;
        }
        currentChange++;
        progress?.onPageStart?.(currentChange, totalChanges, change.title, 'deleted');
        try {
          if (change.localPath) {
            // Validate path stays within directory (prevents path traversal)
            assertPathWithinDirectory(directory, change.localPath);

            const fullPath = join(directory, change.localPath);
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

            // Remove from sync state and save immediately (for resume support)
            const { [change.pageId]: _, ...remainingPages } = config.pages;
            config = { ...config, pages: remainingPages };
            writeSpaceConfig(directory, config);
          }
          progress?.onPageComplete?.(currentChange, totalChanges, change.title, change.localPath || '');
        } catch (error) {
          const errorMsg = `Failed to delete page "${change.title}": ${error}`;
          result.errors.push(errorMsg);
          result.success = false;
          progress?.onPageError?.(change.title, String(error));
        }
      }

      // For force sync: clean up old files that weren't re-downloaded
      // This happens after all pages are successfully processed
      if (options.force && !result.cancelled && Object.keys(previouslyTrackedPages).length > 0) {
        const newTrackedPaths = new Set(Object.values(config.pages).map((p) => p.localPath));
        for (const [pageId, pageInfo] of Object.entries(previouslyTrackedPages)) {
          // Skip if this path was re-used by a new page
          if (newTrackedPaths.has(pageInfo.localPath)) continue;
          // Skip if page was re-downloaded (exists in new config)
          if (config.pages[pageId]) continue;

          try {
            assertPathWithinDirectory(directory, pageInfo.localPath);
            const fullPath = join(directory, pageInfo.localPath);
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
            result.warnings.push(`Failed to clean up old file ${pageInfo.localPath}: ${err}`);
          }
        }
      }

      // Update last sync time and save config
      config = updateLastSync(config);
      writeSpaceConfig(directory, config);
    } catch (error) {
      result.errors.push(`Sync failed: ${error}`);
      result.success = false;
    }

    return result;
  }
}
