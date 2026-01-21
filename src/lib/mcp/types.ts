/**
 * MCP server types for cn CLI
 * Types for tool inputs/outputs and server configuration
 */

import type { SearchOptions } from '../search/index.js';

/**
 * Search tool input matching SearchOptions from search library
 * Uses snake_case for MCP JSON Schema consistency
 */
export interface SearchToolInput {
  query: string;
  limit?: number;
  labels?: string[];
  author?: string;
  // Absolute date filters
  created_after?: string;
  created_before?: string;
  updated_after?: string;
  updated_before?: string;
  // Relative date filters
  created_within?: string;
  updated_within?: string;
  stale?: string;
  // Sorting
  sort?: string;
}

/**
 * Single search result in MCP response
 */
export interface McpSearchResult {
  id: string;
  title: string;
  path: string;
  snippet: string;
  labels: string[];
  author: string | null;
  created_at: string | null;
  updated_at: string | null;
  url: string | null;
}

/**
 * Search tool output
 */
export interface SearchToolOutput {
  results: McpSearchResult[];
  total: number;
  query: string;
}

/**
 * Read page tool input - either path or id
 */
export interface ReadPageToolInput {
  path?: string;
  id?: string;
}

/**
 * Read page tool output
 */
export interface ReadPageToolOutput {
  id: string;
  title: string;
  path: string;
  content: string;
  metadata: {
    labels: string[];
    author: string | null;
    created_at: string | null;
    updated_at: string | null;
    url: string | null;
  };
}

/**
 * MCP server configuration
 */
export interface McpServerConfig {
  /** Path to the space directory */
  workspacePath: string;
  /** Meilisearch index name */
  indexName: string;
  /** Meilisearch URL */
  meilisearchUrl: string;
  /** Meilisearch API key (optional) */
  meilisearchApiKey?: string | null;
  /** Space key from config */
  spaceKey: string;
  /** Space name from config */
  spaceName: string;
}

/**
 * Convert SearchToolInput to SearchOptions
 */
export function toSearchOptions(input: SearchToolInput): SearchOptions {
  return {
    limit: input.limit,
    labels: input.labels,
    author: input.author,
    // Absolute date filters
    createdAfter: input.created_after,
    createdBefore: input.created_before,
    updatedAfter: input.updated_after,
    updatedBefore: input.updated_before,
    // Relative date filters
    createdWithin: input.created_within,
    updatedWithin: input.updated_within,
    stale: input.stale,
    // Sorting
    sort: input.sort,
  };
}
