import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildPageStateFromFiles, getPageInfoByPath, scanDirectoryForPages } from '../lib/page-state.js';

describe('page-state', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cn-page-state-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe('buildPageStateFromFiles', () => {
    test('builds page state from valid markdown files', () => {
      // Create test files with frontmatter
      const docsDir = join(testDir, 'docs');
      mkdirSync(docsDir, { recursive: true });

      writeFileSync(
        join(testDir, 'home.md'),
        `---
page_id: "page-1"
title: "Home Page"
version: 3
updated_at: "2024-01-15T10:00:00Z"
synced_at: "2024-01-16T08:00:00Z"
---

# Home Page

Welcome!
`,
      );

      writeFileSync(
        join(docsDir, 'guide.md'),
        `---
page_id: "page-2"
title: "User Guide"
version: 5
updated_at: "2024-01-20T14:30:00Z"
---

# User Guide

Content here.
`,
      );

      const pageMappings = {
        'page-1': 'home.md',
        'page-2': 'docs/guide.md',
      };

      const result = buildPageStateFromFiles(testDir, pageMappings);

      // Check pages map
      expect(result.pages.size).toBe(2);

      const page1 = result.pages.get('page-1');
      expect(page1).toBeDefined();
      expect(page1?.pageId).toBe('page-1');
      expect(page1?.localPath).toBe('home.md');
      expect(page1?.title).toBe('Home Page');
      expect(page1?.version).toBe(3);
      expect(page1?.updatedAt).toBe('2024-01-15T10:00:00Z');
      expect(page1?.syncedAt).toBe('2024-01-16T08:00:00Z');

      const page2 = result.pages.get('page-2');
      expect(page2).toBeDefined();
      expect(page2?.title).toBe('User Guide');
      expect(page2?.version).toBe(5);

      // Check pathToPageId map
      expect(result.pathToPageId.size).toBe(2);
      expect(result.pathToPageId.get('home.md')).toBe('page-1');
      expect(result.pathToPageId.get('docs/guide.md')).toBe('page-2');
    });

    test('skips files that do not exist and reports warnings', () => {
      writeFileSync(
        join(testDir, 'exists.md'),
        `---
page_id: "page-1"
title: "Existing Page"
version: 1
---

Content
`,
      );

      const pageMappings = {
        'page-1': 'exists.md',
        'page-2': 'does-not-exist.md',
      };

      const result = buildPageStateFromFiles(testDir, pageMappings);

      // Only the existing file should be in pages map
      expect(result.pages.size).toBe(1);
      expect(result.pages.has('page-1')).toBe(true);
      expect(result.pages.has('page-2')).toBe(false);

      // pathToPageId should only contain successfully parsed pages
      expect(result.pathToPageId.size).toBe(1);
      expect(result.pathToPageId.get('exists.md')).toBe('page-1');

      // Should have a warning about the missing file
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toContain('File not found');
      expect(result.warnings[0]).toContain('page-2');
    });

    test('handles files with malformed frontmatter and reports warnings', () => {
      writeFileSync(
        join(testDir, 'valid.md'),
        `---
page_id: "page-1"
title: "Valid Page"
version: 1
---

Content
`,
      );

      writeFileSync(
        join(testDir, 'malformed.md'),
        `---
this is not valid yaml: [
---

Content
`,
      );

      const pageMappings = {
        'page-1': 'valid.md',
        'page-2': 'malformed.md',
      };

      const result = buildPageStateFromFiles(testDir, pageMappings);

      // Only the valid file should be in pages map
      expect(result.pages.size).toBe(1);
      expect(result.pages.has('page-1')).toBe(true);
      expect(result.pages.has('page-2')).toBe(false);

      // Should have a warning about the malformed file
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toContain('Failed to parse frontmatter');
      expect(result.warnings[0]).toContain('malformed.md');
    });

    test('handles empty page mappings', () => {
      const result = buildPageStateFromFiles(testDir, {});

      expect(result.pages.size).toBe(0);
      expect(result.pathToPageId.size).toBe(0);
      expect(result.warnings.length).toBe(0);
    });

    test('warns when frontmatter page_id does not match mapping key', () => {
      writeFileSync(
        join(testDir, 'mismatched.md'),
        `---
page_id: "actual-page-id"
title: "Mismatched Page"
version: 1
---

Content
`,
      );

      const pageMappings = {
        'mapping-page-id': 'mismatched.md',
      };

      const result = buildPageStateFromFiles(testDir, pageMappings);

      // Page should still be added (using mapping key)
      expect(result.pages.size).toBe(1);
      expect(result.pages.has('mapping-page-id')).toBe(true);

      // Should have a warning about the mismatch
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toContain('Page ID mismatch');
      expect(result.warnings[0]).toContain('mapping-page-id');
      expect(result.warnings[0]).toContain('actual-page-id');
    });

    test('skips paths that attempt directory traversal', () => {
      writeFileSync(
        join(testDir, 'safe.md'),
        `---
page_id: "safe-page"
title: "Safe Page"
version: 1
---

Content
`,
      );

      const pageMappings = {
        'safe-page': 'safe.md',
        'malicious-page': '../../../etc/passwd',
      };

      const result = buildPageStateFromFiles(testDir, pageMappings);

      // Only the safe page should be added
      expect(result.pages.size).toBe(1);
      expect(result.pages.has('safe-page')).toBe(true);
      expect(result.pages.has('malicious-page')).toBe(false);

      // Should have a warning about the traversal attempt
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toContain('Skipping path outside directory');
      expect(result.warnings[0]).toContain('malicious-page');
    });

    test('uses default values for missing frontmatter fields', () => {
      writeFileSync(
        join(testDir, 'minimal.md'),
        `---
page_id: "page-1"
---

Minimal content
`,
      );

      const pageMappings = {
        'page-1': 'minimal.md',
      };

      const result = buildPageStateFromFiles(testDir, pageMappings);

      const page = result.pages.get('page-1');
      expect(page).toBeDefined();
      expect(page?.title).toBe(''); // Default empty string
      expect(page?.version).toBe(1); // Default version 1
      expect(page?.updatedAt).toBeUndefined();
      expect(page?.syncedAt).toBeUndefined();
    });
  });

  describe('getPageInfoByPath', () => {
    test('returns page info for valid file', () => {
      writeFileSync(
        join(testDir, 'page.md'),
        `---
page_id: "page-123"
title: "Test Page"
version: 7
updated_at: "2024-02-01T12:00:00Z"
---

Content
`,
      );

      const result = getPageInfoByPath(testDir, 'page.md');

      expect(result).not.toBeNull();
      expect(result?.pageId).toBe('page-123');
      expect(result?.localPath).toBe('page.md');
      expect(result?.title).toBe('Test Page');
      expect(result?.version).toBe(7);
      expect(result?.updatedAt).toBe('2024-02-01T12:00:00Z');
    });

    test('returns null for non-existent file', () => {
      const result = getPageInfoByPath(testDir, 'does-not-exist.md');

      expect(result).toBeNull();
    });

    test('returns null for file without page_id', () => {
      writeFileSync(
        join(testDir, 'no-id.md'),
        `---
title: "Page Without ID"
---

Content
`,
      );

      const result = getPageInfoByPath(testDir, 'no-id.md');

      expect(result).toBeNull();
    });

    test('returns null for file with malformed frontmatter', () => {
      writeFileSync(
        join(testDir, 'bad.md'),
        `---
invalid: yaml: content: [
---

Content
`,
      );

      const result = getPageInfoByPath(testDir, 'bad.md');

      expect(result).toBeNull();
    });

    test('handles nested paths', () => {
      const nestedDir = join(testDir, 'deeply', 'nested', 'path');
      mkdirSync(nestedDir, { recursive: true });

      writeFileSync(
        join(nestedDir, 'page.md'),
        `---
page_id: "nested-page"
title: "Nested Page"
version: 2
---

Nested content
`,
      );

      const result = getPageInfoByPath(testDir, 'deeply/nested/path/page.md');

      expect(result).not.toBeNull();
      expect(result?.pageId).toBe('nested-page');
      expect(result?.localPath).toBe('deeply/nested/path/page.md');
    });
  });

  describe('scanDirectoryForPages', () => {
    test('discovers all markdown files with page_id', () => {
      // Create directory structure
      const docsDir = join(testDir, 'docs');
      const apiDir = join(testDir, 'docs', 'api');
      mkdirSync(apiDir, { recursive: true });

      writeFileSync(
        join(testDir, 'README.md'),
        `---
page_id: "home"
title: "Home"
version: 1
---

Home content
`,
      );

      writeFileSync(
        join(docsDir, 'guide.md'),
        `---
page_id: "guide"
title: "Guide"
version: 2
---

Guide content
`,
      );

      writeFileSync(
        join(apiDir, 'endpoints.md'),
        `---
page_id: "api-endpoints"
title: "API Endpoints"
version: 3
---

API content
`,
      );

      // File without page_id should be skipped
      writeFileSync(
        join(testDir, 'untracked.md'),
        `---
title: "Untracked File"
---

Not a Confluence page
`,
      );

      const result = scanDirectoryForPages(testDir);

      expect(result.pages.size).toBe(3);
      expect(result.pages.has('home')).toBe(true);
      expect(result.pages.has('guide')).toBe(true);
      expect(result.pages.has('api-endpoints')).toBe(true);

      expect(result.pathToPageId.get('README.md')).toBe('home');
      expect(result.pathToPageId.get('docs/guide.md')).toBe('guide');
      expect(result.pathToPageId.get('docs/api/endpoints.md')).toBe('api-endpoints');
    });

    test('skips hidden directories', () => {
      const hiddenDir = join(testDir, '.hidden');
      mkdirSync(hiddenDir, { recursive: true });

      writeFileSync(
        join(hiddenDir, 'secret.md'),
        `---
page_id: "secret"
title: "Secret Page"
version: 1
---

Should be skipped
`,
      );

      writeFileSync(
        join(testDir, 'visible.md'),
        `---
page_id: "visible"
title: "Visible Page"
version: 1
---

Should be included
`,
      );

      const result = scanDirectoryForPages(testDir);

      expect(result.pages.size).toBe(1);
      expect(result.pages.has('visible')).toBe(true);
      expect(result.pages.has('secret')).toBe(false);
    });

    test('skips node_modules directory', () => {
      const nodeModulesDir = join(testDir, 'node_modules', 'some-package');
      mkdirSync(nodeModulesDir, { recursive: true });

      writeFileSync(
        join(nodeModulesDir, 'readme.md'),
        `---
page_id: "npm-page"
title: "NPM Package"
version: 1
---

Should be skipped
`,
      );

      writeFileSync(
        join(testDir, 'app.md'),
        `---
page_id: "app"
title: "App"
version: 1
---

Should be included
`,
      );

      const result = scanDirectoryForPages(testDir);

      expect(result.pages.size).toBe(1);
      expect(result.pages.has('app')).toBe(true);
      expect(result.pages.has('npm-page')).toBe(false);
    });

    test('skips reserved filenames (claude.md, agents.md)', () => {
      writeFileSync(
        join(testDir, 'CLAUDE.md'),
        `---
page_id: "claude-page"
title: "Claude Instructions"
version: 1
---

Should be skipped
`,
      );

      writeFileSync(
        join(testDir, 'agents.md'),
        `---
page_id: "agents-page"
title: "Agents Config"
version: 1
---

Should be skipped
`,
      );

      writeFileSync(
        join(testDir, 'readme.md'),
        `---
page_id: "readme"
title: "Readme"
version: 1
---

Should be included
`,
      );

      const result = scanDirectoryForPages(testDir);

      expect(result.pages.size).toBe(1);
      expect(result.pages.has('readme')).toBe(true);
      expect(result.pages.has('claude-page')).toBe(false);
      expect(result.pages.has('agents-page')).toBe(false);
    });

    test('handles empty directory', () => {
      const result = scanDirectoryForPages(testDir);

      expect(result.pages.size).toBe(0);
      expect(result.pathToPageId.size).toBe(0);
    });

    test('handles directory with only non-markdown files', () => {
      writeFileSync(join(testDir, 'config.json'), '{}');
      writeFileSync(join(testDir, 'script.ts'), 'console.log("hello")');

      const result = scanDirectoryForPages(testDir);

      expect(result.pages.size).toBe(0);
    });
  });
});
