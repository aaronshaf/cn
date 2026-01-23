import { describe, expect, test } from 'bun:test';
import { HtmlConverter } from '../lib/markdown/html-converter.js';

describe('HtmlConverter', () => {
  test('converts simple markdown to HTML', () => {
    const converter = new HtmlConverter();
    const { html } = converter.convert('Hello **world**!');

    expect(html).toContain('<strong>world</strong>');
  });

  test('converts headings', () => {
    const converter = new HtmlConverter();
    const { html } = converter.convert('# Heading 1\n## Heading 2');

    expect(html).toContain('<h1>Heading 1</h1>');
    expect(html).toContain('<h2>Heading 2</h2>');
  });

  test('converts lists', () => {
    const converter = new HtmlConverter();
    const { html } = converter.convert('- Item 1\n- Item 2');

    expect(html).toContain('<ul>');
    expect(html).toContain('<li>');
    expect(html).toContain('Item 1');
  });

  test('converts inline formatting inside list items', () => {
    const converter = new HtmlConverter();
    const markdown =
      '- **[ger](https://github.com/aaronshaf/ger)** - Gerrit CLI for code review\n- **[jk](https://github.com/aaronshaf/jk)** - Jenkins CLI';
    const { html } = converter.convert(markdown);

    expect(html).toContain('<ul>');
    expect(html).toContain('<strong><a href="https://github.com/aaronshaf/ger">ger</a></strong>');
    expect(html).toContain('<strong><a href="https://github.com/aaronshaf/jk">jk</a></strong>');
    expect(html).toContain('Gerrit CLI for code review');
    expect(html).not.toContain('**[ger]'); // Should not contain raw markdown
  });

  test('converts italic and strikethrough', () => {
    const converter = new HtmlConverter();
    const { html } = converter.convert('Text with *italic* and ~~strikethrough~~ formatting.');

    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<del>strikethrough</del>');
  });

  test('converts line breaks and horizontal rules', () => {
    const converter = new HtmlConverter();
    const { html } = converter.convert('Line 1  \nLine 2\n\n---\n\nLine 3');

    expect(html).toContain('<br />');
    expect(html).toContain('<hr />');
  });

  test('converts links', () => {
    const converter = new HtmlConverter();
    const { html } = converter.convert('[Example](https://example.com)');

    expect(html).toContain('<a href="https://example.com">Example</a>');
  });

  test('converts code blocks to Confluence macro', () => {
    const converter = new HtmlConverter();
    const markdown = '```javascript\nconst x = 1;\n```';
    const { html } = converter.convert(markdown);

    expect(html).toContain('ac:structured-macro');
    expect(html).toContain('ac:name="code"');
    expect(html).toContain('javascript');
    expect(html).toContain('const x = 1;');
  });

  test('converts tables', () => {
    const converter = new HtmlConverter();
    const markdown = '| Col 1 | Col 2 |\n|-------|-------|\n| A | B |';
    const { html } = converter.convert(markdown);

    expect(html).toContain('<table>');
    expect(html).toContain('<th>Col 1</th>');
    expect(html).toContain('<td>A</td>');
  });

  test('converts blockquotes', () => {
    const converter = new HtmlConverter();
    const { html } = converter.convert('> This is a quote');

    expect(html).toContain('<blockquote>');
    expect(html).toContain('This is a quote');
  });

  test('converts info panel syntax to Confluence macro', () => {
    const converter = new HtmlConverter();
    const { html } = converter.convert('> **Info:** This is an info message');

    expect(html).toContain('ac:structured-macro');
    expect(html).toContain('ac:name="info"');
    expect(html).toContain('This is an info message');
  });

  test('ensures XHTML compliance with self-closing tags', () => {
    const converter = new HtmlConverter();
    const { html } = converter.convert('Line 1\n\nLine 2\n\n---');

    expect(html).toContain('<hr />');
    expect(html).not.toContain('<hr>');
  });

  test('warns about local image references', () => {
    const converter = new HtmlConverter();
    const { warnings } = converter.convert('![Image](./local-image.png)');

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes('local-image.png'))).toBe(true);
  });

  test('strips @ prefix from mentions', () => {
    const converter = new HtmlConverter();
    const { html, warnings } = converter.convert('Contact @user123 for help.');

    // @ should be stripped, leaving just the username
    expect(html).toContain('user123');
    expect(html).not.toContain('@user123');
    // No warning since we handle it by stripping
    expect(warnings.some((w) => w.includes('mentions'))).toBe(false);
  });

  test('does not strip @ from email addresses', () => {
    const converter = new HtmlConverter();
    const { html } = converter.convert('Email us at support@example.com for help.');

    // Email addresses should be preserved
    expect(html).toContain('support@example.com');
  });

  test('warns about task lists', () => {
    const converter = new HtmlConverter();
    const { warnings } = converter.convert('- [x] Done\n- [ ] Todo');

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes('Task list'))).toBe(true);
  });

  test('escapes CDATA sections in code blocks', () => {
    const converter = new HtmlConverter();
    const markdown = '```javascript\nconst x = "]]>";\n```';
    const { html } = converter.convert(markdown);

    // Should escape ]]> to prevent breaking CDATA
    expect(html).toContain(']]]]><![CDATA[>');
    expect(html).not.toContain('const x = "]]>";');
  });

  test('sanitizes language identifiers in code blocks', () => {
    const converter = new HtmlConverter();
    const markdown = '```javascript"><script>alert("xss")</script><x lang="evil\nconsole.log("test");\n```';
    const { html } = converter.convert(markdown);

    // Should strip dangerous characters from language (quotes, angle brackets, etc.)
    expect(html).not.toContain('"><script>');
    expect(html).not.toContain('<x lang="evil');
    // Should keep alphanumeric parts
    expect(html).toContain('javascript');
    // The sanitized version should only have safe characters
    expect(html).toMatch(/<ac:parameter ac:name="language">[a-zA-Z0-9\-_+]*<\/ac:parameter>/);
  });

  test('sanitizes script tags in HTML passthrough', () => {
    const converter = new HtmlConverter();
    // Use block-level HTML which marked processes through the html renderer
    const markdown = '<div>\nHello\n</div>\n<script>alert("xss")</script>\n<div>\nworld\n</div>';
    const { html, warnings } = converter.convert(markdown);

    // Should remove script tags
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('alert("xss")');
    expect(html).toContain('Hello');
    expect(html).toContain('world');
    // Should warn about sanitization
    expect(warnings.some((w) => w.includes('unsafe HTML'))).toBe(true);
  });

  test('sanitizes event handlers in HTML passthrough', () => {
    const converter = new HtmlConverter();
    const markdown = '<div onclick="alert(\'xss\')">Click me</div>';
    const { html, warnings } = converter.convert(markdown);

    // Should remove event handlers
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('alert');
    expect(html).toContain('Click me');
    // Should warn about sanitization
    expect(warnings.some((w) => w.includes('unsafe HTML'))).toBe(true);
  });

  test('sanitizes javascript: protocol in links', () => {
    const converter = new HtmlConverter();
    const markdown = '<a href="javascript:alert(\'xss\')">Click</a>';
    const { html, warnings } = converter.convert(markdown);

    // Should replace javascript: with safe URL
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="#"');
    expect(html).toContain('Click');
    // Should warn about sanitization
    expect(warnings.some((w) => w.includes('unsafe HTML'))).toBe(true);
  });

  test('allows safe HTML passthrough', () => {
    const converter = new HtmlConverter();
    const markdown = '<div class="highlight">Safe HTML</div>';
    const { html, warnings } = converter.convert(markdown);

    // Should pass through safe HTML
    expect(html).toContain('<div class="highlight">');
    expect(html).toContain('Safe HTML');
    // Should not warn
    expect(warnings.some((w) => w.includes('unsafe HTML'))).toBe(false);
  });

  test('converts relative .md links to Confluence page links', () => {
    const converter = new HtmlConverter();
    const pageLookupMap = {
      titleToPage: new Map(),
      idToPage: new Map([
        [
          'page-123',
          {
            pageId: 'page-123',
            version: 1,
            localPath: 'architecture/overview.md',
            title: 'Architecture Overview',
          },
        ],
      ]),
      pathToPage: new Map([
        [
          'architecture/overview.md',
          {
            pageId: 'page-123',
            version: 1,
            localPath: 'architecture/overview.md',
            title: 'Architecture Overview',
          },
        ],
      ]),
    };

    const markdown = 'See [Architecture](./architecture/overview.md) for details.';
    const { html } = converter.convert(markdown, '/test/space', 'home.md', 'TEST', pageLookupMap);

    expect(html).toContain('<ac:link>');
    expect(html).toContain('ri:page ri:content-title="Architecture Overview"');
    expect(html).toContain('ri:space-key="TEST"');
    expect(html).toContain('<ac:plain-text-link-body><![CDATA[Architecture]]></ac:plain-text-link-body>');
  });

  test('warns about broken local links', () => {
    const converter = new HtmlConverter();
    const pageLookupMap = {
      titleToPage: new Map(),
      idToPage: new Map(),
      pathToPage: new Map(),
    };

    const markdown = 'See [Missing](./non-existent.md).';
    const { warnings } = converter.convert(markdown, '/test/space', 'home.md', 'TEST', pageLookupMap);

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes('non-existent.md'))).toBe(true);
  });

  test('preserves external links unchanged', () => {
    const converter = new HtmlConverter();
    const pageLookupMap = {
      titleToPage: new Map(),
      idToPage: new Map(),
      pathToPage: new Map(),
    };

    const markdown = 'See [Google](https://google.com) and [Example](https://example.com/page.md).';
    const { html } = converter.convert(markdown, '/test/space', 'home.md', 'TEST', pageLookupMap);

    expect(html).toContain('<a href="https://google.com">Google</a>');
    expect(html).toContain('<a href="https://example.com/page.md">Example</a>');
    expect(html).not.toContain('<ac:link>');
  });

  test('properly escapes XML special characters in link titles', () => {
    const converter = new HtmlConverter();
    const pageLookupMap = {
      titleToPage: new Map(),
      idToPage: new Map([
        [
          'page-123',
          {
            pageId: 'page-123',
            version: 1,
            localPath: 'special.md',
            title: 'Page with <Special> & "Chars"',
          },
        ],
      ]),
      pathToPage: new Map([
        [
          'special.md',
          {
            pageId: 'page-123',
            version: 1,
            localPath: 'special.md',
            title: 'Page with <Special> & "Chars"',
          },
        ],
      ]),
    };

    const markdown = 'See [Special Page](./special.md).';
    const { html } = converter.convert(markdown, '/test/space', 'home.md', 'TEST', pageLookupMap);

    // Verify XML special characters are properly escaped
    expect(html).toContain('ri:content-title="Page with &lt;Special&gt; &amp; &quot;Chars&quot;"');
    expect(html).not.toContain('ri:content-title="Page with <Special> & "Chars""');
  });

  test('handles links in code blocks without converting them', () => {
    const converter = new HtmlConverter();
    const pageLookupMap = {
      titleToPage: new Map(),
      idToPage: new Map([
        [
          'page-123',
          {
            pageId: 'page-123',
            version: 1,
            localPath: 'page.md',
            title: 'Test Page',
          },
        ],
      ]),
      pathToPage: new Map([
        [
          'page.md',
          {
            pageId: 'page-123',
            version: 1,
            localPath: 'page.md',
            title: 'Test Page',
          },
        ],
      ]),
    };

    const markdown = '```\n[Link](./page.md)\n```';
    const { html } = converter.convert(markdown, '/test/space', 'home.md', 'TEST', pageLookupMap);

    // Links inside code blocks should NOT be converted to Confluence links
    expect(html).not.toContain('<ac:link>');
    expect(html).toContain('[Link](./page.md)');
  });

  test('handles inline code with link-like syntax without converting', () => {
    const converter = new HtmlConverter();
    const pageLookupMap = {
      titleToPage: new Map(),
      idToPage: new Map([
        [
          'page-123',
          {
            pageId: 'page-123',
            version: 1,
            localPath: 'page.md',
            title: 'Test Page',
          },
        ],
      ]),
      pathToPage: new Map([
        [
          'page.md',
          {
            pageId: 'page-123',
            version: 1,
            localPath: 'page.md',
            title: 'Test Page',
          },
        ],
      ]),
    };

    const markdown = 'Use the syntax `[Link](./page.md)` in markdown.';
    const { html } = converter.convert(markdown, '/test/space', 'home.md', 'TEST', pageLookupMap);

    // Inline code should NOT be converted
    expect(html).toContain('<code>[Link](./page.md)</code>');
    // But if we have a real link, it should be converted
    expect(html.match(/<ac:link>/g)).toBeNull();
  });
});
