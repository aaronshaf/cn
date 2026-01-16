/**
 * Meilisearch client wrapper
 */

import { MeiliSearch, type Index } from 'meilisearch';
import { MeilisearchConnectionError, MeilisearchIndexError } from '../errors.js';
import { parseDate, parseDuration, validateDateFilters } from './date-utils.js';
import {
  DEFAULT_MEILISEARCH_URL,
  type IndexStatus,
  type SearchDocument,
  type SearchFilters,
  type SearchOptions,
  type SearchResponse,
  type SearchResult,
} from './types.js';

/**
 * Escape a string for use in Meilisearch filter expressions
 * Prevents filter injection by escaping double quotes
 */
function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Truncate content to create a snippet
 * Collapses multiple whitespace characters into single spaces
 */
function truncateSnippet(content: string | undefined, maxLength = 150): string {
  if (!content) return '';

  // Collapse multiple whitespace characters (spaces, newlines, tabs) into single spaces
  const normalized = content.replace(/\s+/g, ' ').trim();

  if (normalized.length <= maxLength) return normalized;
  return `${normalized.substring(0, maxLength)}...`;
}

/**
 * Build date filter strings from search options
 */
function buildDateFilters(options: SearchOptions): string[] {
  const filters: string[] = [];
  const now = Math.floor(Date.now() / 1000);

  // Validate conflicting filters
  validateDateFilters(options);

  // Absolute filters
  if (options.createdAfter) {
    const timestamp = parseDate(options.createdAfter);
    filters.push(`created_at >= ${timestamp}`);
  }
  if (options.createdBefore) {
    const timestamp = parseDate(options.createdBefore);
    filters.push(`created_at <= ${timestamp}`);
  }
  if (options.updatedAfter) {
    const timestamp = parseDate(options.updatedAfter);
    filters.push(`updated_at >= ${timestamp}`);
  }
  if (options.updatedBefore) {
    const timestamp = parseDate(options.updatedBefore);
    filters.push(`updated_at <= ${timestamp}`);
  }

  // Relative filters
  if (options.createdWithin) {
    const seconds = parseDuration(options.createdWithin);
    const cutoff = now - seconds;
    filters.push(`created_at >= ${cutoff}`);
  }
  if (options.updatedWithin) {
    const seconds = parseDuration(options.updatedWithin);
    const cutoff = now - seconds;
    filters.push(`updated_at >= ${cutoff}`);
  }
  if (options.stale) {
    const seconds = parseDuration(options.stale);
    const cutoff = now - seconds;
    filters.push(`updated_at <= ${cutoff}`);
  }

  return filters;
}

/**
 * Build sort parameter from search options
 */
function buildSortParameter(sort?: string): string[] | undefined {
  if (!sort) return undefined;

  const descending = sort.startsWith('-');
  const field = descending ? sort.substring(1) : sort;

  if (field !== 'created_at' && field !== 'updated_at') {
    throw new Error(`Invalid sort field: ${field}. Use created_at or updated_at`);
  }

  return [`${field}:${descending ? 'desc' : 'asc'}`];
}

/**
 * Extract active filters from options for response metadata
 */
function extractActiveFilters(options: SearchOptions): SearchFilters | undefined {
  const filters: SearchFilters = {};
  let hasFilters = false;

  if (options.labels && options.labels.length > 0) {
    filters.labels = options.labels;
    hasFilters = true;
  }
  if (options.author) {
    filters.author = options.author;
    hasFilters = true;
  }
  if (options.createdAfter) {
    filters.createdAfter = options.createdAfter;
    hasFilters = true;
  }
  if (options.createdBefore) {
    filters.createdBefore = options.createdBefore;
    hasFilters = true;
  }
  if (options.updatedAfter) {
    filters.updatedAfter = options.updatedAfter;
    hasFilters = true;
  }
  if (options.updatedBefore) {
    filters.updatedBefore = options.updatedBefore;
    hasFilters = true;
  }
  if (options.createdWithin) {
    filters.createdWithin = options.createdWithin;
    hasFilters = true;
  }
  if (options.updatedWithin) {
    filters.updatedWithin = options.updatedWithin;
    hasFilters = true;
  }
  if (options.stale) {
    filters.stale = options.stale;
    hasFilters = true;
  }
  if (options.sort) {
    filters.sort = options.sort;
    hasFilters = true;
  }

  return hasFilters ? filters : undefined;
}

/**
 * Meilisearch index settings optimized for Confluence content
 */
const INDEX_SETTINGS = {
  searchableAttributes: ['title', 'content'],
  filterableAttributes: ['space_key', 'labels', 'author_email', 'last_modifier_email'],
  sortableAttributes: ['created_at', 'updated_at'],
  rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
};

/**
 * Client wrapper for Meilisearch operations
 */
export class SearchClient {
  private client: MeiliSearch;
  private url: string;

  constructor(url: string = DEFAULT_MEILISEARCH_URL, apiKey?: string | null) {
    this.url = url;
    this.client = new MeiliSearch({
      host: url,
      apiKey: apiKey || undefined,
    });
  }

  /**
   * Check if Meilisearch is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.client.health();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ensure Meilisearch is available, throw if not
   */
  async ensureAvailable(): Promise<void> {
    const available = await this.isAvailable();
    if (!available) {
      throw new MeilisearchConnectionError(this.url);
    }
  }

  /**
   * Get or create an index with proper settings
   * @param updateSettings - If true, update index settings (use for indexing operations)
   */
  async getOrCreateIndex(indexName: string, updateSettings = false): Promise<Index<SearchDocument>> {
    await this.ensureAvailable();

    try {
      // Try to get existing index
      const index = this.client.index<SearchDocument>(indexName);

      // Check if index exists by getting its stats
      let indexCreated = false;
      try {
        await index.getStats();
      } catch {
        // Index doesn't exist, create it
        const task = await this.client.createIndex(indexName, { primaryKey: 'id' });
        await this.client.waitForTask(task.taskUid);
        indexCreated = true;
      }

      // Only update settings when creating index or explicitly requested
      if (indexCreated || updateSettings) {
        const settingsTask = await index.updateSettings(INDEX_SETTINGS);
        await this.client.waitForTask(settingsTask.taskUid);
      }

      return index;
    } catch (error) {
      if (error instanceof MeilisearchConnectionError) {
        throw error;
      }
      throw new MeilisearchIndexError(
        indexName,
        `Failed to get or create index: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Index documents
   */
  async indexDocuments(indexName: string, documents: SearchDocument[]): Promise<void> {
    // Update settings during indexing to ensure they're current
    const index = await this.getOrCreateIndex(indexName, true);

    try {
      const task = await index.addDocuments(documents);
      await this.client.waitForTask(task.taskUid);
    } catch (error) {
      throw new MeilisearchIndexError(
        indexName,
        `Failed to index documents: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Clear all documents from an index
   */
  async clearIndex(indexName: string): Promise<void> {
    await this.ensureAvailable();

    try {
      const index = this.client.index(indexName);
      const task = await index.deleteAllDocuments();
      await this.client.waitForTask(task.taskUid);
    } catch (error) {
      throw new MeilisearchIndexError(
        indexName,
        `Failed to clear index: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Delete an index entirely
   */
  async deleteIndex(indexName: string): Promise<void> {
    await this.ensureAvailable();

    try {
      const task = await this.client.deleteIndex(indexName);
      await this.client.waitForTask(task.taskUid);
    } catch {
      // Index may not exist, ignore error
    }
  }

  /**
   * Search documents
   */
  async search(indexName: string, query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    await this.ensureAvailable();

    try {
      const index = this.client.index<SearchDocument>(indexName);

      // Build filter string with escaped values to prevent injection
      const filters: string[] = [];
      if (options.labels && options.labels.length > 0) {
        const labelFilters = options.labels.map((label) => `labels = "${escapeFilterValue(label)}"`);
        filters.push(`(${labelFilters.join(' OR ')})`);
      }
      if (options.author) {
        filters.push(`author_email = "${escapeFilterValue(options.author)}"`);
      }

      // Add date filters
      const dateFilters = buildDateFilters(options);
      filters.push(...dateFilters);

      // Build sort parameter
      const sort = buildSortParameter(options.sort);

      const searchResult = await index.search(query, {
        limit: options.limit || 10,
        filter: filters.length > 0 ? filters.join(' AND ') : undefined,
        sort,
        attributesToHighlight: ['title', 'content'],
        highlightPreTag: '**',
        highlightPostTag: '**',
        attributesToCrop: ['content'],
        cropLength: 100,
      });

      const results: SearchResult[] = searchResult.hits.map((hit, idx) => {
        // Extract snippet from highlighted content or original
        const formatted = hit._formatted as SearchDocument | undefined;
        const snippet = truncateSnippet(formatted?.content || hit.content);

        return {
          document: {
            id: hit.id,
            title: hit.title,
            content: hit.content,
            space_key: hit.space_key,
            labels: hit.labels,
            author_email: hit.author_email,
            last_modifier_email: hit.last_modifier_email,
            created_at: hit.created_at,
            updated_at: hit.updated_at,
            local_path: hit.local_path,
            url: hit.url,
            parent_title: hit.parent_title,
          },
          snippet,
          rank: idx + 1,
        };
      });

      return {
        query,
        results,
        totalHits: searchResult.estimatedTotalHits || results.length,
        processingTimeMs: searchResult.processingTimeMs || 0,
        filters: extractActiveFilters(options),
      };
    } catch (error) {
      // Check if index doesn't exist
      if (error instanceof Error && error.message.includes('not found')) {
        throw new MeilisearchIndexError(indexName, 'Index not found. Run "cn search index" first.');
      }
      throw new MeilisearchIndexError(
        indexName,
        `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Get index status
   */
  async getIndexStatus(indexName: string): Promise<IndexStatus> {
    const status: IndexStatus = {
      connected: false,
      meilisearchUrl: this.url,
      indexName: null,
      documentCount: null,
    };

    try {
      await this.client.health();
      status.connected = true;
    } catch {
      status.error = `Cannot connect to Meilisearch at ${this.url}`;
      return status;
    }

    try {
      const index = this.client.index(indexName);
      const stats = await index.getStats();
      status.indexName = indexName;
      status.documentCount = stats.numberOfDocuments;
    } catch {
      status.indexName = indexName;
      status.error = 'Index not found';
    }

    return status;
  }
}
