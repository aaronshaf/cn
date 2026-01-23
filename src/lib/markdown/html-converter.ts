import { Marked, type Tokens, type Renderer } from 'marked';
import { relativePathToConfluenceLink, type PageLookupMap } from './link-converter.js';

/**
 * HTML converter that transforms Markdown to Confluence Storage Format
 * Inverse of MarkdownConverter - used for pushing local changes to Confluence
 * Per ADR-0022: Converts relative markdown links to Confluence page links
 */
export class HtmlConverter {
  private warnings: string[] = [];
  private spaceRoot: string = '';
  private currentPagePath: string = '';
  private spaceKey: string = '';
  private pageLookupMap: PageLookupMap | null = null;

  /**
   * Escape special XML characters for use in attributes
   * Converts: & < > " ' to their XML entity equivalents
   * @param text - Text to escape
   * @returns XML-safe text
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Escape CDATA sections by replacing ]]> with ]]]]><![CDATA[>
   * This allows code containing ]]> to be safely embedded in CDATA
   * @param text - Text to escape
   * @returns CDATA-safe text
   */
  private escapeCdata(text: string): string {
    return text.replace(/]]>/g, ']]]]><![CDATA[>');
  }

  /**
   * Validate and sanitize language identifier for code blocks
   * Only allows alphanumeric, dash, underscore, and plus
   * @param lang - Language identifier from code fence (e.g., "javascript", "python")
   * @returns Sanitized language string safe for XML attributes
   */
  private sanitizeLanguage(lang: string | undefined): string {
    if (!lang) return '';
    // Allow only safe characters for language identifiers
    return lang.replace(/[^a-zA-Z0-9\-_+]/g, '');
  }

  /**
   * Create a configured Marked instance with custom renderer
   * Uses marked v12+ token-based API
   */
  private createMarkedInstance(): Marked {
    const self = this;

    const renderer: Partial<Renderer> = {
      // Code blocks - use Confluence code macro for syntax highlighting
      code(this: Renderer, token: Tokens.Code): string {
        const language = self.sanitizeLanguage(token.lang);
        const escapedCode = self.escapeCdata(token.text);
        return `<ac:structured-macro ac:name="code" ac:schema-version="1">
<ac:parameter ac:name="language">${language}</ac:parameter>
<ac:plain-text-body><![CDATA[${escapedCode}]]></ac:plain-text-body>
</ac:structured-macro>\n`;
      },

      // Blockquotes - convert to Confluence info panel for better visibility
      blockquote(this: Renderer, token: Tokens.Blockquote): string {
        // Parse inner tokens to get HTML content
        const innerHtml = this.parser.parse(token.tokens);

        // Check if this is a special panel (Info:, Note:, Warning:, Tip:)
        const panelMatch = innerHtml.match(/^<p>\s*<strong>(Info|Note|Warning|Tip):<\/strong>\s*/i);
        if (panelMatch) {
          const panelType = panelMatch[1].toLowerCase();
          const content = innerHtml.replace(panelMatch[0], '<p>');
          return `<ac:structured-macro ac:name="${panelType}" ac:schema-version="1">
<ac:rich-text-body>${content}</ac:rich-text-body>
</ac:structured-macro>\n`;
        }
        // Regular blockquote - just use standard HTML
        return `<blockquote>${innerHtml}</blockquote>\n`;
      },

      // Tables - standard XHTML tables work in Confluence
      table(this: Renderer, token: Tokens.Table): string {
        let header = '<tr>';
        for (const cell of token.header) {
          const align = cell.align ? ` style="text-align:${cell.align}"` : '';
          const content = this.parser.parseInline(cell.tokens);
          header += `<th${align}>${content}</th>`;
        }
        header += '</tr>\n';

        let body = '';
        for (const row of token.rows) {
          body += '<tr>';
          for (const cell of row) {
            const align = cell.align ? ` style="text-align:${cell.align}"` : '';
            const content = this.parser.parseInline(cell.tokens);
            body += `<td${align}>${content}</td>`;
          }
          body += '</tr>\n';
        }

        return `<table>
<thead>${header}</thead>
<tbody>${body}</tbody>
</table>\n`;
      },

      // Links - convert relative .md links to Confluence page links (ADR-0022)
      link(this: Renderer, token: Tokens.Link): string {
        const text = this.parser.parseInline(token.tokens);

        // Check if this is a relative .md link (local page reference)
        if (token.href.endsWith('.md') && !token.href.startsWith('http://') && !token.href.startsWith('https://')) {
          // Try to convert to Confluence page link - requires full context
          if (self.pageLookupMap && self.currentPagePath && self.spaceRoot && self.spaceKey) {
            const linkInfo = relativePathToConfluenceLink(
              token.href,
              self.currentPagePath,
              self.spaceRoot,
              self.pageLookupMap,
            );

            if (linkInfo?.title) {
              // Generate Confluence page link format
              return `<ac:link>
  <ri:page ri:content-title="${self.escapeXml(linkInfo.title)}" ri:space-key="${self.spaceKey}" />
  <ac:plain-text-link-body><![CDATA[${text}]]></ac:plain-text-link-body>
</ac:link>`;
            }

            // Target not found or missing title - warn and fall through to standard HTML link
            if (linkInfo && !linkInfo.title) {
              self.warnings.push(`Link to "${token.href}" has missing title in sync state - preserving as HTML link`);
            } else {
              self.warnings.push(`Link to "${token.href}" could not be resolved - target page not found in sync state`);
            }
          } else if (process.env.DEBUG) {
            // DEBUG mode: warn about missing context for link conversion
            const missingContext = [];
            if (!self.pageLookupMap) missingContext.push('pageLookupMap');
            if (!self.currentPagePath) missingContext.push('currentPagePath');
            if (!self.spaceRoot) missingContext.push('spaceRoot');
            if (!self.spaceKey) missingContext.push('spaceKey');
            console.warn(`DEBUG: Link "${token.href}" not converted - missing context: ${missingContext.join(', ')}`);
          }
          // If missing context (pageLookupMap, etc.), silently fall through to standard HTML link
          // This handles cases where conversion wasn't set up (e.g., standalone markdown processing)
        }

        // External link or fallback - use standard HTML
        const titleAttr = token.title ? ` title="${self.escapeXml(token.title)}"` : '';
        return `<a href="${self.escapeXml(token.href)}"${titleAttr}>${text}</a>`;
      },

      // Images - standard HTML, warn about local images
      image(this: Renderer, token: Tokens.Image): string {
        // Warn about non-URL images (local references)
        if (!token.href.startsWith('http://') && !token.href.startsWith('https://')) {
          self.warnings.push(`Local image "${token.href}" will not display in Confluence. Use absolute URLs.`);
        }
        const alt = token.text ? ` alt="${self.escapeXml(token.text)}"` : '';
        const titleAttr = token.title ? ` title="${self.escapeXml(token.title)}"` : '';
        return `<img src="${self.escapeXml(token.href)}"${alt}${titleAttr} />`;
      },

      // Paragraphs
      paragraph(this: Renderer, token: Tokens.Paragraph): string {
        const text = this.parser.parseInline(token.tokens);
        return `<p>${text}</p>\n`;
      },

      // Headings
      heading(this: Renderer, token: Tokens.Heading): string {
        const text = this.parser.parseInline(token.tokens);
        return `<h${token.depth}>${text}</h${token.depth}>\n`;
      },

      // Bold
      strong(this: Renderer, token: Tokens.Strong): string {
        const text = this.parser.parseInline(token.tokens);
        return `<strong>${text}</strong>`;
      },

      // Italic
      em(this: Renderer, token: Tokens.Em): string {
        const text = this.parser.parseInline(token.tokens);
        return `<em>${text}</em>`;
      },

      // Strikethrough
      del(this: Renderer, token: Tokens.Del): string {
        const text = this.parser.parseInline(token.tokens);
        return `<del>${text}</del>`;
      },

      // Inline code
      codespan(this: Renderer, token: Tokens.Codespan): string {
        return `<code>${self.escapeXml(token.text)}</code>`;
      },

      // Line breaks
      br(this: Renderer): string {
        return '<br />';
      },

      // Horizontal rule
      hr(this: Renderer): string {
        return '<hr />\n';
      },

      // Lists
      list(this: Renderer, token: Tokens.List): string {
        const tag = token.ordered ? 'ol' : 'ul';
        const startAttr = token.ordered && token.start !== 1 ? ` start="${token.start}"` : '';
        let body = '';
        for (const item of token.items) {
          let itemContent = '';
          if (item.tokens) {
            itemContent = this.parser.parse(item.tokens);
          }
          // Remove wrapping <p> tags for simple list items
          itemContent = itemContent.replace(/^<p>(.*)<\/p>\n?$/s, '$1');
          body += `<li>${itemContent}</li>\n`;
        }
        return `<${tag}${startAttr}>\n${body}</${tag}>\n`;
      },

      // HTML passthrough - sanitize dangerous elements
      html(this: Renderer, token: Tokens.HTML): string {
        let html = token.raw;
        let sanitized = false;

        // Remove script tags and their content
        const withoutScripts = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
        if (withoutScripts !== html) sanitized = true;
        html = withoutScripts;

        // Remove iframe tags (can load arbitrary content)
        const withoutIframes = html.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
        if (withoutIframes !== html) sanitized = true;
        html = withoutIframes;

        // Remove object and embed tags (can execute plugins/ActiveX)
        const withoutObjects = html
          .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
          .replace(/<embed\b[^>]*>/gi, '');
        if (withoutObjects !== html) sanitized = true;
        html = withoutObjects;

        // Remove event handlers (onclick, onerror, etc.)
        const withoutHandlers = html.replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '');
        if (withoutHandlers !== html) sanitized = true;
        html = withoutHandlers;

        // Remove javascript: protocol in hrefs and srcs
        const withoutJsProtocol = html
          .replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href="#"')
          .replace(/src\s*=\s*["']javascript:[^"']*["']/gi, 'src=""');
        if (withoutJsProtocol !== html) sanitized = true;
        html = withoutJsProtocol;

        // Remove data: URLs in images (can contain embedded scripts)
        const withoutDataUrls = html.replace(/src\s*=\s*["']data:[^"']*["']/gi, 'src=""');
        if (withoutDataUrls !== html) sanitized = true;
        html = withoutDataUrls;

        // Warn if we sanitized anything
        if (sanitized) {
          self.warnings.push(
            'Potentially unsafe HTML was sanitized (scripts, iframes, event handlers, or dangerous URLs removed).',
          );
        }

        return html;
      },

      // Text
      text(this: Renderer, token: Tokens.Text): string {
        // If text has nested tokens (e.g., bold/italic/links inside list items),
        // parse them instead of returning raw text
        if ('tokens' in token && token.tokens && token.tokens.length > 0) {
          return this.parser.parseInline(token.tokens);
        }
        return token.text;
      },
    };

    return new Marked({
      gfm: true,
      breaks: false,
      renderer,
    });
  }

  /**
   * Strip @ prefix from user mentions, converting @username to just username
   * Confluence requires account IDs for proper mentions, so we render as plain text
   * Avoids email addresses (user@example.com) by checking preceding character
   */
  private stripMentionPrefix(markdown: string): string {
    // Match @username at word boundaries, but not in email addresses
    // Pattern: @ preceded by start-of-line or whitespace/punctuation (not alphanumeric or dot)
    return markdown.replace(/(?<=^|[^a-zA-Z0-9.])@([a-zA-Z0-9_-]+)/gm, '$1');
  }

  /**
   * Detect unsupported markdown features and add warnings
   */
  private detectUnsupportedFeatures(markdown: string): void {
    // Check for task lists with checkboxes
    if (/^\s*-\s*\[[x ]\]/im.test(markdown)) {
      this.warnings.push('Task list checkboxes (- [x]) will be converted to regular list items.');
    }

    // Check for footnotes
    if (/\[\^.+\]/.test(markdown)) {
      this.warnings.push('Footnotes are not supported and will render as plain text.');
    }
    // Note: Local images are detected in the image renderer itself
  }

  /**
   * Ensure XHTML compliance (self-closing tags, etc.)
   */
  private ensureXhtmlCompliance(html: string): string {
    return (
      html
        // Ensure br tags are self-closing
        .replace(/<br\s*>/gi, '<br />')
        // Ensure hr tags are self-closing
        .replace(/<hr\s*>/gi, '<hr />')
        // Ensure img tags are self-closing (not already handled)
        .replace(/<img([^>]+)(?<!\/)>/gi, '<img$1 />')
        // Clean up extra whitespace
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    );
  }

  /**
   * Convert Markdown to Confluence Storage Format HTML
   * Per ADR-0022: Converts relative .md links to Confluence page links
   *
   * @param markdown - Markdown content to convert
   * @param spaceRoot - Absolute path to space root directory (for link resolution)
   * @param currentPagePath - Current page's path relative to space root (for link resolution)
   * @param spaceKey - Confluence space key (for link generation)
   * @param pageLookupMap - Page lookup map for finding target pages
   */
  convert(
    markdown: string,
    spaceRoot?: string,
    currentPagePath?: string,
    spaceKey?: string,
    pageLookupMap?: PageLookupMap,
  ): { html: string; warnings: string[] } {
    this.warnings = [];
    this.spaceRoot = spaceRoot || '';
    this.currentPagePath = currentPagePath || '';
    this.spaceKey = spaceKey || '';
    this.pageLookupMap = pageLookupMap || null;

    // Preprocess: strip @ from mentions (Confluence requires account IDs for real mentions)
    const preprocessedMarkdown = this.stripMentionPrefix(markdown);

    // Detect unsupported features before conversion
    this.detectUnsupportedFeatures(preprocessedMarkdown);

    // Create marked instance with custom renderer for this conversion
    const markedInstance = this.createMarkedInstance();

    // Convert markdown to HTML using custom renderer
    const rawHtml = markedInstance.parse(preprocessedMarkdown);

    // Ensure XHTML compliance
    const html = this.ensureXhtmlCompliance(rawHtml as string);

    return {
      html,
      warnings: [...this.warnings],
    };
  }

  /**
   * Get any warnings from the last conversion
   */
  getWarnings(): string[] {
    return [...this.warnings];
  }
}
