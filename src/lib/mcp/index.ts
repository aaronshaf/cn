/**
 * MCP server module facade
 * Re-exports all MCP server functionality
 */

export { createMcpServer, startMcpServer } from './server.js';
export { handleReadPage, handleSearch, InvalidParamsError, McpPageNotFoundError, resolvePagePath } from './handlers.js';
export { ReadPageInputSchema, SearchInputSchema, TOOL_DESCRIPTIONS } from './tools.js';
export type {
  McpSearchResult,
  McpServerConfig,
  ReadPageToolInput,
  ReadPageToolOutput,
  SearchToolInput,
  SearchToolOutput,
} from './types.js';
export { toSearchOptions } from './types.js';
