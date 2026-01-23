import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ConfluenceClient,
  type ContentItem,
  type Page,
  type PageTreeNode,
  type User,
} from '../confluence-client/index.js';
import type { Config } from '../config.js';
import { SyncError } from '../errors.js';
import {
  buildPageLookupMapFromCache,
  MarkdownConverter,
  slugify,
  updateReferencesAfterRename,
} from '../markdown/index.js';
import { buildPageStateFromFiles, type PageStateCache } from '../page-state.js';
import {
  createSpaceConfig,
  readSpaceConfig,
  updateFolderSyncInfo,
  updateLastSync,
  updatePageSyncInfo,
  writeSpaceConfig,
  type FolderSyncInfo,
  type SpaceConfigWithState,
} from '../space-config.js';
import { assertPathWithinDirectory, generateFolderPath, wouldGenerateReservedFilename } from './folder-path.js';
import { syncSpecificPages } from './sync-specific.js';
import type { SyncChange, SyncDiff, SyncOptions, SyncResult } from './types.js';

export type { SyncChange, SyncDiff, SyncOptions, SyncProgressReporter, SyncResult } from './types.js';

/**
 * SyncEngine handles syncing Confluence spaces to local directories
 * Per ADR-0007: One-way sync from Confluence to local only
 */
export class SyncEngine {
  private client: ConfluenceClient;
  private converter: MarkdownConverter;
  private baseUrl: string;
  private userCache = new Map<string, User | undefined>();

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
   * Per ADR-0024: Uses PageStateCache for version comparison (frontmatter as source of truth)
   * @param remotePages - Pages from Confluence API
   * @param localConfig - Local space configuration with page mappings
   * @param pageState - Optional PageStateCache with version info from frontmatter
   * @param forcePageIds - Page IDs to force resync regardless of version
   */
  computeDiff(
    remotePages: Page[],
    localConfig: SpaceConfigWithState | null,
    pageState?: PageStateCache,
    forcePageIds?: Set<string>,
  ): SyncDiff {
    // Filter out archived pages - they should be treated as deleted locally
    const currentPages = remotePages.filter((page) => page.status === 'current');

    const diff: SyncDiff = {
      added: [],
      modified: [],
      deleted: [],
    };

    const localPageMappings = localConfig?.pages || {};
    const remotePageIds = new Set(currentPages.map((p) => p.id));

    // Find added and modified pages
    for (const page of currentPages) {
      const localPath = localPageMappings[page.id];
      const isForced = forcePageIds?.has(page.id);

      if (!localPath) {
        diff.added.push({
          type: 'added',
          pageId: page.id,
          title: page.title,
        });
      } else {
        const remoteVersion = page.version?.number || 0;
        // Get local version from PageStateCache (read from frontmatter)
        const localPageInfo = pageState?.pages.get(page.id);
        const localVersion = localPageInfo?.version || 0;

        // Include in modified if version changed OR if page is in forcePageIds
        if (remoteVersion > localVersion || isForced) {
          diff.modified.push({
            type: 'modified',
            pageId: page.id,
            title: page.title,
            localPath,
          });
        }
      }
    }

    // Find deleted pages
    for (const [pageId, localPath] of Object.entries(localPageMappings)) {
      if (!remotePageIds.has(pageId)) {
        diff.deleted.push({
          type: 'deleted',
          pageId,
          title: localPath.split('/').pop()?.replace('.md', '') || pageId,
          localPath,
        });
      }
    }

    return diff;
  }

  /**
   * Safely fetch user information by account ID with caching
   * Returns undefined if user cannot be fetched (e.g., user deleted, permissions, etc.)
   */
  private async fetchUser(accountId: string | undefined): Promise<User | undefined> {
    if (!accountId) return undefined;
    if (this.userCache.has(accountId)) {
      return this.userCache.get(accountId);
    }
    try {
      const user = await this.client.getUser(accountId);
      this.userCache.set(accountId, user);
      return user;
    } catch {
      // Silently fail if user cannot be fetched, but cache the failure
      this.userCache.set(accountId, undefined);
      return undefined;
    }
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

      // Track discovered folders in config (ADR-0023)
      // This enables push to reuse folder IDs for the same paths
      for (const folder of folders) {
        const folderPath = generateFolderPath(folder, contentMap);
        const folderInfo: FolderSyncInfo = {
          folderId: folder.id,
          title: folder.title,
          parentId: folder.parentId ?? undefined,
          localPath: folderPath,
        };
        config = updateFolderSyncInfo(config, folderInfo);
      }
      // Save folder tracking immediately
      if (folders.length > 0 && !options.dryRun) {
        writeSpaceConfig(directory, config);
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

      // Build PageStateCache for version comparison (ADR-0024)
      // This reads frontmatter from all tracked files
      const pageStateBuildResult = buildPageStateFromFiles(directory, config.pages);
      const pageState = pageStateBuildResult;
      // Add warnings from page state building (e.g., missing or malformed files)
      result.warnings.push(...pageStateBuildResult.warnings);

      // Resolve forcePages to page IDs (can be page IDs or local paths)
      let forcePageIds: Set<string> | undefined;
      if (options.forcePages && options.forcePages.length > 0) {
        forcePageIds = new Set<string>();
        // Build reverse lookup from localPath to pageId (pages is now Record<string, string>)
        const pathToPageId = new Map<string, string>();
        for (const [pageId, localPath] of Object.entries(config.pages)) {
          pathToPageId.set(localPath, pageId);
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

      // Compute diff (pass pageState for version comparison from frontmatter)
      const diff = options.force
        ? {
            added: remotePages.map((p) => ({ type: 'added' as const, pageId: p.id, title: p.title })),
            modified: [],
            deleted: [],
          }
        : this.computeDiff(remotePages, config, pageState, forcePageIds);

      result.changes = diff;
      progress?.onDiffComplete?.(diff.added.length, diff.modified.length, diff.deleted.length);

      // If dry run, return without applying changes
      if (options.dryRun) {
        return result;
      }

      // Track existing paths for conflict resolution (pages is now Record<string, string>)
      const existingPaths = new Set<string>();
      for (const localPath of Object.values(config.pages)) {
        existingPaths.add(localPath);
      }

      // Build page lookup map for link conversion (ADR-0022)
      // Reuse the already-built pageState to avoid duplicate file I/O
      // Enable duplicate title warnings during sync
      const pageLookupMap = buildPageLookupMapFromCache(pageState, true);

      // Pre-compute child counts for all pages (O(n) instead of O(n^2))
      const childCountMap = new Map<string, number>();
      for (const p of remotePages) {
        if (p.parentId) {
          childCountMap.set(p.parentId, (childCountMap.get(p.parentId) || 0) + 1);
        }
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

          // Skip reserved filenames BEFORE generating path (avoids polluting existingPaths)
          // Check early to avoid unnecessary API calls
          if (wouldGenerateReservedFilename(page.title)) {
            result.warnings.push(`Skipping page "${page.title}": would generate reserved filename`);
            continue;
          }

          // Get full page content
          const fullPage = await this.client.getPage(page.id, true);

          // Get labels
          const labels = await this.client.getAllLabels(page.id);

          // Get parent title (can be page or folder)
          const parentTitle = page.parentId ? contentMap.get(page.parentId)?.title : undefined;

          // Get author and last modifier user information
          const author = await this.fetchUser(fullPage.authorId);
          const lastModifier = await this.fetchUser(fullPage.version?.authorId);

          // Generate local path first (needed for link conversion)
          const localPath = this.generateLocalPath(page, remotePages, contentMap, existingPaths, homepageId);
          (change as SyncChange).localPath = localPath;

          // Get child count from pre-computed map (defaults to 0 if no children)
          const childCount = childCountMap.get(page.id) ?? 0;

          // Convert to markdown with link conversion (ADR-0022)
          const { markdown, warnings } = this.converter.convertPage(
            fullPage,
            labels,
            parentTitle,
            this.baseUrl,
            author,
            lastModifier,
            localPath,
            pageLookupMap,
            childCount,
          );
          result.warnings.push(...warnings.map((w) => `${page.title}: ${w}`));

          // Validate path stays within directory (prevents path traversal)
          assertPathWithinDirectory(directory, localPath);

          // Write file
          const fullPath = join(directory, localPath);
          mkdirSync(dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, markdown, 'utf-8');

          // Update sync state and save immediately (for resume support)
          // Per ADR-0024: Only store pageId -> localPath mapping
          // Version, title, timestamps are in frontmatter
          config = updatePageSyncInfo(config, { pageId: page.id, localPath });
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

          // Skip reserved filenames BEFORE generating path (avoids polluting existingPaths)
          // Check early to avoid unnecessary API calls
          if (wouldGenerateReservedFilename(page.title)) {
            result.warnings.push(`Skipping page "${page.title}": would generate reserved filename`);
            continue;
          }

          // Get full page content
          const fullPage = await this.client.getPage(page.id, true);

          // Get labels
          const labels = await this.client.getAllLabels(page.id);

          // Get parent title (can be page or folder)
          const parentTitle = page.parentId ? contentMap.get(page.parentId)?.title : undefined;

          // Get author and last modifier user information
          const author = await this.fetchUser(fullPage.authorId);
          const lastModifier = await this.fetchUser(fullPage.version?.authorId);

          // Always generate path based on current title/hierarchy
          // This handles title changes by moving files to new locations
          const newPath = this.generateLocalPath(page, remotePages, contentMap, existingPaths, homepageId);
          const oldPath = change.localPath;

          // Get child count from pre-computed map (defaults to 0 if no children)
          const childCount = childCountMap.get(page.id) ?? 0;

          // Convert to markdown with link conversion (ADR-0022)
          // Use newPath for link conversion since that's where the file will be
          const { markdown, warnings } = this.converter.convertPage(
            fullPage,
            labels,
            parentTitle,
            this.baseUrl,
            author,
            lastModifier,
            newPath,
            pageLookupMap,
            childCount,
          );
          result.warnings.push(...warnings.map((w) => `${page.title}: ${w}`));

          // If path changed (title or parent changed), update references and delete old file
          if (oldPath && oldPath !== newPath) {
            assertPathWithinDirectory(directory, oldPath);
            const oldFullPath = join(directory, oldPath);
            if (existsSync(oldFullPath)) {
              // Update references in other files (ADR-0022)
              const referenceUpdates = updateReferencesAfterRename(directory, oldPath, newPath);
              if (referenceUpdates.length > 0) {
                const details = referenceUpdates
                  .map((u) => `${u.filePath} (${u.updatedCount} ref${u.updatedCount !== 1 ? 's' : ''})`)
                  .join(', ');
                result.warnings.push(`Updated references to renamed page "${page.title}":\n  ${details}`);
              }

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
          // Per ADR-0024: Only store pageId -> localPath mapping
          // Version, title, timestamps are in frontmatter
          config = updatePageSyncInfo(config, { pageId: page.id, localPath: newPath });
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
      // Per ADR-0024: previouslyTrackedPages is Record<string, string> (pageId -> localPath)
      if (options.force && !result.cancelled && Object.keys(previouslyTrackedPages).length > 0) {
        const newTrackedPaths = new Set(Object.values(config.pages));
        for (const [pageId, localPath] of Object.entries(previouslyTrackedPages)) {
          // Skip if this path was re-used by a new page
          if (newTrackedPaths.has(localPath)) continue;
          // Skip if page was re-downloaded (exists in new config)
          if (config.pages[pageId]) continue;

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
            result.warnings.push(`Failed to clean up old file ${localPath}: ${err}`);
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
