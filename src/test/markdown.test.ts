import { describe, expect, test } from 'bun:test';
import { MarkdownConverter } from '../lib/markdown/converter.js';
import { slugify, generateUniqueFilename } from '../lib/markdown/slugify.js';
import { createFrontmatter, serializeMarkdown, parseMarkdown, extractPageId } from '../lib/markdown/frontmatter.js';

describe('slugify', () => {
  test('converts title to lowercase', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  test('replaces spaces with hyphens', () => {
    expect(slugify('hello world test')).toBe('hello-world-test');
  });

  test('removes special characters', () => {
    expect(slugify('Hello! World?')).toBe('hello-world');
    expect(slugify('Test (with) [brackets]')).toBe('test-with-brackets');
  });

  test('collapses multiple hyphens', () => {
    expect(slugify('hello---world')).toBe('hello-world');
    expect(slugify('test - - test')).toBe('test-test');
  });

  test('trims hyphens from start and end', () => {
    expect(slugify('  hello world  ')).toBe('hello-world');
    expect(slugify('-hello-world-')).toBe('hello-world');
  });

  test('handles empty string', () => {
    expect(slugify('')).toBe('');
  });

  test('handles string with only special characters', () => {
    expect(slugify('!@#$%')).toBe('');
  });
});

describe('generateUniqueFilename', () => {
  test('returns simple filename when no conflicts', () => {
    const existing = new Set<string>();
    expect(generateUniqueFilename('Hello World', existing)).toBe('hello-world.md');
  });

  test('appends counter for conflicts', () => {
    const existing = new Set(['hello-world.md']);
    expect(generateUniqueFilename('Hello World', existing)).toBe('hello-world-2.md');
  });

  test('increments counter for multiple conflicts', () => {
    const existing = new Set(['hello-world.md', 'hello-world-2.md', 'hello-world-3.md']);
    expect(generateUniqueFilename('Hello World', existing)).toBe('hello-world-4.md');
  });

  test('supports custom extension', () => {
    const existing = new Set<string>();
    expect(generateUniqueFilename('test', existing, '.txt')).toBe('test.txt');
  });
});

describe('createFrontmatter', () => {
  test('creates frontmatter from page', () => {
    const page = {
      id: 'page-123',
      title: 'Test Page',
      spaceId: 'space-123',
      parentId: 'page-parent',
      authorId: 'user-123',
      createdAt: '2024-01-01T00:00:00Z',
      version: {
        number: 1,
        createdAt: '2024-01-01T00:00:00Z',
        authorId: 'user-456',
      },
      _links: {
        webui: '/spaces/TEST/pages/page-123',
      },
    };

    const frontmatter = createFrontmatter(page, 'TEST', [], 'Parent Page', 'https://test.atlassian.net');

    expect(frontmatter.page_id).toBe('page-123');
    expect(frontmatter.title).toBe('Test Page');
    expect(frontmatter.space_key).toBe('TEST');
    expect(frontmatter.version).toBe(1);
    expect(frontmatter.parent_id).toBe('page-parent');
    expect(frontmatter.parent_title).toBe('Parent Page');
    expect(frontmatter.url).toBe('https://test.atlassian.net/wiki/spaces/TEST/pages/page-123');
    expect(frontmatter.synced_at).toBeDefined();
  });

  test('includes labels', () => {
    const page = {
      id: 'page-123',
      title: 'Test Page',
      spaceId: 'space-123',
    };

    const labels = [
      { id: 'label-1', name: 'important' },
      { id: 'label-2', name: 'draft' },
    ];

    const frontmatter = createFrontmatter(page, 'TEST', labels);

    expect(frontmatter.labels).toEqual(['important', 'draft']);
  });
});

describe('serializeMarkdown and parseMarkdown', () => {
  test('serializes and parses markdown with frontmatter', () => {
    const frontmatter = {
      page_id: 'page-123',
      title: 'Test Page',
      space_key: 'TEST',
      synced_at: '2024-01-01T00:00:00Z',
    };
    const content = '# Hello World\n\nThis is test content.';

    const markdown = serializeMarkdown(frontmatter, content);
    const parsed = parseMarkdown(markdown);

    expect(parsed.frontmatter.page_id).toBe('page-123');
    expect(parsed.frontmatter.title).toBe('Test Page');
    expect(parsed.content.trim()).toBe(content);
  });

  test('handles empty content', () => {
    const frontmatter = {
      page_id: 'page-123',
      title: 'Empty Page',
      space_key: 'TEST',
      synced_at: '2024-01-01T00:00:00Z',
    };

    const markdown = serializeMarkdown(frontmatter, '');
    const parsed = parseMarkdown(markdown);

    expect(parsed.frontmatter.page_id).toBe('page-123');
    expect(parsed.content.trim()).toBe('');
  });
});

describe('extractPageId', () => {
  test('extracts page ID from markdown', () => {
    const markdown = `---
page_id: page-123
title: Test
---

Content here`;

    expect(extractPageId(markdown)).toBe('page-123');
  });

  test('returns undefined when no frontmatter', () => {
    const markdown = '# Just content\n\nNo frontmatter here.';
    expect(extractPageId(markdown)).toBeUndefined();
  });

  test('returns undefined when no page_id in frontmatter', () => {
    const markdown = `---
title: Test
---

Content`;

    expect(extractPageId(markdown)).toBeUndefined();
  });
});

describe('MarkdownConverter', () => {
  test('converts simple HTML to markdown', () => {
    const converter = new MarkdownConverter();
    const html = '<p>Hello <strong>world</strong>!</p>';
    const markdown = converter.convert(html);

    expect(markdown).toContain('Hello');
    expect(markdown).toContain('**world**');
  });

  test('converts headings', () => {
    const converter = new MarkdownConverter();
    const html = '<h1>Title</h1><h2>Subtitle</h2>';
    const markdown = converter.convert(html);

    expect(markdown).toContain('# Title');
    expect(markdown).toContain('## Subtitle');
  });

  test('converts lists', () => {
    const converter = new MarkdownConverter();
    const html = '<ul><li>Item 1</li><li>Item 2</li></ul>';
    const markdown = converter.convert(html);

    // Turndown uses 3 spaces after bullet marker
    expect(markdown).toContain('-   Item 1');
    expect(markdown).toContain('-   Item 2');
  });

  test('converts links', () => {
    const converter = new MarkdownConverter();
    const html = '<a href="https://example.com">Link</a>';
    const markdown = converter.convert(html);

    expect(markdown).toContain('[Link](https://example.com)');
  });

  test('handles code blocks', () => {
    const converter = new MarkdownConverter();
    const html = '<pre><code>const x = 1;</code></pre>';
    const markdown = converter.convert(html);

    expect(markdown).toContain('const x = 1;');
  });

  test('converts tables with GFM plugin', () => {
    const converter = new MarkdownConverter();
    const html = `
      <table>
        <thead>
          <tr><th>Col 1</th><th>Col 2</th></tr>
        </thead>
        <tbody>
          <tr><td>A</td><td>B</td></tr>
        </tbody>
      </table>
    `;
    const markdown = converter.convert(html);

    expect(markdown).toContain('Col 1');
    expect(markdown).toContain('Col 2');
    expect(markdown).toContain('|');
  });

  test('removes empty paragraphs', () => {
    const converter = new MarkdownConverter();
    const html = '<p></p><p>Content</p><p></p>';
    const markdown = converter.convert(html);

    expect(markdown.trim()).toBe('Content');
  });

  test('convertPage creates markdown with frontmatter', () => {
    const converter = new MarkdownConverter();
    const page = {
      id: 'page-123',
      title: 'Test Page',
      spaceId: 'space-123',
      body: {
        storage: {
          value: '<p>Hello World</p>',
        },
      },
    };

    const { markdown } = converter.convertPage(page, 'TEST');

    expect(markdown).toContain('page_id: page-123');
    expect(markdown).toContain('title: Test Page');
    expect(markdown).toContain('Hello World');
  });

  test('converts Confluence user references to @mentions', () => {
    const converter = new MarkdownConverter();
    const html = `
      <p>Contact <ac:link><ri:user ri:account-id="5f123abc" /></ac:link> for help.</p>
    `;
    const markdown = converter.convert(html);

    expect(markdown).toContain('@5f123abc');
    expect(markdown).not.toContain('ac:link');
    expect(markdown).not.toContain('ri:user');
  });

  test('converts standalone ri:user elements to @mentions', () => {
    const converter = new MarkdownConverter();
    const html = `
      <table>
        <tr><td><ri:user ri:account-id="user123" /></td></tr>
      </table>
    `;
    const markdown = converter.convert(html);

    expect(markdown).toContain('@user123');
    expect(markdown).not.toContain('ri:user');
  });
});
