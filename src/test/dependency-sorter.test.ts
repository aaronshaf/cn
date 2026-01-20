import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractLocalLinks, sortByDependencies } from '../lib/dependency-sorter.js';
import type { PushCandidate } from '../lib/file-scanner.js';

describe('dependency-sorter', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cn-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('extractLocalLinks', () => {
    test('extracts simple markdown links to .md files', () => {
      const content = 'Check out [my page](other-page.md) for more info.';

      const links = extractLocalLinks(content);

      expect(links).toEqual(['other-page.md']);
    });

    test('extracts multiple links', () => {
      const content = `
# Documentation

See [intro](intro.md) for getting started.
Then read [guide](guide.md) for details.
`;

      const links = extractLocalLinks(content);

      expect(links).toEqual(['intro.md', 'guide.md']);
    });

    test('extracts links with relative paths', () => {
      const content = 'See [parent](../parent.md) and [child](subdir/child.md).';

      const links = extractLocalLinks(content);

      expect(links).toEqual(['../parent.md', 'subdir/child.md']);
    });

    test('ignores http links', () => {
      const content = 'See [external](http://example.com/page.md) for more.';

      const links = extractLocalLinks(content);

      expect(links).toEqual([]);
    });

    test('ignores https links', () => {
      const content = 'See [secure](https://example.com/page.md) for more.';

      const links = extractLocalLinks(content);

      expect(links).toEqual([]);
    });

    test('removes anchor fragments from links', () => {
      const content = 'See [section](guide.md#installation) for setup.';

      const links = extractLocalLinks(content);

      expect(links).toEqual(['guide.md']);
    });

    test('handles nested brackets in link text', () => {
      const content = 'See [text [nested]](page.md) for info.';

      const links = extractLocalLinks(content);

      expect(links).toEqual(['page.md']);
    });

    test('returns empty array for content with no links', () => {
      const content = '# Just a heading\n\nSome plain text.';

      const links = extractLocalLinks(content);

      expect(links).toEqual([]);
    });

    test('returns empty array for links to non-md files', () => {
      const content = 'See [image](photo.png) and [doc](file.pdf).';

      const links = extractLocalLinks(content);

      expect(links).toEqual([]);
    });
  });

  describe('sortByDependencies', () => {
    function createCandidate(path: string, type: 'new' | 'modified' = 'new'): PushCandidate {
      return {
        path,
        type,
        title: path.replace('.md', ''),
      };
    }

    test('returns original order when no files have links', () => {
      writeFileSync(join(testDir, 'a.md'), '# File A');
      writeFileSync(join(testDir, 'b.md'), '# File B');
      writeFileSync(join(testDir, 'c.md'), '# File C');

      const candidates: PushCandidate[] = [createCandidate('a.md'), createCandidate('b.md'), createCandidate('c.md')];

      const { sorted, cycles } = sortByDependencies(candidates, testDir);

      expect(cycles).toEqual([]);
      expect(sorted.map((c) => c.path)).toEqual(['a.md', 'b.md', 'c.md']);
    });

    test('sorts linear chain so dependencies come first', () => {
      // A links to B, B links to C
      // Expected order: C, B, A
      writeFileSync(join(testDir, 'a.md'), '# A\nSee [B](b.md)');
      writeFileSync(join(testDir, 'b.md'), '# B\nSee [C](c.md)');
      writeFileSync(join(testDir, 'c.md'), '# C');

      const candidates: PushCandidate[] = [createCandidate('a.md'), createCandidate('b.md'), createCandidate('c.md')];

      const { sorted, cycles } = sortByDependencies(candidates, testDir);

      expect(cycles).toEqual([]);
      expect(sorted.map((c) => c.path)).toEqual(['c.md', 'b.md', 'a.md']);
    });

    test('handles diamond dependency pattern', () => {
      // A -> B, A -> C, B -> D, C -> D
      // Expected: D first, then B and C (in any order), then A
      writeFileSync(join(testDir, 'a.md'), '# A\nSee [B](b.md) and [C](c.md)');
      writeFileSync(join(testDir, 'b.md'), '# B\nSee [D](d.md)');
      writeFileSync(join(testDir, 'c.md'), '# C\nSee [D](d.md)');
      writeFileSync(join(testDir, 'd.md'), '# D');

      const candidates: PushCandidate[] = [
        createCandidate('a.md'),
        createCandidate('b.md'),
        createCandidate('c.md'),
        createCandidate('d.md'),
      ];

      const { sorted, cycles } = sortByDependencies(candidates, testDir);

      expect(cycles).toEqual([]);

      const paths = sorted.map((c) => c.path);
      // D must come before B and C
      expect(paths.indexOf('d.md')).toBeLessThan(paths.indexOf('b.md'));
      expect(paths.indexOf('d.md')).toBeLessThan(paths.indexOf('c.md'));
      // B and C must come before A
      expect(paths.indexOf('b.md')).toBeLessThan(paths.indexOf('a.md'));
      expect(paths.indexOf('c.md')).toBeLessThan(paths.indexOf('a.md'));
    });

    test('detects and reports simple circular dependency', () => {
      // A -> B, B -> A
      writeFileSync(join(testDir, 'a.md'), '# A\nSee [B](b.md)');
      writeFileSync(join(testDir, 'b.md'), '# B\nSee [A](a.md)');

      const candidates: PushCandidate[] = [createCandidate('a.md'), createCandidate('b.md')];

      const { sorted, cycles } = sortByDependencies(candidates, testDir);

      // Should detect cycle
      expect(cycles.length).toBeGreaterThan(0);
      // Both files should still be in output
      expect(sorted).toHaveLength(2);
    });

    test('detects longer cycles', () => {
      // A -> B -> C -> A
      writeFileSync(join(testDir, 'a.md'), '# A\nSee [B](b.md)');
      writeFileSync(join(testDir, 'b.md'), '# B\nSee [C](c.md)');
      writeFileSync(join(testDir, 'c.md'), '# C\nSee [A](a.md)');

      const candidates: PushCandidate[] = [createCandidate('a.md'), createCandidate('b.md'), createCandidate('c.md')];

      const { sorted, cycles } = sortByDependencies(candidates, testDir);

      expect(cycles.length).toBeGreaterThan(0);
      // All files should still be in output
      expect(sorted).toHaveLength(3);
    });

    test('ignores links to files not in candidates', () => {
      // A links to B (candidate) and X (not a candidate)
      writeFileSync(join(testDir, 'a.md'), '# A\nSee [B](b.md) and [X](x.md)');
      writeFileSync(join(testDir, 'b.md'), '# B');
      writeFileSync(join(testDir, 'x.md'), '# X (already synced)');

      const candidates: PushCandidate[] = [createCandidate('a.md'), createCandidate('b.md')];

      const { sorted, cycles } = sortByDependencies(candidates, testDir);

      expect(cycles).toEqual([]);
      // B should come before A because A depends on B
      expect(sorted.map((c) => c.path)).toEqual(['b.md', 'a.md']);
    });

    test('handles links in subdirectories', () => {
      mkdirSync(join(testDir, 'docs'));

      // docs/a.md links to docs/b.md
      writeFileSync(join(testDir, 'docs', 'a.md'), '# A\nSee [B](b.md)');
      writeFileSync(join(testDir, 'docs', 'b.md'), '# B');

      const candidates: PushCandidate[] = [createCandidate('docs/a.md'), createCandidate('docs/b.md')];

      const { sorted, cycles } = sortByDependencies(candidates, testDir);

      expect(cycles).toEqual([]);
      expect(sorted.map((c) => c.path)).toEqual(['docs/b.md', 'docs/a.md']);
    });

    test('handles cross-directory links', () => {
      mkdirSync(join(testDir, 'guides'));
      mkdirSync(join(testDir, 'reference'));

      // guides/a.md links to reference/b.md
      writeFileSync(join(testDir, 'guides', 'a.md'), '# A\nSee [B](../reference/b.md)');
      writeFileSync(join(testDir, 'reference', 'b.md'), '# B');

      const candidates: PushCandidate[] = [createCandidate('guides/a.md'), createCandidate('reference/b.md')];

      const { sorted, cycles } = sortByDependencies(candidates, testDir);

      expect(cycles).toEqual([]);
      expect(sorted.map((c) => c.path)).toEqual(['reference/b.md', 'guides/a.md']);
    });

    test('handles empty candidate list', () => {
      const { sorted, cycles } = sortByDependencies([], testDir);

      expect(sorted).toEqual([]);
      expect(cycles).toEqual([]);
    });

    test('handles single candidate with no links', () => {
      writeFileSync(join(testDir, 'only.md'), '# Only file');

      const candidates: PushCandidate[] = [createCandidate('only.md')];

      const { sorted, cycles } = sortByDependencies(candidates, testDir);

      expect(cycles).toEqual([]);
      expect(sorted).toEqual(candidates);
    });

    test('handles single candidate with self-link', () => {
      writeFileSync(join(testDir, 'self.md'), '# Self\nSee [Self](self.md)');

      const candidates: PushCandidate[] = [createCandidate('self.md')];

      const { sorted, cycles } = sortByDependencies(candidates, testDir);

      // Self-link creates a cycle
      expect(cycles.length).toBeGreaterThan(0);
      expect(sorted).toHaveLength(1);
    });

    test('preserves candidate type and title', () => {
      writeFileSync(join(testDir, 'new.md'), '# New\nSee [modified](modified.md)');
      writeFileSync(join(testDir, 'modified.md'), '# Modified');

      const candidates: PushCandidate[] = [
        { path: 'new.md', type: 'new', title: 'New Page' },
        { path: 'modified.md', type: 'modified', title: 'Modified Page', pageId: '123' },
      ];

      const { sorted } = sortByDependencies(candidates, testDir);

      // modified.md should come first (dependency)
      expect(sorted[0]).toEqual({
        path: 'modified.md',
        type: 'modified',
        title: 'Modified Page',
        pageId: '123',
      });
      expect(sorted[1]).toEqual({
        path: 'new.md',
        type: 'new',
        title: 'New Page',
      });
    });

    test('handles mixed candidates with and without dependencies', () => {
      // A -> B, C has no links, D -> E
      writeFileSync(join(testDir, 'a.md'), '# A\nSee [B](b.md)');
      writeFileSync(join(testDir, 'b.md'), '# B');
      writeFileSync(join(testDir, 'c.md'), '# C (independent)');
      writeFileSync(join(testDir, 'd.md'), '# D\nSee [E](e.md)');
      writeFileSync(join(testDir, 'e.md'), '# E');

      const candidates: PushCandidate[] = [
        createCandidate('a.md'),
        createCandidate('b.md'),
        createCandidate('c.md'),
        createCandidate('d.md'),
        createCandidate('e.md'),
      ];

      const { sorted, cycles } = sortByDependencies(candidates, testDir);

      expect(cycles).toEqual([]);

      const paths = sorted.map((c) => c.path);
      // B before A
      expect(paths.indexOf('b.md')).toBeLessThan(paths.indexOf('a.md'));
      // E before D
      expect(paths.indexOf('e.md')).toBeLessThan(paths.indexOf('d.md'));
      // All files included
      expect(paths).toHaveLength(5);
    });

    test('gracefully handles unreadable files', () => {
      writeFileSync(join(testDir, 'readable.md'), '# Readable\nSee [unreadable](unreadable.md)');
      // unreadable.md doesn't exist as a file, but is in candidates

      const candidates: PushCandidate[] = [createCandidate('readable.md'), createCandidate('unreadable.md')];

      // Should not throw, even though unreadable.md can't be read
      const { sorted, cycles } = sortByDependencies(candidates, testDir);

      expect(cycles).toEqual([]);
      expect(sorted).toHaveLength(2);
    });
  });
});
