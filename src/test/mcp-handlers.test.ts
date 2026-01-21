import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  handleReadPage,
  InvalidParamsError,
  McpPageNotFoundError,
  resolvePagePath,
  toSearchOptions,
  type McpServerConfig,
  type ReadPageToolInput,
  type SearchToolInput,
} from '../lib/mcp/index.js';
import type { SpaceConfigWithState } from '../lib/space-config.js';

describe('MCP Handlers', () => {
  let testDir: string;
  let spaceConfig: SpaceConfigWithState;
  let serverConfig: McpServerConfig;

  beforeEach(() => {
    testDir = join(tmpdir(), `cn-mcp-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    spaceConfig = {
      spaceKey: 'TEST',
      spaceId: 'space-123',
      spaceName: 'Test Space',
      pages: {
        'page-123': {
          pageId: 'page-123',
          version: 1,
          localPath: 'docs/test-page.md',
          title: 'Test Page',
        },
        'page-456': {
          pageId: 'page-456',
          version: 2,
          localPath: 'other/another-page.md',
          title: 'Another Page',
        },
      },
    };

    serverConfig = {
      workspacePath: testDir,
      indexName: 'cn-test',
      meilisearchUrl: 'http://localhost:7700',
      meilisearchApiKey: null,
      spaceKey: 'TEST',
      spaceName: 'Test Space',
    };
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe('toSearchOptions', () => {
    test('converts SearchToolInput to SearchOptions', () => {
      const input: SearchToolInput = {
        query: 'test query',
        limit: 20,
        labels: ['docs', 'api'],
        author: 'test@example.com',
        created_after: '2024-01-01',
        updated_before: '2024-12-31',
        sort: '-updated_at',
      };

      const options = toSearchOptions(input);

      expect(options.limit).toBe(20);
      expect(options.labels).toEqual(['docs', 'api']);
      expect(options.author).toBe('test@example.com');
      expect(options.createdAfter).toBe('2024-01-01');
      expect(options.updatedBefore).toBe('2024-12-31');
      expect(options.sort).toBe('-updated_at');
    });

    test('handles minimal input', () => {
      const input: SearchToolInput = {
        query: 'test',
      };

      const options = toSearchOptions(input);

      expect(options.limit).toBeUndefined();
      expect(options.labels).toBeUndefined();
      expect(options.author).toBeUndefined();
    });

    test('converts relative date filters', () => {
      const input: SearchToolInput = {
        query: 'test query',
        created_within: '30d',
        updated_within: '7d',
        stale: '90d',
      };

      const options = toSearchOptions(input);

      expect(options.createdWithin).toBe('30d');
      expect(options.updatedWithin).toBe('7d');
      expect(options.stale).toBe('90d');
    });

    test('converts all date filter options together', () => {
      const input: SearchToolInput = {
        query: 'comprehensive test',
        created_after: '2024-01-01',
        created_before: '2024-06-01',
        updated_after: '2024-03-01',
        updated_before: '2024-12-31',
        created_within: '1y',
        updated_within: '2w',
        stale: '6m',
        sort: '-created_at',
      };

      const options = toSearchOptions(input);

      // Absolute dates
      expect(options.createdAfter).toBe('2024-01-01');
      expect(options.createdBefore).toBe('2024-06-01');
      expect(options.updatedAfter).toBe('2024-03-01');
      expect(options.updatedBefore).toBe('2024-12-31');
      // Relative dates
      expect(options.createdWithin).toBe('1y');
      expect(options.updatedWithin).toBe('2w');
      expect(options.stale).toBe('6m');
      // Sort
      expect(options.sort).toBe('-created_at');
    });
  });

  describe('resolvePagePath', () => {
    beforeEach(() => {
      // Create test files
      const docsDir = join(testDir, 'docs');
      const otherDir = join(testDir, 'other');
      mkdirSync(docsDir, { recursive: true });
      mkdirSync(otherDir, { recursive: true });

      const testPageContent = `---
page_id: "page-123"
title: "Test Page"
space_key: "TEST"
---

# Test Page

This is test content.
`;

      const anotherPageContent = `---
page_id: "page-456"
title: "Another Page"
space_key: "TEST"
---

# Another Page

This is another page.
`;

      writeFileSync(join(docsDir, 'test-page.md'), testPageContent);
      writeFileSync(join(otherDir, 'another-page.md'), anotherPageContent);
    });

    test('resolves path by relative path', () => {
      const input: ReadPageToolInput = { path: 'docs/test-page.md' };
      const result = resolvePagePath(input, testDir, spaceConfig);
      expect(result).toBe(join(testDir, 'docs/test-page.md'));
    });

    test('resolves path by page ID', () => {
      const input: ReadPageToolInput = { id: 'page-123' };
      const result = resolvePagePath(input, testDir, spaceConfig);
      expect(result).toBe(join(testDir, 'docs/test-page.md'));
    });

    test('throws InvalidParamsError when neither path nor id provided', () => {
      const input: ReadPageToolInput = {};
      expect(() => resolvePagePath(input, testDir, spaceConfig)).toThrow(InvalidParamsError);
    });

    test('throws McpPageNotFoundError for non-existent path', () => {
      const input: ReadPageToolInput = { path: 'non/existent/file.md' };
      expect(() => resolvePagePath(input, testDir, spaceConfig)).toThrow(McpPageNotFoundError);
    });

    test('throws McpPageNotFoundError for unknown page ID', () => {
      const input: ReadPageToolInput = { id: 'unknown-page-id' };
      expect(() => resolvePagePath(input, testDir, spaceConfig)).toThrow(McpPageNotFoundError);
    });

    test('prevents path traversal attacks with ..', () => {
      const input: ReadPageToolInput = { path: '../outside/file.md' };
      expect(() => resolvePagePath(input, testDir, spaceConfig)).toThrow(InvalidParamsError);
    });

    test('prevents path traversal attacks with nested ..', () => {
      const input: ReadPageToolInput = { path: 'docs/../../outside/file.md' };
      expect(() => resolvePagePath(input, testDir, spaceConfig)).toThrow(InvalidParamsError);
    });

    test('rejects absolute paths', () => {
      const input: ReadPageToolInput = { path: '/etc/passwd' };
      expect(() => resolvePagePath(input, testDir, spaceConfig)).toThrow(InvalidParamsError);
      expect(() => resolvePagePath(input, testDir, spaceConfig)).toThrow('Path must be relative, not absolute');
    });

    test('prefers path over id when both provided', () => {
      // When both path and id are provided, path should be used
      const input: ReadPageToolInput = { path: 'docs/test-page.md', id: 'page-456' };
      const result = resolvePagePath(input, testDir, spaceConfig);
      // Should resolve to the path, not the id's localPath
      expect(result).toBe(join(testDir, 'docs/test-page.md'));
    });
  });

  describe('handleReadPage', () => {
    beforeEach(() => {
      // Create test files
      const docsDir = join(testDir, 'docs');
      mkdirSync(docsDir, { recursive: true });

      const testPageContent = `---
page_id: "page-123"
title: "Test Page"
space_key: "TEST"
labels:
  - documentation
  - api
author_email: "author@example.com"
created_at: "2024-01-15T10:00:00Z"
updated_at: "2024-01-20T15:30:00Z"
url: "https://example.atlassian.net/wiki/spaces/TEST/pages/123"
---

# Test Page

This is the **test content** with some markdown.

## Section 1

More content here.
`;

      writeFileSync(join(docsDir, 'test-page.md'), testPageContent);
    });

    test('reads page by path', async () => {
      const input: ReadPageToolInput = { path: 'docs/test-page.md' };
      const result = await handleReadPage(input, serverConfig, spaceConfig);

      expect(result.id).toBe('page-123');
      expect(result.title).toBe('Test Page');
      expect(result.path).toBe('docs/test-page.md');
      expect(result.content).toContain('# Test Page');
      expect(result.content).toContain('This is the **test content**');
      expect(result.metadata.labels).toEqual(['documentation', 'api']);
      expect(result.metadata.author).toBe('author@example.com');
      expect(result.metadata.url).toBe('https://example.atlassian.net/wiki/spaces/TEST/pages/123');
    });

    test('reads page by ID', async () => {
      const input: ReadPageToolInput = { id: 'page-123' };
      const result = await handleReadPage(input, serverConfig, spaceConfig);

      expect(result.id).toBe('page-123');
      expect(result.title).toBe('Test Page');
    });

    test('returns content without frontmatter', async () => {
      const input: ReadPageToolInput = { path: 'docs/test-page.md' };
      const result = await handleReadPage(input, serverConfig, spaceConfig);

      expect(result.content).not.toContain('page_id:');
      expect(result.content).not.toContain('---');
      expect(result.content.trim().startsWith('#')).toBe(true);
    });
  });
});
