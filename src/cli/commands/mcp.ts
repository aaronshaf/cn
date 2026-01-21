/**
 * cn mcp command - Launch MCP server for AI assistant integration
 */

import { resolve } from 'node:path';
import { EXIT_CODES, MeilisearchConnectionError, MeilisearchIndexError } from '../../lib/errors.js';
import { createMcpServer, startMcpServer, type McpServerConfig } from '../../lib/mcp/index.js';
import { DEFAULT_MEILISEARCH_URL, getIndexName, SearchClient } from '../../lib/search/index.js';
import { readSpaceConfig, type SpaceConfigWithState } from '../../lib/space-config.js';

/**
 * Log to stderr (MCP requires stdout for JSON-RPC messages only)
 */
function log(message: string): void {
  console.error(`cn mcp: ${message}`);
}

/**
 * Get Meilisearch URL from config or use default
 */
function getMeilisearchUrl(spaceConfig: SpaceConfigWithState): string {
  return spaceConfig.search?.meilisearchUrl || DEFAULT_MEILISEARCH_URL;
}

/**
 * Get Meilisearch API key from config
 */
function getMeilisearchApiKey(spaceConfig: SpaceConfigWithState): string | null {
  return spaceConfig.search?.apiKey ?? null;
}

/**
 * Get index name from config or generate from space key
 */
function getIndexNameFromConfig(spaceConfig: SpaceConfigWithState): string {
  return spaceConfig.search?.indexName || getIndexName(spaceConfig.spaceKey);
}

export interface McpCommandOptions {
  /** Path to space directory (defaults to current directory) */
  path?: string;
}

/**
 * MCP command entry point
 */
export async function mcpCommand(options: McpCommandOptions): Promise<void> {
  const workspacePath = resolve(options.path || process.cwd());

  // Validate .confluence.json exists
  const spaceConfig = readSpaceConfig(workspacePath);
  if (!spaceConfig) {
    log(`Error: Not a cn space. Run 'cn clone' first or specify a path.`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const meilisearchUrl = getMeilisearchUrl(spaceConfig);
  const apiKey = getMeilisearchApiKey(spaceConfig);
  const indexName = getIndexNameFromConfig(spaceConfig);

  // Check Meilisearch connection (fail fast)
  const client = new SearchClient(meilisearchUrl, apiKey);
  try {
    await client.ensureAvailable();
  } catch (error) {
    if (error instanceof MeilisearchConnectionError) {
      log(`Error: ${error.message}`);
      process.exit(EXIT_CODES.MEILISEARCH_CONNECTION);
    }
    throw error;
  }

  // Check index exists and has documents (fail fast)
  try {
    const status = await client.getIndexStatus(indexName);
    if (status.documentCount === null || status.documentCount === 0) {
      log(`Error: No search index found for space "${spaceConfig.spaceKey}". Run 'cn search index' first.`);
      process.exit(EXIT_CODES.MEILISEARCH_INDEX);
    }

    log(`serving space "${spaceConfig.spaceName}" (${spaceConfig.spaceKey})`);
    log(`Meilisearch connected at ${meilisearchUrl}`);
    log(`index "${indexName}" ready (${status.documentCount} documents)`);
  } catch (error) {
    if (error instanceof MeilisearchIndexError) {
      log(`Error: ${error.message}`);
      process.exit(EXIT_CODES.MEILISEARCH_INDEX);
    }
    throw error;
  }

  // Create server config
  const config: McpServerConfig = {
    workspacePath,
    indexName,
    meilisearchUrl,
    meilisearchApiKey: apiKey,
    spaceKey: spaceConfig.spaceKey,
    spaceName: spaceConfig.spaceName,
  };

  // Create and start server
  const server = createMcpServer(config, spaceConfig);

  // Setup graceful shutdown
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log('Shutting down...');
    await server.close();
    process.exit(EXIT_CODES.SUCCESS);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start server
  log('MCP server running on stdio');
  await startMcpServer(server, () => {
    log('Transport closed');
    process.exit(EXIT_CODES.SUCCESS);
  });
}
