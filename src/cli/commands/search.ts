/**
 * cn search command - Search indexed content using Meilisearch
 */

import chalk from 'chalk';
import ora from 'ora';
import { EXIT_CODES, MeilisearchConnectionError, MeilisearchIndexError } from '../../lib/errors.js';
import {
  DEFAULT_MEILISEARCH_URL,
  formatRelativeTime,
  getIndexName,
  scanDirectory,
  SearchClient,
  type IndexStatus,
  type SearchOptions,
  type SearchResponse,
} from '../../lib/search/index.js';
import { readSpaceConfig, type SpaceConfigWithState } from '../../lib/space-config.js';

/**
 * Get Meilisearch URL from config or use default
 */
function getMeilisearchUrl(spaceConfig: SpaceConfigWithState | null): string {
  return spaceConfig?.search?.meilisearchUrl || DEFAULT_MEILISEARCH_URL;
}

/**
 * Get Meilisearch API key from config
 */
function getMeilisearchApiKey(spaceConfig: SpaceConfigWithState | null): string | null {
  return spaceConfig?.search?.apiKey ?? null;
}

/**
 * Get index name from config or generate from space key
 */
function getIndexNameFromConfig(spaceConfig: SpaceConfigWithState): string {
  return spaceConfig.search?.indexName || getIndexName(spaceConfig.spaceKey);
}

export interface SearchCommandOptions {
  /** Search query */
  query?: string;
  /** Subcommand: 'index' or 'status' */
  subcommand?: 'index' | 'status';
  /** Filter by labels */
  labels?: string[];
  /** Filter by author email */
  author?: string;
  /** Max results */
  limit?: number;
  /** Force rebuild index */
  force?: boolean;
  /** Dry run (show what would be indexed) */
  dryRun?: boolean;
  /** Output as JSON */
  json?: boolean;
  /** Output as XML */
  xml?: boolean;

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
 * XML escape helper
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Format search results for human output
 */
function formatResultsHuman(response: SearchResponse): string {
  const lines: string[] = [];

  if (response.results.length === 0) {
    lines.push(chalk.yellow(`No results found for "${response.query}"`));
    return lines.join('\n');
  }

  lines.push(chalk.bold(`Found ${response.totalHits} result(s) for "${response.query}"`));
  lines.push('');

  for (const result of response.results) {
    lines.push(chalk.cyan.bold(`${result.rank}. ${result.document.title}`));
    lines.push(chalk.gray(`   ${result.document.local_path}`));
    if (result.document.updated_at) {
      const date = new Date(result.document.updated_at * 1000);
      const relative = formatRelativeTime(result.document.updated_at);
      lines.push(chalk.gray(`   Updated: ${date.toLocaleDateString()} ${date.toLocaleTimeString()} (${relative})`));
    }
    if (result.snippet) {
      lines.push(`   ${result.snippet}`);
    }
    lines.push('');
  }

  lines.push(chalk.gray(`Search completed in ${response.processingTimeMs}ms`));

  // Show active filters
  if (response.filters) {
    const filterParts: string[] = [];
    if (response.filters.labels && response.filters.labels.length > 0) {
      filterParts.push(`labels: ${response.filters.labels.join(', ')}`);
    }
    if (response.filters.author) {
      filterParts.push(`author: ${response.filters.author}`);
    }
    if (response.filters.createdAfter) {
      filterParts.push(`created after ${response.filters.createdAfter}`);
    }
    if (response.filters.createdBefore) {
      filterParts.push(`created before ${response.filters.createdBefore}`);
    }
    if (response.filters.updatedAfter) {
      filterParts.push(`updated after ${response.filters.updatedAfter}`);
    }
    if (response.filters.updatedBefore) {
      filterParts.push(`updated before ${response.filters.updatedBefore}`);
    }
    if (response.filters.createdWithin) {
      filterParts.push(`created within ${response.filters.createdWithin}`);
    }
    if (response.filters.updatedWithin) {
      filterParts.push(`updated within ${response.filters.updatedWithin}`);
    }
    if (response.filters.stale) {
      filterParts.push(`stale: not updated in ${response.filters.stale}`);
    }
    if (response.filters.sort) {
      filterParts.push(`sorted by ${response.filters.sort}`);
    }
    if (filterParts.length > 0) {
      lines.push(chalk.gray(`Filters: ${filterParts.join(', ')}`));
    }
  }

  return lines.join('\n');
}

/**
 * Format search results as JSON
 */
function formatResultsJson(response: SearchResponse): string {
  return JSON.stringify(
    {
      query: response.query,
      totalHits: response.totalHits,
      processingTimeMs: response.processingTimeMs,
      filters: response.filters || null,
      results: response.results.map((r) => ({
        rank: r.rank,
        title: r.document.title,
        path: r.document.local_path,
        page_id: r.document.id,
        labels: r.document.labels,
        snippet: r.snippet,
        url: r.document.url,
        created_at: r.document.created_at,
        updated_at: r.document.updated_at,
      })),
    },
    null,
    2,
  );
}

/**
 * Format search results as XML
 */
function formatResultsXml(response: SearchResponse): string {
  const lines: string[] = [];

  lines.push(`<search-results query="${escapeXml(response.query)}" count="${response.totalHits}">`);

  // Include filters metadata
  if (response.filters) {
    lines.push('  <filters>');
    if (response.filters.labels && response.filters.labels.length > 0) {
      for (const label of response.filters.labels) {
        lines.push(`    <label>${escapeXml(label)}</label>`);
      }
    }
    if (response.filters.author) {
      lines.push(`    <author>${escapeXml(response.filters.author)}</author>`);
    }
    if (response.filters.createdAfter) {
      lines.push(`    <created_after>${escapeXml(response.filters.createdAfter)}</created_after>`);
    }
    if (response.filters.createdBefore) {
      lines.push(`    <created_before>${escapeXml(response.filters.createdBefore)}</created_before>`);
    }
    if (response.filters.updatedAfter) {
      lines.push(`    <updated_after>${escapeXml(response.filters.updatedAfter)}</updated_after>`);
    }
    if (response.filters.updatedBefore) {
      lines.push(`    <updated_before>${escapeXml(response.filters.updatedBefore)}</updated_before>`);
    }
    if (response.filters.createdWithin) {
      lines.push(`    <created_within>${escapeXml(response.filters.createdWithin)}</created_within>`);
    }
    if (response.filters.updatedWithin) {
      lines.push(`    <updated_within>${escapeXml(response.filters.updatedWithin)}</updated_within>`);
    }
    if (response.filters.stale) {
      lines.push(`    <stale>${escapeXml(response.filters.stale)}</stale>`);
    }
    if (response.filters.sort) {
      lines.push(`    <sort>${escapeXml(response.filters.sort)}</sort>`);
    }
    lines.push('  </filters>');
  }

  for (const result of response.results) {
    lines.push(`  <result rank="${result.rank}">`);
    lines.push(`    <title>${escapeXml(result.document.title)}</title>`);
    lines.push(`    <path>${escapeXml(result.document.local_path)}</path>`);
    lines.push(`    <page_id>${escapeXml(result.document.id)}</page_id>`);
    if (result.document.created_at !== null) {
      lines.push(`    <created_at>${result.document.created_at}</created_at>`);
    }
    if (result.document.updated_at !== null) {
      lines.push(`    <updated_at>${result.document.updated_at}</updated_at>`);
    }
    if (result.document.labels.length > 0) {
      lines.push('    <labels>');
      for (const label of result.document.labels) {
        lines.push(`      <label>${escapeXml(label)}</label>`);
      }
      lines.push('    </labels>');
    }
    if (result.snippet) {
      lines.push(`    <snippet>${escapeXml(result.snippet)}</snippet>`);
    }
    if (result.document.url) {
      lines.push(`    <url>${escapeXml(result.document.url)}</url>`);
    }
    lines.push('  </result>');
  }

  lines.push('</search-results>');

  return lines.join('\n');
}

/**
 * Format index status for human output
 */
function formatStatusHuman(status: IndexStatus, spaceConfig: SpaceConfigWithState | null): string {
  const lines: string[] = [];

  lines.push(chalk.bold('Search Status'));
  lines.push('');

  if (status.connected) {
    lines.push(chalk.green(`  Meilisearch: ${chalk.bold('Connected')} (${status.meilisearchUrl})`));
  } else {
    lines.push(chalk.red(`  Meilisearch: ${chalk.bold('Not connected')}`));
    lines.push('');
    lines.push(chalk.yellow('  To start Meilisearch:'));
    lines.push(chalk.gray('    docker run -d -p 7700:7700 getmeili/meilisearch:latest'));
    return lines.join('\n');
  }

  if (status.indexName) {
    lines.push(`  Index: ${chalk.cyan(status.indexName)}`);
    if (status.documentCount !== null) {
      lines.push(`  Documents: ${status.documentCount}`);
    }
  }

  if (spaceConfig) {
    lines.push(`  Space: ${chalk.cyan(spaceConfig.spaceName)} (${spaceConfig.spaceKey})`);
  }

  if (status.error) {
    lines.push('');
    lines.push(chalk.yellow(`  Warning: ${status.error}`));
  }

  return lines.join('\n');
}

/**
 * Format index status as JSON
 */
function formatStatusJson(status: IndexStatus, spaceConfig: SpaceConfigWithState | null): string {
  return JSON.stringify(
    {
      connected: status.connected,
      meilisearchUrl: status.meilisearchUrl,
      indexName: status.indexName,
      documentCount: status.documentCount,
      space: spaceConfig
        ? {
            key: spaceConfig.spaceKey,
            name: spaceConfig.spaceName,
          }
        : null,
      error: status.error || null,
    },
    null,
    2,
  );
}

/**
 * Format index status as XML
 */
function formatStatusXml(status: IndexStatus, spaceConfig: SpaceConfigWithState | null): string {
  const lines: string[] = [];

  lines.push(`<search-status connected="${status.connected}">`);
  lines.push(`  <meilisearch url="${escapeXml(status.meilisearchUrl)}" />`);

  if (status.indexName) {
    lines.push(`  <index name="${escapeXml(status.indexName)}" documents="${status.documentCount ?? 0}" />`);
  }

  if (spaceConfig) {
    lines.push(`  <space key="${escapeXml(spaceConfig.spaceKey)}" name="${escapeXml(spaceConfig.spaceName)}" />`);
  }

  if (status.error) {
    lines.push(`  <warning>${escapeXml(status.error)}</warning>`);
  }

  lines.push('</search-status>');

  return lines.join('\n');
}

/**
 * Execute search query
 */
async function executeSearch(
  spaceConfig: SpaceConfigWithState,
  query: string,
  options: SearchCommandOptions,
): Promise<void> {
  const meilisearchUrl = getMeilisearchUrl(spaceConfig);
  const apiKey = getMeilisearchApiKey(spaceConfig);
  const indexName = getIndexNameFromConfig(spaceConfig);
  const client = new SearchClient(meilisearchUrl, apiKey);

  const searchOptions: SearchOptions = {
    labels: options.labels,
    author: options.author,
    limit: options.limit || 10,
    createdAfter: options.createdAfter,
    createdBefore: options.createdBefore,
    updatedAfter: options.updatedAfter,
    updatedBefore: options.updatedBefore,
    createdWithin: options.createdWithin,
    updatedWithin: options.updatedWithin,
    stale: options.stale,
    sort: options.sort,
  };

  const response = await client.search(indexName, query, searchOptions);

  if (options.json) {
    console.log(formatResultsJson(response));
  } else if (options.xml) {
    console.log(formatResultsXml(response));
  } else {
    console.log(formatResultsHuman(response));
  }
}

/**
 * Execute index command
 */
async function executeIndex(
  spaceConfig: SpaceConfigWithState,
  directory: string,
  options: SearchCommandOptions,
): Promise<void> {
  const meilisearchUrl = getMeilisearchUrl(spaceConfig);
  const apiKey = getMeilisearchApiKey(spaceConfig);
  const indexName = getIndexNameFromConfig(spaceConfig);
  const client = new SearchClient(meilisearchUrl, apiKey);

  const spinner = ora(`Indexing space: ${spaceConfig.spaceName} (${spaceConfig.spaceKey})`).start();

  try {
    // Check connection first
    spinner.text = 'Connecting to Meilisearch...';
    await client.ensureAvailable();

    // Scan directory
    spinner.text = 'Scanning markdown files...';
    const result = scanDirectory(directory);

    if (options.dryRun) {
      spinner.stop();
      console.log(chalk.bold('Dry run - no changes made'));
      console.log('');
      console.log(`  Files scanned: ${result.scannedFiles}`);
      console.log(`  Files to index: ${result.indexedFiles}`);
      console.log(`  Files skipped: ${result.skippedFiles}`);
      if (result.errors.length > 0) {
        console.log('');
        console.log(chalk.yellow('Errors:'));
        for (const error of result.errors) {
          console.log(chalk.red(`  ${error}`));
        }
      }
      return;
    }

    if (result.documents.length === 0) {
      spinner.warn('No documents found to index');
      console.log(chalk.gray('Make sure you have pulled content with "cn pull" first.'));
      return;
    }

    // Clear existing index if force
    if (options.force) {
      spinner.text = 'Clearing existing index...';
      await client.deleteIndex(indexName);
    }

    // Index documents
    spinner.text = `Indexing ${result.documents.length} documents...`;
    await client.indexDocuments(indexName, result.documents);

    spinner.succeed(`Indexed ${result.documents.length} pages`);

    if (result.errors.length > 0) {
      console.log('');
      console.log(chalk.yellow(`Warnings: ${result.errors.length} file(s) had errors`));
    }
  } catch (error) {
    spinner.fail('Indexing failed');
    throw error;
  }
}

/**
 * Execute status command
 */
async function executeStatus(spaceConfig: SpaceConfigWithState | null, options: SearchCommandOptions): Promise<void> {
  const meilisearchUrl = getMeilisearchUrl(spaceConfig);
  const apiKey = getMeilisearchApiKey(spaceConfig);
  const indexName = spaceConfig ? getIndexNameFromConfig(spaceConfig) : 'unknown';
  const client = new SearchClient(meilisearchUrl, apiKey);

  const status = await client.getIndexStatus(indexName);

  if (options.json) {
    console.log(formatStatusJson(status, spaceConfig));
  } else if (options.xml) {
    console.log(formatStatusXml(status, spaceConfig));
  } else {
    console.log(formatStatusHuman(status, spaceConfig));
  }
}

/**
 * Search command entry point
 */
export async function searchCommand(options: SearchCommandOptions): Promise<void> {
  const directory = process.cwd();
  const spaceConfig = readSpaceConfig(directory);

  try {
    // Handle subcommands
    if (options.subcommand === 'status') {
      await executeStatus(spaceConfig, options);
      return;
    }

    if (options.subcommand === 'index') {
      if (!spaceConfig) {
        console.error(chalk.red('No space configuration found.'));
        console.log(chalk.gray('Run "cn clone <SPACE_KEY>" first to initialize a space.'));
        process.exit(EXIT_CODES.CONFIG_ERROR);
      }
      await executeIndex(spaceConfig, directory, options);
      return;
    }

    // Search query
    if (!options.query) {
      console.error(chalk.red('Search query is required.'));
      console.log(chalk.gray('Usage: cn search <query>'));
      process.exit(EXIT_CODES.INVALID_ARGUMENTS);
    }

    if (!spaceConfig) {
      console.error(chalk.red('No space configuration found.'));
      console.log(chalk.gray('Run "cn clone <SPACE_KEY>" first to initialize a space.'));
      process.exit(EXIT_CODES.CONFIG_ERROR);
    }

    await executeSearch(spaceConfig, options.query, options);
  } catch (error) {
    if (error instanceof MeilisearchConnectionError) {
      console.error(chalk.red(error.message));
      process.exit(EXIT_CODES.MEILISEARCH_CONNECTION);
    }
    if (error instanceof MeilisearchIndexError) {
      console.error(chalk.red(error.message));
      process.exit(EXIT_CODES.MEILISEARCH_INDEX);
    }
    throw error;
  }
}
