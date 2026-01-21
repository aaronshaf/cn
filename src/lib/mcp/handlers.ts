/**
 * MCP tool execution handlers
 * Integrates with SearchClient and local file reading
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { parseMarkdown } from '../markdown/index.js';
import { SearchClient } from '../search/index.js';
import type { SpaceConfigWithState } from '../space-config.js';
import type {
  McpSearchResult,
  McpServerConfig,
  ReadPageToolInput,
  ReadPageToolOutput,
  SearchToolInput,
  SearchToolOutput,
} from './types.js';
import { toSearchOptions } from './types.js';

/**
 * Error thrown when page is not found via MCP tools
 * Named differently from lib/errors.ts PageNotFoundError to avoid collision
 */
export class McpPageNotFoundError extends Error {
  readonly _tag = 'McpPageNotFoundError' as const;

  constructor(identifier: string) {
    super(`Page not found: ${identifier}`);
    this.name = 'McpPageNotFoundError';
  }
}

/**
 * Error thrown when input parameters are invalid
 */
export class InvalidParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidParamsError';
  }
}

/**
 * Resolve page path from either a path or page ID
 * Returns the absolute path to the markdown file
 */
export function resolvePagePath(
  input: ReadPageToolInput,
  workspacePath: string,
  spaceConfig: SpaceConfigWithState,
): string {
  // Must have either path or id
  if (!input.path && !input.id) {
    throw new InvalidParamsError('Either path or id is required');
  }

  // If path is provided, use it directly
  if (input.path) {
    // Reject absolute paths for security
    if (isAbsolute(input.path)) {
      throw new InvalidParamsError('Path must be relative, not absolute');
    }

    // Normalize the path and ensure it's within the workspace
    const normalizedPath = normalize(input.path);

    // Prevent path traversal attacks
    if (normalizedPath.startsWith('..') || normalizedPath.includes('../')) {
      throw new InvalidParamsError('Path must be within the workspace directory');
    }

    const absolutePath = join(workspacePath, normalizedPath);

    // Verify the resolved path is still within workspace
    const relativePath = relative(workspacePath, absolutePath);
    if (relativePath.startsWith('..')) {
      throw new InvalidParamsError('Path must be within the workspace directory');
    }

    if (!existsSync(absolutePath)) {
      throw new McpPageNotFoundError(input.path);
    }

    return absolutePath;
  }

  // id is provided (already validated that at least one of path/id exists)
  const pageId = input.id as string;
  const pageInfo = spaceConfig.pages[pageId];
  if (!pageInfo) {
    throw new McpPageNotFoundError(pageId);
  }

  const absolutePath = join(workspacePath, pageInfo.localPath);
  if (!existsSync(absolutePath)) {
    throw new McpPageNotFoundError(pageId);
  }

  return absolutePath;
}

/**
 * Handle search tool call
 * @param input Search parameters from MCP tool call
 * @param config MCP server configuration
 * @param searchClient Optional pre-created SearchClient for reuse
 */
export async function handleSearch(
  input: SearchToolInput,
  config: McpServerConfig,
  searchClient?: SearchClient,
): Promise<SearchToolOutput> {
  const client = searchClient ?? new SearchClient(config.meilisearchUrl, config.meilisearchApiKey);
  const searchOptions = toSearchOptions(input);

  const response = await client.search(config.indexName, input.query, searchOptions);

  // Transform to MCP response format
  const results: McpSearchResult[] = response.results.map((r) => ({
    id: r.document.id,
    title: r.document.title,
    path: r.document.local_path,
    snippet: r.snippet,
    labels: r.document.labels,
    author: r.document.author_email,
    created_at: r.document.created_at ? new Date(r.document.created_at * 1000).toISOString() : null,
    updated_at: r.document.updated_at ? new Date(r.document.updated_at * 1000).toISOString() : null,
    url: r.document.url,
  }));

  return {
    results,
    total: response.totalHits,
    query: input.query,
  };
}

/**
 * Handle read_page tool call
 */
export async function handleReadPage(
  input: ReadPageToolInput,
  config: McpServerConfig,
  spaceConfig: SpaceConfigWithState,
): Promise<ReadPageToolOutput> {
  const absolutePath = resolvePagePath(input, config.workspacePath, spaceConfig);

  // Read and parse the file
  const fileContent = readFileSync(absolutePath, 'utf-8');
  const { frontmatter, content } = parseMarkdown(fileContent);

  // Get relative path for response
  const relativePath = relative(config.workspacePath, absolutePath);

  return {
    id: frontmatter.page_id || input.id || '',
    title: frontmatter.title || '',
    path: relativePath,
    content: content.trim(),
    metadata: {
      labels: frontmatter.labels || [],
      author: frontmatter.author_email || null,
      created_at: frontmatter.created_at || null,
      updated_at: frontmatter.updated_at || null,
      url: frontmatter.url || null,
    },
  };
}
