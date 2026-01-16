import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPushCandidates, scanMarkdownFiles } from '../lib/file-scanner.js';

describe('file-scanner', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cn-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('scanMarkdownFiles', () => {
    test('finds markdown files in directory', () => {
      writeFileSync(join(testDir, 'page1.md'), '# Page 1');
      writeFileSync(join(testDir, 'page2.md'), '# Page 2');
      writeFileSync(join(testDir, 'readme.txt'), 'not markdown');

      const files = scanMarkdownFiles(testDir);

      expect(files).toEqual(['page1.md', 'page2.md']);
    });

    test('finds markdown files recursively', () => {
      mkdirSync(join(testDir, 'subdir'));
      writeFileSync(join(testDir, 'page1.md'), '# Page 1');
      writeFileSync(join(testDir, 'subdir', 'page2.md'), '# Page 2');

      const files = scanMarkdownFiles(testDir);

      expect(files).toEqual(['page1.md', 'subdir/page2.md']);
    });

    test('excludes hidden files and directories', () => {
      mkdirSync(join(testDir, '.git'));
      writeFileSync(join(testDir, '.hidden.md'), 'hidden');
      writeFileSync(join(testDir, '.git', 'config.md'), 'git');
      writeFileSync(join(testDir, 'visible.md'), '# Visible');

      const files = scanMarkdownFiles(testDir);

      expect(files).toEqual(['visible.md']);
    });

    test('excludes common build directories', () => {
      mkdirSync(join(testDir, 'node_modules'));
      mkdirSync(join(testDir, 'dist'));
      writeFileSync(join(testDir, 'node_modules', 'package.md'), 'dep');
      writeFileSync(join(testDir, 'dist', 'output.md'), 'build');
      writeFileSync(join(testDir, 'page.md'), '# Page');

      const files = scanMarkdownFiles(testDir);

      expect(files).toEqual(['page.md']);
    });

    test('returns empty array for directory with no markdown files', () => {
      writeFileSync(join(testDir, 'readme.txt'), 'not markdown');

      const files = scanMarkdownFiles(testDir);

      expect(files).toEqual([]);
    });

    test('returns files sorted alphabetically', () => {
      writeFileSync(join(testDir, 'zebra.md'), 'Z');
      writeFileSync(join(testDir, 'alpha.md'), 'A');
      writeFileSync(join(testDir, 'beta.md'), 'B');

      const files = scanMarkdownFiles(testDir);

      expect(files).toEqual(['alpha.md', 'beta.md', 'zebra.md']);
    });
  });

  describe('detectPushCandidates', () => {
    test('detects new files without page_id', () => {
      const content = `---
title: New Page
---

Content here.`;
      writeFileSync(join(testDir, 'new-page.md'), content);

      const candidates = detectPushCandidates(testDir);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        path: 'new-page.md',
        type: 'new',
        title: 'New Page',
      });
      expect(candidates[0].pageId).toBeUndefined();
    });

    test('detects modified files with mtime after synced_at', () => {
      const syncedAt = new Date('2026-01-15T12:00:00.000Z');
      const content = `---
page_id: '12345'
title: Existing Page
synced_at: '${syncedAt.toISOString()}'
---

Content here.`;
      const filePath = join(testDir, 'modified.md');
      writeFileSync(filePath, content);

      // Set file mtime to 2 seconds after synced_at (beyond tolerance)
      const modifiedTime = new Date(syncedAt.getTime() + 2000);
      utimesSync(filePath, modifiedTime, modifiedTime);

      const candidates = detectPushCandidates(testDir);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        path: 'modified.md',
        type: 'modified',
        title: 'Existing Page',
        pageId: '12345',
      });
    });

    test('ignores files with mtime within tolerance window', () => {
      const syncedAt = new Date('2026-01-15T12:00:00.000Z');
      const content = `---
page_id: '12345'
title: Just Synced Page
synced_at: '${syncedAt.toISOString()}'
---

Content here.`;
      const filePath = join(testDir, 'just-synced.md');
      writeFileSync(filePath, content);

      // Set file mtime to 500ms after synced_at (within 1 second tolerance)
      const justAfterSync = new Date(syncedAt.getTime() + 500);
      utimesSync(filePath, justAfterSync, justAfterSync);

      const candidates = detectPushCandidates(testDir);

      expect(candidates).toHaveLength(0);
    });

    test('detects files without synced_at as modified', () => {
      const content = `---
page_id: '12345'
title: Legacy Page
---

Content here.`;
      writeFileSync(join(testDir, 'legacy.md'), content);

      const candidates = detectPushCandidates(testDir);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        path: 'legacy.md',
        type: 'modified',
        title: 'Legacy Page',
        pageId: '12345',
      });
    });

    test('uses filename as title when no title in frontmatter', () => {
      const content = `---
page_id: '12345'
synced_at: '2026-01-15T12:00:00.000Z'
---

Content here.`;
      const filePath = join(testDir, 'untitled-page.md');
      writeFileSync(filePath, content);

      // Modify to be detected
      const modifiedTime = new Date('2026-01-15T12:00:02.000Z');
      utimesSync(filePath, modifiedTime, modifiedTime);

      const candidates = detectPushCandidates(testDir);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].title).toBe('untitled-page');
    });

    test('returns multiple candidates sorted by path', () => {
      // New file
      writeFileSync(
        join(testDir, 'new.md'),
        `---
title: New
---
Content`,
      );

      // Modified file
      const syncedAt = new Date('2026-01-15T12:00:00.000Z');
      const modifiedPath = join(testDir, 'modified.md');
      writeFileSync(
        modifiedPath,
        `---
page_id: '12345'
title: Modified
synced_at: '${syncedAt.toISOString()}'
---
Content`,
      );
      const modifiedTime = new Date(syncedAt.getTime() + 2000);
      utimesSync(modifiedPath, modifiedTime, modifiedTime);

      const candidates = detectPushCandidates(testDir);

      expect(candidates).toHaveLength(2);
      expect(candidates[0].path).toBe('modified.md');
      expect(candidates[1].path).toBe('new.md');
    });

    test('ignores unmodified files', () => {
      const syncedAt = new Date('2026-01-15T12:00:00.000Z');
      const content = `---
page_id: '12345'
title: Unmodified Page
synced_at: '${syncedAt.toISOString()}'
---

Content here.`;
      const filePath = join(testDir, 'unmodified.md');
      writeFileSync(filePath, content);

      // Set file mtime to BEFORE synced_at
      const olderTime = new Date(syncedAt.getTime() - 1000);
      utimesSync(filePath, olderTime, olderTime);

      const candidates = detectPushCandidates(testDir);

      expect(candidates).toHaveLength(0);
    });

    test('handles files in subdirectories', () => {
      mkdirSync(join(testDir, 'subfolder'));
      const content = `---
title: Nested Page
---

Content here.`;
      writeFileSync(join(testDir, 'subfolder', 'nested.md'), content);

      const candidates = detectPushCandidates(testDir);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].path).toBe('subfolder/nested.md');
    });
  });
});
