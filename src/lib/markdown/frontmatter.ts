import matter from 'gray-matter';
import type { Label, Page, User } from '../confluence-client/types.js';

/**
 * Comprehensive frontmatter metadata for synced pages
 * Per ADR-0006: Include all available metadata in YAML frontmatter
 */
export interface PageFrontmatter {
  page_id: string;
  title: string;
  space_key: string;
  created_at?: string;
  updated_at?: string;
  version?: number;
  parent_id?: string | null;
  parent_title?: string;
  author_id?: string;
  author_name?: string;
  author_email?: string;
  last_modifier_id?: string;
  last_modifier_name?: string;
  last_modifier_email?: string;
  labels?: string[];
  url?: string;
  synced_at: string;
}

/**
 * Create frontmatter from a Confluence page
 */
export function createFrontmatter(
  page: Page,
  spaceKey: string,
  labels: Label[] = [],
  parentTitle?: string,
  baseUrl?: string,
  author?: User,
  lastModifier?: User,
): PageFrontmatter {
  const webui = page._links?.webui;
  const url = webui && baseUrl ? `${baseUrl}/wiki${webui}` : undefined;

  return {
    page_id: page.id,
    title: page.title,
    space_key: spaceKey,
    created_at: page.createdAt,
    updated_at: page.version?.createdAt,
    version: page.version?.number,
    parent_id: page.parentId,
    parent_title: parentTitle,
    author_id: page.authorId,
    author_name: author?.displayName,
    author_email: author?.email,
    last_modifier_id: page.version?.authorId,
    last_modifier_name: lastModifier?.displayName,
    last_modifier_email: lastModifier?.email,
    labels: labels.length > 0 ? labels.map((l) => l.name) : undefined,
    url,
    synced_at: new Date().toISOString(),
  };
}

/**
 * Serialize frontmatter and content to a markdown string
 * Accepts Partial frontmatter for flexibility when updating existing files
 */
export function serializeMarkdown(frontmatter: Partial<PageFrontmatter>, content: string): string {
  // Filter out undefined values
  const cleanFrontmatter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value !== undefined) {
      cleanFrontmatter[key] = value;
    }
  }

  return matter.stringify(content, cleanFrontmatter);
}

/**
 * Parse frontmatter and content from a markdown string
 */
export function parseMarkdown(markdown: string): { frontmatter: Partial<PageFrontmatter>; content: string } {
  const parsed = matter(markdown);
  return {
    frontmatter: parsed.data as Partial<PageFrontmatter>,
    content: parsed.content,
  };
}

/**
 * Extract page ID from frontmatter
 */
export function extractPageId(markdown: string): string | undefined {
  const { frontmatter } = parseMarkdown(markdown);
  return frontmatter.page_id;
}
