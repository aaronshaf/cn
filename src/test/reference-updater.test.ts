import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateReferencesAfterRename } from '../lib/markdown/reference-updater.js';

describe('updateReferencesAfterRename', () => {
  let testDir: string;

  beforeEach(() => {
    // Create a temporary directory for each test
    testDir = mkdtempSync(join(tmpdir(), 'cn-test-'));
  });

  afterEach(() => {
    // Clean up test directory
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('updates single reference in one file', () => {
    // Create files
    writeFileSync(
      join(testDir, 'page1.md'),
      `---
title: Page 1
---

See [Page 2](./page2.md) for more info.
`,
    );

    writeFileSync(
      join(testDir, 'page2.md'),
      `---
title: Page 2
---

Content here.
`,
    );

    // Rename page2.md to page2-renamed.md
    const results = updateReferencesAfterRename(testDir, 'page2.md', 'page2-renamed.md');

    // Verify results
    expect(results.length).toBe(1);
    expect(results[0].filePath).toBe('page1.md');
    expect(results[0].updatedCount).toBe(1);

    // Verify file content was updated
    const content = readFileSync(join(testDir, 'page1.md'), 'utf-8');
    expect(content).toContain('[Page 2](./page2-renamed.md)');
    expect(content).not.toContain('[Page 2](./page2.md)');
  });

  test('updates multiple references in one file', () => {
    writeFileSync(
      join(testDir, 'page1.md'),
      `---
title: Page 1
---

See [Page 2](./page2.md) for more info.
Also check out [this link](./page2.md) again.
And [another reference](./page2.md).
`,
    );

    writeFileSync(join(testDir, 'page2.md'), '# Page 2');

    const results = updateReferencesAfterRename(testDir, 'page2.md', 'page2-renamed.md');

    expect(results.length).toBe(1);
    expect(results[0].updatedCount).toBe(3);

    const content = readFileSync(join(testDir, 'page1.md'), 'utf-8');
    const matches = content.match(/\(\.\/page2-renamed\.md\)/g);
    expect(matches?.length).toBe(3);
  });

  test('updates references in multiple files', () => {
    writeFileSync(join(testDir, 'page1.md'), 'Check [Page 3](./page3.md).');
    writeFileSync(join(testDir, 'page2.md'), 'See [Page 3](./page3.md).');
    writeFileSync(join(testDir, 'page3.md'), '# Page 3');

    const results = updateReferencesAfterRename(testDir, 'page3.md', 'page3-renamed.md');

    expect(results.length).toBe(2);
    expect(results.map((r) => r.filePath).sort()).toEqual(['page1.md', 'page2.md']);

    const content1 = readFileSync(join(testDir, 'page1.md'), 'utf-8');
    const content2 = readFileSync(join(testDir, 'page2.md'), 'utf-8');
    expect(content1).toContain('./page3-renamed.md');
    expect(content2).toContain('./page3-renamed.md');
  });

  test('handles nested directories', () => {
    mkdirSync(join(testDir, 'architecture'));

    writeFileSync(join(testDir, 'home.md'), 'See [Overview](./architecture/overview.md).');
    writeFileSync(join(testDir, 'architecture', 'overview.md'), '# Overview');

    const results = updateReferencesAfterRename(
      testDir,
      'architecture/overview.md',
      'architecture/overview-renamed.md',
    );

    expect(results.length).toBe(1);
    expect(results[0].filePath).toBe('home.md');

    const content = readFileSync(join(testDir, 'home.md'), 'utf-8');
    expect(content).toContain('./architecture/overview-renamed.md');
  });

  test('handles relative paths from subdirectories', () => {
    mkdirSync(join(testDir, 'docs'));
    mkdirSync(join(testDir, 'architecture'));

    writeFileSync(join(testDir, 'docs', 'guide.md'), 'See [Overview](../architecture/overview.md).');
    writeFileSync(join(testDir, 'architecture', 'overview.md'), '# Overview');

    const results = updateReferencesAfterRename(
      testDir,
      'architecture/overview.md',
      'architecture/overview-renamed.md',
    );

    expect(results.length).toBe(1);
    expect(results[0].filePath).toBe('docs/guide.md');

    const content = readFileSync(join(testDir, 'docs', 'guide.md'), 'utf-8');
    expect(content).toContain('../architecture/overview-renamed.md');
  });

  test('returns empty array when no references found', () => {
    writeFileSync(join(testDir, 'page1.md'), 'No references here.');
    writeFileSync(join(testDir, 'page2.md'), '# Page 2');

    const results = updateReferencesAfterRename(testDir, 'page2.md', 'page2-renamed.md');

    expect(results.length).toBe(0);
  });

  test('does not update the renamed file itself', () => {
    writeFileSync(join(testDir, 'page1.md'), 'See [myself](./page1.md).');

    const results = updateReferencesAfterRename(testDir, 'page1.md', 'page1-renamed.md');

    expect(results.length).toBe(0);
  });

  test('preserves frontmatter when updating references', () => {
    writeFileSync(
      join(testDir, 'page1.md'),
      `---
page_id: "123"
title: "Page 1"
version: 5
---

See [Page 2](./page2.md).
`,
    );

    writeFileSync(join(testDir, 'page2.md'), '# Page 2');

    updateReferencesAfterRename(testDir, 'page2.md', 'page2-renamed.md');

    const content = readFileSync(join(testDir, 'page1.md'), 'utf-8');
    // gray-matter converts double quotes to single quotes, which is valid YAML
    expect(content).toMatch(/page_id:\s+['"]123['"]/);
    expect(content).toMatch(/title:\s+['"]?Page 1['"]?/);
    expect(content).toContain('version: 5');
    expect(content).toContain('./page2-renamed.md');
  });

  test('handles files with special characters in link text', () => {
    writeFileSync(join(testDir, 'page1.md'), 'See [Special (Page) [2]](./page2.md).');
    writeFileSync(join(testDir, 'page2.md'), '# Page 2');

    const results = updateReferencesAfterRename(testDir, 'page2.md', 'page2-renamed.md');

    expect(results.length).toBe(1);

    const content = readFileSync(join(testDir, 'page1.md'), 'utf-8');
    expect(content).toContain('[Special (Page) [2]](./page2-renamed.md)');
  });

  test('ignores external links', () => {
    writeFileSync(
      join(testDir, 'page1.md'),
      `See [External](https://example.com/page2.md).
Also [Local](./page2.md).`,
    );

    writeFileSync(join(testDir, 'page2.md'), '# Page 2');

    const _results = updateReferencesAfterRename(testDir, 'page2.md', 'page2-renamed.md');

    const content = readFileSync(join(testDir, 'page1.md'), 'utf-8');
    expect(content).toContain('https://example.com/page2.md'); // Should not change
    expect(content).toContain('./page2-renamed.md'); // Should change
  });

  test('handles move to subdirectory', () => {
    mkdirSync(join(testDir, 'architecture'));

    writeFileSync(join(testDir, 'home.md'), 'See [Overview](./overview.md).');
    writeFileSync(join(testDir, 'overview.md'), '# Overview');

    const results = updateReferencesAfterRename(testDir, 'overview.md', 'architecture/overview.md');

    expect(results.length).toBe(1);

    const content = readFileSync(join(testDir, 'home.md'), 'utf-8');
    expect(content).toContain('./architecture/overview.md');
  });

  test('handles move from subdirectory to root', () => {
    mkdirSync(join(testDir, 'architecture'));

    writeFileSync(join(testDir, 'home.md'), 'See [Overview](./architecture/overview.md).');
    writeFileSync(join(testDir, 'architecture', 'overview.md'), '# Overview');

    const results = updateReferencesAfterRename(testDir, 'architecture/overview.md', 'overview.md');

    expect(results.length).toBe(1);

    const content = readFileSync(join(testDir, 'home.md'), 'utf-8');
    expect(content).toContain('./overview.md');
  });
});
