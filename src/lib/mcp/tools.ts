/**
 * MCP tool definitions with Zod schemas
 */

import { z } from 'zod';

/**
 * Search tool input schema
 */
export const SearchInputSchema = {
  query: z.string().describe('Search query (supports typo tolerance)'),
  limit: z.number().int().min(1).max(100).default(10).optional().describe('Maximum results to return'),
  labels: z.array(z.string()).optional().describe('Filter by labels (OR logic)'),
  author: z.string().optional().describe('Filter by author email'),
  // Absolute date filters
  created_after: z.string().optional().describe('Filter: created after date (YYYY-MM-DD)'),
  created_before: z.string().optional().describe('Filter: created before date (YYYY-MM-DD)'),
  updated_after: z.string().optional().describe('Filter: updated after date (YYYY-MM-DD)'),
  updated_before: z.string().optional().describe('Filter: updated before date (YYYY-MM-DD)'),
  // Relative date filters
  created_within: z.string().optional().describe('Filter: created within duration (e.g., 30d, 2w, 3m, 1y)'),
  updated_within: z.string().optional().describe('Filter: updated within duration (e.g., 7d, 2w, 1m)'),
  stale: z.string().optional().describe('Filter: NOT updated within duration - find stale content (e.g., 90d, 6m)'),
  // Sorting
  sort: z
    .enum(['created_at', '-created_at', 'updated_at', '-updated_at'])
    .optional()
    .describe('Sort order (prefix with - for descending)'),
};

/**
 * Read page tool input schema
 */
export const ReadPageInputSchema = {
  path: z
    .string()
    .optional()
    .describe("Relative path to the markdown file (e.g., 'getting-started/authentication.md')"),
  id: z.string().optional().describe('Page ID from frontmatter or search results'),
};

/**
 * Tool descriptions for registration
 */
export const TOOL_DESCRIPTIONS = {
  search: 'Search indexed Confluence content. Returns matching pages with snippets.',
  read_page:
    'Read the full content of a specific Confluence page. Use either the path (from search results) or the page ID.',
};
