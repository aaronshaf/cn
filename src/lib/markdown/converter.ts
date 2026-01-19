import TurndownService from 'turndown';
import * as turndownPluginGfm from 'turndown-plugin-gfm';
import type { Label, Page, User } from '../confluence-client/types.js';
import { createFrontmatter, serializeMarkdown, type PageFrontmatter } from './frontmatter.js';
import { confluenceLinkToRelativePath, extractPageTitleFromLink, type PageLookupMap } from './link-converter.js';

/**
 * Markdown converter that transforms Confluence HTML to Markdown
 * Uses Turndown with custom rules for Confluence-specific elements
 * Per ADR-0004
 */
export class MarkdownConverter {
  private turndown: TurndownService;
  private warnings: string[] = [];
  private currentBaseUrl: string = '';
  private currentPageId: string = '';
  private currentPagePath: string = '';
  private pageLookupMap: PageLookupMap | null = null;

  constructor() {
    this.turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '_',
      strongDelimiter: '**',
    });

    // Add GFM plugin for tables and strikethrough
    this.turndown.use(turndownPluginGfm.gfm);

    this.addCustomRules();
  }

  /**
   * Add custom rules for Confluence-specific elements
   */
  private addCustomRules(): void {
    // Code blocks with language detection
    this.turndown.addRule('confluenceCodeBlock', {
      filter: (node) => {
        return (
          node.nodeName === 'DIV' &&
          (node.classList?.contains('code') ||
            node.classList?.contains('codeContent') ||
            node.classList?.contains('preformatted'))
        );
      },
      replacement: (content, node) => {
        const element = node as HTMLElement;
        // Try to detect language from class or data attributes
        const language =
          element.getAttribute('data-syntaxhighlighter-params')?.match(/brush:\s*(\w+)/)?.[1] ||
          element.getAttribute('data-language') ||
          '';

        const code = element.textContent || content;
        return `\n\`\`\`${language}\n${code.trim()}\n\`\`\`\n`;
      },
    });

    // Confluence pre/code blocks
    this.turndown.addRule('confluencePreCode', {
      filter: (node) => {
        if (node.nodeName !== 'PRE') return false;
        const parent = node.parentNode as HTMLElement | null;
        return parent?.classList?.contains('code') || parent?.classList?.contains('codeContent') || false;
      },
      replacement: (content, node) => {
        const element = node as HTMLElement;
        const language = element.getAttribute('data-language') || '';
        return `\n\`\`\`${language}\n${content.trim()}\n\`\`\`\n`;
      },
    });

    // Confluence ac:structured-macro (info, note, warning, tip panels)
    this.turndown.addRule('confluenceMacro', {
      filter: (node) => {
        return node.nodeName === 'AC:STRUCTURED-MACRO' || node.nodeName.toLowerCase() === 'ac:structured-macro';
      },
      replacement: (content, node) => {
        const element = node as HTMLElement;
        const macroName = element.getAttribute('ac:name') || 'unknown';

        // Handle specific macros
        switch (macroName) {
          case 'info':
            return `\n> **Info:** ${content.trim()}\n`;
          case 'note':
            return `\n> **Note:** ${content.trim()}\n`;
          case 'warning':
            return `\n> **Warning:** ${content.trim()}\n`;
          case 'tip':
            return `\n> **Tip:** ${content.trim()}\n`;
          case 'code':
            return `\n\`\`\`\n${content.trim()}\n\`\`\`\n`;
          case 'toc':
            // Table of contents - skip with warning
            this.warnings.push('Table of Contents macro was removed');
            return '';
          default:
            this.warnings.push(`Unsupported macro "${macroName}" was converted to blockquote`);
            return `\n> **${macroName}:** ${content.trim()}\n`;
        }
      },
    });

    // Confluence task lists
    this.turndown.addRule('confluenceTaskList', {
      filter: (node) => {
        return node.nodeName === 'AC:TASK-LIST' || node.nodeName.toLowerCase() === 'ac:task-list';
      },
      replacement: (content) => {
        return content;
      },
    });

    this.turndown.addRule('confluenceTask', {
      filter: (node) => {
        return node.nodeName === 'AC:TASK' || node.nodeName.toLowerCase() === 'ac:task';
      },
      replacement: (content, node) => {
        const element = node as HTMLElement;
        const status = element.querySelector('ac\\:task-status, [ac\\:task-status]')?.textContent || '';
        const body = element.querySelector('ac\\:task-body, [ac\\:task-body]')?.textContent || content;
        const checked = status === 'complete' ? 'x' : ' ';
        return `- [${checked}] ${body.trim()}\n`;
      },
    });

    // Confluence user mentions
    this.turndown.addRule('confluenceMention', {
      filter: (node) => {
        return (
          node.nodeName === 'AC:LINK' ||
          node.nodeName.toLowerCase() === 'ac:link' ||
          (node.nodeName === 'A' && (node as HTMLElement).classList?.contains('confluence-userlink'))
        );
      },
      replacement: (content, node) => {
        const element = node as HTMLElement;
        const userName =
          element.getAttribute('ri:username') || element.getAttribute('data-username') || content || 'user';
        return `@${userName}`;
      },
    });

    // Confluence emoticons
    this.turndown.addRule('confluenceEmoticon', {
      filter: (node) => {
        return node.nodeName === 'AC:EMOTICON' || node.nodeName.toLowerCase() === 'ac:emoticon';
      },
      replacement: (_content, node) => {
        const element = node as HTMLElement;
        const name = element.getAttribute('ac:name') || '';
        // Map common Confluence emoticons to Unicode
        const emojiMap: Record<string, string> = {
          smile: ':)',
          sad: ':(',
          cheeky: ':P',
          laugh: ':D',
          wink: ';)',
          thumbsup: '(y)',
          thumbsdown: '(n)',
          information: '(i)',
          tick: '(/))',
          cross: '(x)',
          warning: '(!)',
          plus: '(+)',
          minus: '(-)',
          question: '(?)',
          light_bulb: '(*)',
          yellow_star: '(*y)',
          red_star: '(*r)',
          green_star: '(*g)',
          blue_star: '(*b)',
        };
        return emojiMap[name] || `(${name})`;
      },
    });

    // Confluence images (ac:image elements)
    // Since attachments are not synced, we link to the Confluence URL and warn
    this.turndown.addRule('confluenceImage', {
      filter: (node) => {
        return node.nodeName === 'AC:IMAGE' || node.nodeName.toLowerCase() === 'ac:image';
      },
      replacement: (_content, node) => {
        const element = node as HTMLElement;
        const attachment = element.querySelector('ri\\:attachment, [ri\\:attachment]');
        const filename = attachment?.getAttribute('ri:filename') || 'image';
        this.warnings.push(`Image "${filename}" links to Confluence (attachments not synced)`);
        // Build Confluence attachment URL if we have context
        if (this.currentBaseUrl && this.currentPageId) {
          const attachmentUrl = `${this.currentBaseUrl}/wiki/download/attachments/${this.currentPageId}/${encodeURIComponent(filename)}`;
          return `![${filename}](${attachmentUrl})`;
        }
        // Fallback: just use filename as placeholder
        return `![${filename}](${filename})`;
      },
    });

    // Standard images with Confluence attachment URLs
    // Since attachments are not synced, we preserve the original URL and warn
    this.turndown.addRule('confluenceAttachmentImage', {
      filter: (node) => {
        if (node.nodeName !== 'IMG') return false;
        const src = (node as HTMLImageElement).getAttribute('src') || '';
        return src.includes('/attachments/') || src.includes('/download/');
      },
      replacement: (_content, node) => {
        const element = node as HTMLImageElement;
        const src = element.getAttribute('src') || '';
        const alt = element.getAttribute('alt') || 'image';
        const filename = src.split('/').pop()?.split('?')[0] || 'image';
        this.warnings.push(`Image "${filename}" links to Confluence (attachments not synced)`);
        // Use absolute URL if src is relative, otherwise preserve original
        if (src.startsWith('/') && this.currentBaseUrl) {
          return `![${alt}](${this.currentBaseUrl}${src})`;
        }
        return `![${alt}](${src})`;
      },
    });

    // Confluence page links (ac:link with ri:page)
    // Per ADR-0022: Convert to relative markdown paths
    this.turndown.addRule('confluencePageLink', {
      filter: (node) => {
        // Match <ac:link> elements containing <ri:page>
        if (node.nodeName === 'AC:LINK' || node.nodeName.toLowerCase() === 'ac:link') {
          return true;
        }
        // Also match standard <a> tags with confluence link classes
        return (
          node.nodeName === 'A' &&
          ((node as HTMLElement).getAttribute('href')?.includes('/wiki/') ||
            (node as HTMLElement).classList?.contains('confluence-link'))
        );
      },
      replacement: (content, node) => {
        const element = node as HTMLElement;

        // Check if this is an ac:link with ri:page
        const riPage = element.querySelector('ri\\:page, [ri\\:page]');
        if (riPage) {
          const targetTitle = riPage.getAttribute('ri:content-title');
          // TODO: Extract ri:space-key attribute to support cross-space links
          // const targetSpaceKey = riPage.getAttribute('ri:space-key');

          // Extract link text from ac:plain-text-link-body if content is empty
          let linkText = content;
          if (!linkText || linkText.trim() === '') {
            // Try to find link body with different selectors
            const linkBody =
              element.querySelector('ac\\:plain-text-link-body, [ac\\:plain-text-link-body], plain-text-link-body') ||
              element.querySelector('[ri\\:content-title]')?.nextElementSibling;
            linkText = linkBody?.textContent?.trim() || element.textContent?.trim() || targetTitle || '';
          }

          // Only attempt conversion if we have all required context
          if (targetTitle && this.pageLookupMap && this.currentPagePath) {
            // Try to convert to relative path
            const relativePath = confluenceLinkToRelativePath(targetTitle, this.currentPagePath, this.pageLookupMap);

            if (relativePath) {
              return `[${linkText}](${relativePath})`;
            }

            // Target page not found in sync state
            this.warnings.push(`Link to "${targetTitle}" could not be resolved to local path (page not in sync state)`);
          } else if (targetTitle && !this.pageLookupMap) {
            // Missing lookup map context
            this.warnings.push(`Link to "${targetTitle}" could not be converted (missing page lookup map)`);
          } else if (!targetTitle) {
            // Missing title in link
            this.warnings.push('Confluence page link missing ri:content-title attribute');
          }
        }

        // Fallback: preserve as Confluence URL
        const href = element.getAttribute('href') || '';
        if (href) {
          return `[${content}](${href})`;
        }

        // Last resort: just return the text
        return content;
      },
    });

    // Remove empty paragraphs
    this.turndown.addRule('removeEmptyParagraphs', {
      filter: (node) => {
        return node.nodeName === 'P' && !node.textContent?.trim() && !node.querySelector('img');
      },
      replacement: () => '',
    });
  }

  /**
   * Convert Confluence HTML to Markdown
   */
  convert(html: string): string {
    this.warnings = [];

    // Pre-process HTML to handle Confluence-specific namespace elements
    const processedHtml = html
      // Convert ac: namespace elements to standard HTML attributes
      .replace(/<ac:structured-macro/gi, '<div data-macro="true" data-macro-name')
      .replace(/<\/ac:structured-macro>/gi, '</div>')
      .replace(/<ac:parameter/gi, '<span data-param')
      .replace(/<\/ac:parameter>/gi, '</span>')
      .replace(/<ac:rich-text-body>/gi, '<div>')
      .replace(/<\/ac:rich-text-body>/gi, '</div>')
      .replace(/<ac:plain-text-body>/gi, '<pre>')
      .replace(/<\/ac:plain-text-body>/gi, '</pre>')
      // Convert Confluence user references to @mentions
      .replace(/<ac:link><ri:user[^>]*ri:account-id="([^"]*)"[^/]*\/><\/ac:link>/gi, '@$1')
      .replace(/<ri:user[^>]*ri:account-id="([^"]*)"[^/]*\/>/gi, '@$1');

    // Convert using Turndown, with error handling for malformed HTML
    let markdown: string;
    try {
      markdown = this.turndown.turndown(processedHtml);
    } catch {
      // If turndown fails (often due to malformed tables), try stripping tables and retry
      try {
        const tableCount = (processedHtml.match(/<table[\s\S]*?<\/table>/gi) || []).length;
        const htmlWithoutTables = processedHtml.replace(
          /<table[\s\S]*?<\/table>/gi,
          '\n\n[Table removed due to conversion error]\n\n',
        );
        markdown = this.turndown.turndown(htmlWithoutTables);
        this.warnings.push(`Removed ${tableCount} malformed table(s) during conversion`);
      } catch {
        // Last resort: return raw text content
        this.warnings.push('Converted as plain text (HTML too malformed)');
        markdown = processedHtml
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
    }

    // Post-process: clean up extra whitespace
    markdown = markdown
      .replace(/\n{3,}/g, '\n\n') // Collapse multiple newlines
      .trim();

    return markdown;
  }

  /**
   * Convert a page to markdown with frontmatter
   * Per ADR-0022: Converts Confluence page links to relative markdown paths
   */
  convertPage(
    page: Page,
    spaceKey: string,
    labels: Label[] = [],
    parentTitle?: string,
    baseUrl?: string,
    author?: User,
    lastModifier?: User,
    currentPagePath?: string,
    pageLookupMap?: PageLookupMap,
  ): { markdown: string; warnings: string[] } {
    // Set context for image URL generation and link conversion
    this.currentBaseUrl = baseUrl || '';
    this.currentPageId = page.id;
    this.currentPagePath = currentPagePath || '';
    this.pageLookupMap = pageLookupMap || null;

    const html = page.body?.storage?.value || '';
    const content = this.convert(html);
    const frontmatter = createFrontmatter(page, spaceKey, labels, parentTitle, baseUrl, author, lastModifier);
    const markdown = serializeMarkdown(frontmatter, content);

    return {
      markdown,
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
