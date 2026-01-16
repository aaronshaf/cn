import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { http, HttpResponse } from 'msw';
import {
  createSearchDocument,
  getIndexName,
  scanDirectory,
  SearchClient,
  type SearchDocument,
} from '../lib/search/index.js';
import type { PageFrontmatter } from '../lib/markdown/frontmatter.js';
import { MeilisearchConnectionError, MeilisearchIndexError } from '../lib/errors.js';
import { server } from './setup-msw.js';

describe('Search Module', () => {
  describe('getIndexName', () => {
    test('generates lowercase index name from space key', () => {
      expect(getIndexName('ENG')).toBe('cn-eng');
      expect(getIndexName('DOCS')).toBe('cn-docs');
      expect(getIndexName('MySpace')).toBe('cn-myspace');
    });

    test('sanitizes special characters to underscores', () => {
      expect(getIndexName('~557058c58023e5e8124f25beba0367b55dc615')).toBe(
        'cn-_557058c58023e5e8124f25beba0367b55dc615',
      );
      expect(getIndexName('space@key')).toBe('cn-space_key');
      expect(getIndexName('space.key')).toBe('cn-space_key');
      expect(getIndexName('space key')).toBe('cn-space_key');
    });
  });

  describe('createSearchDocument', () => {
    test('creates search document from frontmatter', () => {
      const frontmatter: Partial<PageFrontmatter> = {
        page_id: 'page-123',
        title: 'Test Page',
        space_key: 'ENG',
        labels: ['documentation', 'api'],
        author_email: 'author@example.com',
        last_modifier_email: 'modifier@example.com',
        created_at: '2024-01-15T10:30:00Z',
        updated_at: '2024-01-16T14:00:00Z',
        url: 'https://example.atlassian.net/wiki/spaces/ENG/pages/123',
        parent_title: 'Parent Page',
      };

      const content = 'This is the page content';
      const localPath = 'docs/test-page.md';

      const doc = createSearchDocument(frontmatter, content, localPath);

      expect(doc).not.toBeNull();
      expect(doc?.id).toBe('page-123');
      expect(doc?.title).toBe('Test Page');
      expect(doc?.content).toBe('This is the page content');
      expect(doc?.space_key).toBe('ENG');
      expect(doc?.labels).toEqual(['documentation', 'api']);
      expect(doc?.author_email).toBe('author@example.com');
      expect(doc?.last_modifier_email).toBe('modifier@example.com');
      expect(doc?.local_path).toBe('docs/test-page.md');
      expect(doc?.url).toBe('https://example.atlassian.net/wiki/spaces/ENG/pages/123');
      expect(doc?.parent_title).toBe('Parent Page');
      // Timestamps should be converted to Unix timestamps
      expect(doc?.created_at).toBe(Math.floor(new Date('2024-01-15T10:30:00Z').getTime() / 1000));
      expect(doc?.updated_at).toBe(Math.floor(new Date('2024-01-16T14:00:00Z').getTime() / 1000));
    });

    test('returns null when page_id is missing', () => {
      const frontmatter: Partial<PageFrontmatter> = {
        title: 'Test Page',
        space_key: 'ENG',
      };

      const doc = createSearchDocument(frontmatter, 'content', 'path.md');
      expect(doc).toBeNull();
    });

    test('handles missing optional fields', () => {
      const frontmatter: Partial<PageFrontmatter> = {
        page_id: 'page-456',
        title: 'Minimal Page',
      };

      const doc = createSearchDocument(frontmatter, 'content', 'minimal.md');

      expect(doc).not.toBeNull();
      expect(doc?.id).toBe('page-456');
      expect(doc?.labels).toEqual([]);
      expect(doc?.author_email).toBeNull();
      expect(doc?.url).toBeNull();
      expect(doc?.created_at).toBeNull();
    });
  });

  describe('scanDirectory', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = join(tmpdir(), `cn-search-test-${Date.now()}`);
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true });
      }
    });

    test('scans markdown files with frontmatter', () => {
      // Create test markdown files
      const file1Content = `---
page_id: "page-1"
title: "Test Page 1"
space_key: "ENG"
labels:
  - documentation
---

# Test Page 1

This is test content for page 1.
`;

      const file2Content = `---
page_id: "page-2"
title: "Test Page 2"
space_key: "ENG"
author_email: "test@example.com"
---

# Test Page 2

This is test content for page 2.
`;

      writeFileSync(join(testDir, 'page1.md'), file1Content);
      writeFileSync(join(testDir, 'page2.md'), file2Content);

      const result = scanDirectory(testDir);

      expect(result.scannedFiles).toBe(2);
      expect(result.indexedFiles).toBe(2);
      expect(result.skippedFiles).toBe(0);
      expect(result.documents).toHaveLength(2);

      const doc1 = result.documents.find((d) => d.id === 'page-1');
      expect(doc1).toBeDefined();
      expect(doc1?.title).toBe('Test Page 1');
      expect(doc1?.labels).toEqual(['documentation']);

      const doc2 = result.documents.find((d) => d.id === 'page-2');
      expect(doc2).toBeDefined();
      expect(doc2?.author_email).toBe('test@example.com');
    });

    test('skips files without page_id', () => {
      const validFile = `---
page_id: "page-valid"
title: "Valid Page"
space_key: "ENG"
---

Content
`;

      const invalidFile = `---
title: "No Page ID"
space_key: "ENG"
---

Content without page_id
`;

      writeFileSync(join(testDir, 'valid.md'), validFile);
      writeFileSync(join(testDir, 'invalid.md'), invalidFile);

      const result = scanDirectory(testDir);

      expect(result.scannedFiles).toBe(2);
      expect(result.indexedFiles).toBe(1);
      expect(result.skippedFiles).toBe(1);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].id).toBe('page-valid');
    });

    test('scans nested directories', () => {
      const nestedDir = join(testDir, 'nested', 'deep');
      mkdirSync(nestedDir, { recursive: true });

      const rootFile = `---
page_id: "page-root"
title: "Root Page"
space_key: "ENG"
---

Root content
`;

      const nestedFile = `---
page_id: "page-nested"
title: "Nested Page"
space_key: "ENG"
---

Nested content
`;

      writeFileSync(join(testDir, 'root.md'), rootFile);
      writeFileSync(join(nestedDir, 'nested.md'), nestedFile);

      const result = scanDirectory(testDir);

      expect(result.indexedFiles).toBe(2);
      expect(result.documents).toHaveLength(2);

      const nestedDoc = result.documents.find((d) => d.id === 'page-nested');
      expect(nestedDoc).toBeDefined();
      expect(nestedDoc?.local_path).toBe('nested/deep/nested.md');
    });

    test('excludes node_modules and .git directories', () => {
      const nodeModulesDir = join(testDir, 'node_modules');
      const gitDir = join(testDir, '.git');
      mkdirSync(nodeModulesDir, { recursive: true });
      mkdirSync(gitDir, { recursive: true });

      const validFile = `---
page_id: "page-valid"
title: "Valid"
space_key: "ENG"
---

Valid content
`;

      const excludedFile = `---
page_id: "page-excluded"
title: "Excluded"
space_key: "ENG"
---

Should be excluded
`;

      writeFileSync(join(testDir, 'valid.md'), validFile);
      writeFileSync(join(nodeModulesDir, 'excluded1.md'), excludedFile);
      writeFileSync(join(gitDir, 'excluded2.md'), excludedFile);

      const result = scanDirectory(testDir);

      expect(result.indexedFiles).toBe(1);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].id).toBe('page-valid');
    });

    test('handles non-existent directory', () => {
      const result = scanDirectory('/non/existent/path');

      expect(result.documents).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('not found');
    });

    test('handles empty directory', () => {
      const result = scanDirectory(testDir);

      expect(result.scannedFiles).toBe(0);
      expect(result.indexedFiles).toBe(0);
      expect(result.documents).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });
  });
});
