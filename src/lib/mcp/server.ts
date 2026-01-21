/**
 * MCP server setup and transport configuration
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MeilisearchConnectionError, MeilisearchIndexError } from '../errors.js';
import { SearchClient } from '../search/index.js';
import type { SpaceConfigWithState } from '../space-config.js';
import { handleReadPage, handleSearch, InvalidParamsError, McpPageNotFoundError } from './handlers.js';
import { ReadPageInputSchema, SearchInputSchema, TOOL_DESCRIPTIONS } from './tools.js';
import type { McpServerConfig, ReadPageToolInput, SearchToolInput } from './types.js';

/**
 * Create and configure an MCP server
 */
export function createMcpServer(config: McpServerConfig, spaceConfig: SpaceConfigWithState): McpServer {
  // Create a shared SearchClient for reuse across search calls
  const searchClient = new SearchClient(config.meilisearchUrl, config.meilisearchApiKey);

  const server = new McpServer(
    {
      name: 'cn-confluence',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Register search tool
  server.registerTool(
    'search',
    {
      description: TOOL_DESCRIPTIONS.search,
      inputSchema: SearchInputSchema,
    },
    async (args) => {
      try {
        const input = args as SearchToolInput;
        const result = await handleSearch(input, config, searchClient);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        if (error instanceof MeilisearchConnectionError) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${error.message}` }],
            isError: true,
          };
        }
        if (error instanceof MeilisearchIndexError) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${error.message}` }],
            isError: true,
          };
        }
        throw error;
      }
    },
  );

  // Register read_page tool
  server.registerTool(
    'read_page',
    {
      description: TOOL_DESCRIPTIONS.read_page,
      inputSchema: ReadPageInputSchema,
    },
    async (args) => {
      try {
        const input = args as ReadPageToolInput;
        const result = await handleReadPage(input, config, spaceConfig);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        if (error instanceof InvalidParamsError) {
          return {
            content: [{ type: 'text' as const, text: `Invalid params: ${error.message}` }],
            isError: true,
          };
        }
        if (error instanceof McpPageNotFoundError) {
          return {
            content: [{ type: 'text' as const, text: error.message }],
            isError: true,
          };
        }
        throw error;
      }
    },
  );

  return server;
}

/**
 * Start the MCP server with stdio transport
 */
export async function startMcpServer(server: McpServer, onClose?: () => void): Promise<void> {
  const transport = new StdioServerTransport();

  // Handle transport close
  transport.onclose = () => {
    onClose?.();
  };

  // Connect server to transport
  await server.connect(transport);
}
