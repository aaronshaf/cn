import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConfluenceClient, type Page, type PageTreeNode } from '../confluence-client/index.js';
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

export interface SyncOptions {
  dryRun?: boolean;
  force?: boolean;
  depth?: number;
}

export interface SyncResult {
  success: boolean;
  changes: SyncDiff;
  warnings: string[];
  errors: string[];
}

/**
 * Validate that a path stays within a base directory (prevents path traversal)
 * @throws SyncError if path escapes the base directory
 */
function assertPathWithinDirectory(baseDir: string, targetPath: string): void {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(baseDir, targetPath);
  if (!resolvedTarget.startsWith(resolvedBase + '/') && resolvedTarget !== resolvedBase) {
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
   */
  computeDiff(remotePages: Page[], localConfig: SpaceConfigWithState | null): SyncDiff {
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

      if (!localPage) {
        diff.added.push({
          type: 'added',
          pageId: page.id,
          title: page.title,
        });
      } else {
        const remoteVersion = page.version?.number || 0;
        if (remoteVersion > localPage.version) {
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
   */
  private generateLocalPath(page: Page, pages: Page[], existingPaths: Set<string>): string {
    const parentChain: string[] = [];
    let currentPage: Page | undefined = page;
    const pageMap = new Map(pages.map((p) => [p.id, p]));

    // Build parent chain
    while (currentPage?.parentId) {
      currentPage = pageMap.get(currentPage.parentId);
      if (currentPage) {
        parentChain.unshift(slugify(currentPage.title));
      }
    }

    // Check if page has children
    const hasChildren = pages.some((p) => p.parentId === page.id);
    const slug = slugify(page.title);

    let basePath: string;
    if (hasChildren) {
      // Pages with children use folder with index.md
      basePath = [...parentChain, slug, 'index.md'].join('/');
    } else {
      // Leaf pages are single .md files
      basePath = [...parentChain, `${slug}.md`].join('/');
    }

    // Handle conflicts by appending counter
    if (existingPaths.has(basePath)) {
      let counter = 2;
      const ext = hasChildren ? '/index.md' : '.md';
      const baseWithoutExt = hasChildren ? basePath.replace('/index.md', '') : basePath.replace('.md', '');

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
    const result: SyncResult = {
      success: true,
      changes: { added: [], modified: [], deleted: [] },
      warnings: [],
      errors: [],
    };

    try {
      // Read existing config
      let config = readSpaceConfig(directory);
      if (!config) {
        throw new SyncError('No space configuration found. Run "cn sync --init <SPACE_KEY>" first.');
      }

      // Fetch all pages
      const remotePages = await this.fetchPageTree(config.spaceId);

      // Build page map for parent lookup
      const pageMap = new Map(remotePages.map((p) => [p.id, p]));

      // Compute diff
      const diff = options.force
        ? {
            added: remotePages.map((p) => ({ type: 'added' as const, pageId: p.id, title: p.title })),
            modified: [],
            deleted: [],
          }
        : this.computeDiff(remotePages, config);

      result.changes = diff;

      // If dry run, return without applying changes
      if (options.dryRun) {
        return result;
      }

      // Track existing paths for conflict resolution
      const existingPaths = new Set<string>();
      for (const pageInfo of Object.values(config.pages)) {
        existingPaths.add(pageInfo.localPath);
      }

      // Process added pages
      for (const change of diff.added) {
        try {
          const page = remotePages.find((p) => p.id === change.pageId);
          if (!page) continue;

          // Get full page content
          const fullPage = await this.client.getPage(page.id, true);

          // Get labels
          const labels = await this.client.getAllLabels(page.id);

          // Get parent title
          const parentTitle = page.parentId ? pageMap.get(page.parentId)?.title : undefined;

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
          const localPath = this.generateLocalPath(page, remotePages, existingPaths);
          (change as SyncChange).localPath = localPath;

          // Validate path stays within directory (prevents path traversal)
          assertPathWithinDirectory(directory, localPath);

          // Write file
          const fullPath = join(directory, localPath);
          mkdirSync(dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, markdown, 'utf-8');

          // Update sync state
          const syncInfo: PageSyncInfo = {
            pageId: page.id,
            version: fullPage.version?.number || 1,
            lastModified: fullPage.version?.createdAt,
            localPath,
          };
          config = updatePageSyncInfo(config, syncInfo);
        } catch (error) {
          result.errors.push(`Failed to sync page "${change.title}": ${error}`);
          result.success = false;
        }
      }

      // Process modified pages
      for (const change of diff.modified) {
        try {
          const page = remotePages.find((p) => p.id === change.pageId);
          if (!page) continue;

          // Get full page content
          const fullPage = await this.client.getPage(page.id, true);

          // Get labels
          const labels = await this.client.getAllLabels(page.id);

          // Get parent title
          const parentTitle = page.parentId ? pageMap.get(page.parentId)?.title : undefined;

          // Convert to markdown
          const { markdown, warnings } = this.converter.convertPage(
            fullPage,
            config.spaceKey,
            labels,
            parentTitle,
            this.baseUrl,
          );
          result.warnings.push(...warnings.map((w) => `${page.title}: ${w}`));

          // Use existing path or generate new one
          const localPath = change.localPath || this.generateLocalPath(page, remotePages, existingPaths);

          // Validate path stays within directory (prevents path traversal)
          assertPathWithinDirectory(directory, localPath);

          // Write file
          const fullPath = join(directory, localPath);
          mkdirSync(dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, markdown, 'utf-8');

          // Update sync state
          const syncInfo: PageSyncInfo = {
            pageId: page.id,
            version: fullPage.version?.number || 1,
            lastModified: fullPage.version?.createdAt,
            localPath,
          };
          config = updatePageSyncInfo(config, syncInfo);
        } catch (error) {
          result.errors.push(`Failed to update page "${change.title}": ${error}`);
          result.success = false;
        }
      }

      // Process deleted pages
      for (const change of diff.deleted) {
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

            // Remove from sync state
            const { [change.pageId]: _, ...remainingPages } = config.pages;
            config = { ...config, pages: remainingPages };
          }
        } catch (error) {
          result.errors.push(`Failed to delete page "${change.title}": ${error}`);
          result.success = false;
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
