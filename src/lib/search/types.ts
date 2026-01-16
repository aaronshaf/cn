/**
 * Search types for Meilisearch integration
 */

/**
 * Document structure indexed in Meilisearch
 */
export interface SearchDocument {
  /** Primary key - page_id from frontmatter */
  id: string;

  /** Searchable fields */
  title: string;
  content: string;

  /** Filterable fields */
  space_key: string;
  labels: string[];
  author_email: string | null;
  last_modifier_email: string | null;

  /** Sortable fields (Unix timestamps) */
  created_at: number | null;
  updated_at: number | null;

  /** Display fields */
  local_path: string;
  url: string | null;
  parent_title: string | null;
}

/**
 * Search query options
 */
export interface SearchOptions {
  /** Filter by labels */
  labels?: string[];
  /** Filter by author email */
  author?: string;
  /** Maximum number of results */
  limit?: number;

  // Date filters - absolute
  /** Documents created after this date (YYYY-MM-DD) */
  createdAfter?: string;
  /** Documents created before this date (YYYY-MM-DD) */
  createdBefore?: string;
  /** Documents updated after this date (YYYY-MM-DD) */
  updatedAfter?: string;
  /** Documents updated before this date (YYYY-MM-DD) */
  updatedBefore?: string;

  // Date filters - relative
  /** Documents created within duration (e.g., 30d, 2w) */
  createdWithin?: string;
  /** Documents updated within duration (e.g., 7d, 2w) */
  updatedWithin?: string;
  /** Documents NOT updated within duration (e.g., 90d, 6m) */
  stale?: string;

  // Sorting
  /** Sort field (created_at, updated_at, or prefix with - for desc) */
  sort?: string;
}

/**
 * Single search result with highlighting
 */
export interface SearchResult {
  /** The matched document */
  document: SearchDocument;
  /** Highlighted snippet of content */
  snippet: string;
  /** Rank/position in results */
  rank: number;
}

/**
 * Active filters in search
 */
export interface SearchFilters {
  labels?: string[];
  author?: string;
  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  createdWithin?: string;
  updatedWithin?: string;
  stale?: string;
  sort?: string;
}

/**
 * Search response
 */
export interface SearchResponse {
  query: string;
  results: SearchResult[];
  totalHits: number;
  processingTimeMs: number;
  filters?: SearchFilters;
}

/**
 * Index status information
 */
export interface IndexStatus {
  connected: boolean;
  meilisearchUrl: string;
  indexName: string | null;
  documentCount: number | null;
  error?: string;
}

/**
 * Default Meilisearch configuration
 */
export const DEFAULT_MEILISEARCH_URL = 'http://localhost:7700';

/**
 * Generate index name from space key
 * Sanitizes to only include alphanumeric characters, hyphens, and underscores
 * as required by Meilisearch
 */
export function getIndexName(spaceKey: string): string {
  // Replace any character that's not alphanumeric, hyphen, or underscore with underscore
  const sanitized = spaceKey.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  return `cn-${sanitized}`;
}
