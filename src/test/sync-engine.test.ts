import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { http, HttpResponse } from 'msw';
import { SyncEngine } from '../lib/sync/sync-engine.js';
import { writeSpaceConfig, type SpaceConfigWithState } from '../lib/space-config.js';
import { server } from './setup-msw.js';
import { createValidPage, createValidSpace } from './msw-schema-validation.js';
import { parseMarkdown } from '../lib/markdown/frontmatter.js';

const testConfig = {
  confluenceUrl: 'https://test.atlassian.net',
  email: 'test@example.com',
  apiToken: 'test-token',
};

describe('SyncEngine', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `cn-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe('initSync', () => {
    test('initializes sync for a space', async () => {
      server.use(
        http.get('*/wiki/api/v2/spaces', ({ request }) => {
          const url = new URL(request.url);
          const keys = url.searchParams.get('keys');
          if (keys === 'TEST') {
            return HttpResponse.json({
              results: [createValidSpace({ id: 'space-123', key: 'TEST', name: 'Test Space' })],
            });
          }
          return HttpResponse.json({ results: [] });
        }),
      );

      const engine = new SyncEngine(testConfig);
      const config = await engine.initSync(testDir, 'TEST');

      expect(config.spaceKey).toBe('TEST');
      expect(config.spaceId).toBe('space-123');
      expect(config.spaceName).toBe('Test Space');

      // Check that .confluence.json was created
      const configPath = join(testDir, '.confluence.json');
      expect(existsSync(configPath)).toBe(true);
    });
  });

  describe('fetchPageTree', () => {
    test('fetches all pages in a space', async () => {
      const engine = new SyncEngine(testConfig);
      const pages = await engine.fetchPageTree('space-123');

      expect(pages).toBeArray();
    });
  });

  describe('buildPageTree', () => {
    test('builds tree from flat pages', () => {
      const pages = [
        { id: 'page-1', title: 'Home', spaceId: 'space-123', status: 'current', parentId: null },
        { id: 'page-2', title: 'Getting Started', spaceId: 'space-123', status: 'current', parentId: 'page-1' },
        { id: 'page-3', title: 'API Reference', spaceId: 'space-123', status: 'current', parentId: 'page-1' },
        { id: 'page-4', title: 'Installation', spaceId: 'space-123', status: 'current', parentId: 'page-2' },
      ];

      const engine = new SyncEngine(testConfig);
      const tree = engine.buildPageTree(pages);

      expect(tree).toHaveLength(1);
      expect(tree[0].page.title).toBe('Home');
      expect(tree[0].children).toHaveLength(2);
    });

    test('handles orphan pages', () => {
      const pages = [
        { id: 'page-1', title: 'Page 1', spaceId: 'space-123', status: 'current', parentId: 'missing-parent' },
        { id: 'page-2', title: 'Page 2', spaceId: 'space-123', status: 'current', parentId: null },
      ];

      const engine = new SyncEngine(testConfig);
      const tree = engine.buildPageTree(pages);

      expect(tree).toHaveLength(2);
    });
  });

  describe('computeDiff', () => {
    test('detects added pages', () => {
      const remotePages = [
        { id: 'page-1', title: 'Page 1', spaceId: 'space-123', status: 'current', version: { number: 1 } },
        { id: 'page-2', title: 'Page 2', spaceId: 'space-123', status: 'current', version: { number: 1 } },
      ];

      const localConfig: SpaceConfigWithState = {
        spaceKey: 'TEST',
        spaceId: 'space-123',
        spaceName: 'Test Space',
        pages: {},
      };

      const engine = new SyncEngine(testConfig);
      const diff = engine.computeDiff(remotePages, localConfig);

      expect(diff.added).toHaveLength(2);
      expect(diff.modified).toHaveLength(0);
      expect(diff.deleted).toHaveLength(0);
    });

    test('detects modified pages', () => {
      const remotePages = [
        { id: 'page-1', title: 'Page 1', spaceId: 'space-123', status: 'current', version: { number: 2 } },
      ];

      // Per ADR-0024: pages is now Record<string, string> (pageId -> localPath)
      const localConfig: SpaceConfigWithState = {
        spaceKey: 'TEST',
        spaceId: 'space-123',
        spaceName: 'Test Space',
        pages: {
          'page-1': 'page-1.md',
        },
      };

      const engine = new SyncEngine(testConfig);
      // Without PageStateCache, local version defaults to 0, so remote v2 > local v0 -> modified
      const diff = engine.computeDiff(remotePages, localConfig);

      expect(diff.added).toHaveLength(0);
      expect(diff.modified).toHaveLength(1);
      expect(diff.deleted).toHaveLength(0);
    });

    test('detects deleted pages', () => {
      const remotePages: any[] = [];

      // Per ADR-0024: pages is now Record<string, string> (pageId -> localPath)
      const localConfig: SpaceConfigWithState = {
        spaceKey: 'TEST',
        spaceId: 'space-123',
        spaceName: 'Test Space',
        pages: {
          'page-1': 'page-1.md',
        },
      };

      const engine = new SyncEngine(testConfig);
      const diff = engine.computeDiff(remotePages, localConfig);

      expect(diff.added).toHaveLength(0);
      expect(diff.modified).toHaveLength(0);
      expect(diff.deleted).toHaveLength(1);
    });

    test('handles null localConfig', () => {
      const remotePages = [
        { id: 'page-1', title: 'Page 1', spaceId: 'space-123', status: 'current', version: { number: 1 } },
      ];

      const engine = new SyncEngine(testConfig);
      const diff = engine.computeDiff(remotePages, null);

      expect(diff.added).toHaveLength(1);
      expect(diff.modified).toHaveLength(0);
      expect(diff.deleted).toHaveLength(0);
    });

    test('filters out archived pages from remote', () => {
      const remotePages = [
        { id: 'page-1', title: 'Current Page', spaceId: 'space-123', status: 'current', version: { number: 1 } },
        { id: 'page-2', title: 'Archived Page', spaceId: 'space-123', status: 'archived', version: { number: 1 } },
        { id: 'page-3', title: 'Another Current', spaceId: 'space-123', status: 'current', version: { number: 1 } },
        { id: 'page-4', title: 'Draft Page', spaceId: 'space-123', status: 'draft', version: { number: 1 } },
        { id: 'page-5', title: 'Trashed Page', spaceId: 'space-123', status: 'trashed', version: { number: 1 } },
      ];

      const localConfig: SpaceConfigWithState = {
        spaceKey: 'TEST',
        spaceId: 'space-123',
        spaceName: 'Test Space',
        pages: {},
      };

      const engine = new SyncEngine(testConfig);
      const diff = engine.computeDiff(remotePages, localConfig);

      // Only the 2 current pages should be added (filters out archived, draft, and trashed)
      expect(diff.added).toHaveLength(2);
      expect(diff.added[0].pageId).toBe('page-1');
      expect(diff.added[1].pageId).toBe('page-3');
      expect(diff.modified).toHaveLength(0);
      expect(diff.deleted).toHaveLength(0);
    });

    test('treats locally-synced archived pages as deleted', () => {
      const remotePages = [
        { id: 'page-1', title: 'Current Page', spaceId: 'space-123', status: 'current', version: { number: 1 } },
        { id: 'page-2', title: 'Archived Page', spaceId: 'space-123', status: 'archived', version: { number: 1 } },
      ];

      const localConfig: SpaceConfigWithState = {
        spaceKey: 'TEST',
        spaceId: 'space-123',
        spaceName: 'Test Space',
        pages: {
          'page-1': 'page-1.md',
          'page-2': 'page-2.md', // This page is archived remotely
        },
      };

      // Provide PageStateCache so page-1 is not seen as modified
      const pageState = {
        pages: new Map([
          ['page-1', { pageId: 'page-1', localPath: 'page-1.md', title: 'Current Page', version: 1 }],
          ['page-2', { pageId: 'page-2', localPath: 'page-2.md', title: 'Archived Page', version: 1 }],
        ]),
        pathToPageId: new Map([
          ['page-1.md', 'page-1'],
          ['page-2.md', 'page-2'],
        ]),
      };

      const engine = new SyncEngine(testConfig);
      const diff = engine.computeDiff(remotePages, localConfig, pageState);

      expect(diff.added).toHaveLength(0);
      expect(diff.modified).toHaveLength(0);
      // page-2 should be detected as deleted because it's archived
      expect(diff.deleted).toHaveLength(1);
      expect(diff.deleted[0].pageId).toBe('page-2');
    });
  });

  describe('sync', () => {
    test('fails without space configuration', async () => {
      const engine = new SyncEngine(testConfig);
      const result = await engine.sync(testDir);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('No space configuration found');
    });

    test('performs dry run without changes', async () => {
      // Set up space config
      const spaceConfig: SpaceConfigWithState = {
        spaceKey: 'TEST',
        spaceId: 'space-123',
        spaceName: 'Test Space',
        pages: {},
      };
      writeSpaceConfig(testDir, spaceConfig);

      const engine = new SyncEngine(testConfig);
      const result = await engine.sync(testDir, { dryRun: true });

      expect(result.success).toBe(true);
      // In dry run, no files should be created
      const files = existsSync(join(testDir, 'home.md'));
      expect(files).toBe(false);
    });

    test('syncs new pages', async () => {
      // Set up mocks for pages
      server.use(
        http.get('*/wiki/api/v2/spaces/:spaceId/pages', () => {
          return HttpResponse.json({
            results: [
              createValidPage({
                id: 'page-1',
                title: 'Home',
                spaceId: 'space-123',
                body: '<p>Welcome!</p>',
              }),
            ],
          });
        }),
        http.get('*/wiki/api/v2/pages/:pageId', ({ params }) => {
          return HttpResponse.json(
            createValidPage({
              id: params.pageId as string,
              title: 'Home',
              spaceId: 'space-123',
              body: '<p>Welcome!</p>',
            }),
          );
        }),
      );

      // Set up space config
      const spaceConfig: SpaceConfigWithState = {
        spaceKey: 'TEST',
        spaceId: 'space-123',
        spaceName: 'Test Space',
        pages: {},
      };
      writeSpaceConfig(testDir, spaceConfig);

      const engine = new SyncEngine(testConfig);
      const result = await engine.sync(testDir);

      expect(result.success).toBe(true);
      expect(result.changes.added).toHaveLength(1);
    });

    test('skips pages with reserved filenames during sync', async () => {
      // Set up mocks for pages - include a page titled "Claude" which would generate claude.md
      server.use(
        http.get('*/wiki/api/v2/spaces/:spaceId/pages', () => {
          return HttpResponse.json({
            results: [
              createValidPage({
                id: 'page-1',
                title: 'Home',
                spaceId: 'space-123',
                body: '<p>Welcome!</p>',
              }),
              createValidPage({
                id: 'page-2',
                title: 'Claude',
                spaceId: 'space-123',
                parentId: 'page-1',
                body: '<p>This should be skipped</p>',
              }),
              createValidPage({
                id: 'page-3',
                title: 'Agents',
                spaceId: 'space-123',
                parentId: 'page-1',
                body: '<p>This should also be skipped</p>',
              }),
            ],
          });
        }),
        http.get('*/wiki/api/v2/pages/:pageId', ({ params }) => {
          const pageId = params.pageId as string;
          const titles: Record<string, string> = {
            'page-1': 'Home',
            'page-2': 'Claude',
            'page-3': 'Agents',
          };
          return HttpResponse.json(
            createValidPage({
              id: pageId,
              title: titles[pageId] || 'Unknown',
              spaceId: 'space-123',
              parentId: pageId === 'page-1' ? undefined : 'page-1',
              body: '<p>Content</p>',
            }),
          );
        }),
      );

      // Set up space config
      const spaceConfig: SpaceConfigWithState = {
        spaceKey: 'TEST',
        spaceId: 'space-123',
        spaceName: 'Test Space',
        pages: {},
      };
      writeSpaceConfig(testDir, spaceConfig);

      const engine = new SyncEngine(testConfig);
      const result = await engine.sync(testDir);

      expect(result.success).toBe(true);
      // 3 pages were added to diff, but 2 should be skipped
      expect(result.changes.added).toHaveLength(3);
      // Only README.md (home page) should exist, not claude.md or agents.md
      expect(existsSync(join(testDir, 'README.md'))).toBe(true);
      expect(existsSync(join(testDir, 'claude.md'))).toBe(false);
      expect(existsSync(join(testDir, 'agents.md'))).toBe(false);
      // Should have warnings about skipped pages (check for "reserved filename" in the message)
      expect(result.warnings.some((w) => w.includes('reserved filename') && w.includes('Claude'))).toBe(true);
      expect(result.warnings.some((w) => w.includes('reserved filename') && w.includes('Agents'))).toBe(true);
    });

    test('includes child_count in frontmatter for synced pages', async () => {
      // Set up page hierarchy:
      // Root (page-root) - 2 children
      //   ├─ Child 1 (page-child1) - 0 children
      //   └─ Child 2 (page-child2) - 1 child
      //       └─ Grandchild (page-grandchild) - 0 children
      server.use(
        http.get('*/wiki/api/v2/spaces/:spaceId/pages', () => {
          return HttpResponse.json({
            results: [
              createValidPage({
                id: 'page-root',
                title: 'Root Page',
                spaceId: 'space-123',
                body: '<p>Root content</p>',
              }),
              createValidPage({
                id: 'page-child1',
                title: 'Child 1',
                spaceId: 'space-123',
                parentId: 'page-root',
                body: '<p>Child 1 content</p>',
              }),
              createValidPage({
                id: 'page-child2',
                title: 'Child 2',
                spaceId: 'space-123',
                parentId: 'page-root',
                body: '<p>Child 2 content</p>',
              }),
              createValidPage({
                id: 'page-grandchild',
                title: 'Grandchild',
                spaceId: 'space-123',
                parentId: 'page-child2',
                body: '<p>Grandchild content</p>',
              }),
            ],
          });
        }),
        http.get('*/wiki/api/v2/pages/:pageId', ({ params }) => {
          const pageId = params.pageId as string;
          const pageData: Record<string, { title: string; parentId?: string }> = {
            'page-root': { title: 'Root Page' },
            'page-child1': { title: 'Child 1', parentId: 'page-root' },
            'page-child2': { title: 'Child 2', parentId: 'page-root' },
            'page-grandchild': { title: 'Grandchild', parentId: 'page-child2' },
          };
          const data = pageData[pageId] || { title: 'Unknown' };
          return HttpResponse.json(
            createValidPage({
              id: pageId,
              title: data.title,
              spaceId: 'space-123',
              parentId: data.parentId,
              body: `<p>${data.title} content</p>`,
            }),
          );
        }),
      );

      // Set up space config
      const spaceConfig: SpaceConfigWithState = {
        spaceKey: 'TEST',
        spaceId: 'space-123',
        spaceName: 'Test Space',
        pages: {},
      };
      writeSpaceConfig(testDir, spaceConfig);

      const engine = new SyncEngine(testConfig);
      const result = await engine.sync(testDir);

      expect(result.success).toBe(true);
      expect(result.changes.added).toHaveLength(4);

      // Verify child_count in synced files
      const rootContent = readFileSync(join(testDir, 'README.md'), 'utf-8');
      const child1Content = readFileSync(join(testDir, 'child-1.md'), 'utf-8');
      const child2Content = readFileSync(join(testDir, 'child-2/README.md'), 'utf-8');
      const grandchildContent = readFileSync(join(testDir, 'child-2/grandchild.md'), 'utf-8');

      const rootFrontmatter = parseMarkdown(rootContent).frontmatter;
      const child1Frontmatter = parseMarkdown(child1Content).frontmatter;
      const child2Frontmatter = parseMarkdown(child2Content).frontmatter;
      const grandchildFrontmatter = parseMarkdown(grandchildContent).frontmatter;

      // Root has 2 direct children
      expect(rootFrontmatter.child_count).toBe(2);
      // Child 1 has 0 children (leaf page)
      expect(child1Frontmatter.child_count).toBe(0);
      // Child 2 has 1 child
      expect(child2Frontmatter.child_count).toBe(1);
      // Grandchild has 0 children (leaf page)
      expect(grandchildFrontmatter.child_count).toBe(0);
    });
  });
});
