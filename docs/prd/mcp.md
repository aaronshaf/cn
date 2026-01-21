# cn mcp - Product Requirements Document

## Problem Statement

Users working with AI assistants (Claude Code, Claude Desktop, VS Code Copilot) cannot easily search their synced Confluence documentation from within their AI workflow. Current options are inadequate:

1. **Copy/paste content** - Manual, breaks flow, limited context window
2. **Ask AI to read files** - AI must guess paths, no search capability, slow for large spaces
3. **Switch to terminal** - Run `cn search`, copy results back, context switching overhead

Users need a way to expose their indexed Confluence content directly to AI assistants via the Model Context Protocol (MCP), enabling seamless documentation lookup within their existing AI workflows.

## Goals

| Goal | Metric | Target |
|------|--------|--------|
| Seamless AI integration | Works with any MCP client | Claude Code, Desktop, VS Code |
| Fast search | Query response time | < 100ms (leverages Meilisearch) |
| Zero config for users | Setup complexity | Single command to start |
| Full search parity | Feature coverage | All `cn search` filters supported |

## Non-Goals

- HTTP/SSE transport (stdio only for v1)
- Remote/networked access (local only)
- Cross-space search (single space per server instance)
- MCP Resources (tools only for v1)
- Fallback to grep-style search (Meilisearch required)

## User Personas

### AI-Assisted Developer
- Uses Claude Code or similar AI coding assistants daily
- Has Confluence documentation synced locally via `cn clone`/`cn pull`
- Wants to ask AI questions that require documentation context
- Values staying in flow without context switching

### Documentation Consumer
- Uses Claude Desktop for research and writing
- References internal documentation frequently
- Wants AI to cite specific pages from company docs
- Benefits from search + read capabilities

## Solution Overview

Add `cn mcp` command that launches an MCP server over stdio transport. The server exposes two tools (`search` and `read_page`) that allow MCP clients to query the local Meilisearch index and read page content.

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   MCP Client    │────▶│    cn mcp        │────▶│   Meilisearch   │
│ (Claude Code)   │stdio│  (MCP Server)    │     │  (localhost)    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌──────────────────┐
                        │  Local Markdown  │
                        │     Files        │
                        └──────────────────┘
```

## Prerequisites

1. **Meilisearch running** - Same requirement as `cn search`
2. **Index exists** - User must run `cn search index` first
3. **Space synced** - Directory must have `.confluence.json`

## Command

### cn mcp

Launch an MCP server for the current (or specified) space.

```
cn mcp [path] [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[path]` | Path to space directory (default: current directory) |

**Options:**

| Option | Description |
|--------|-------------|
| `--help` | Show help |

**Examples:**

```bash
# Start MCP server for current directory
cn mcp

# Start MCP server for specific space
cn mcp ~/docs/engineering-wiki

# Use with Claude Code (in mcp.json config)
# See Configuration section below
```

**Startup Behavior:**

1. Validate `.confluence.json` exists in target directory
2. Connect to Meilisearch (fail with clear error if unavailable)
3. Verify index exists for the space (fail if not indexed)
4. Start stdio transport and begin accepting MCP messages

**Startup Output (stderr):**

```
cn mcp: serving space "Engineering" (ENG)
cn mcp: Meilisearch connected at http://localhost:7700
cn mcp: index "cn-eng" ready (142 documents)
cn mcp: MCP server running on stdio
```

## MCP Tools

### search

Search indexed Confluence content.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Search query (supports typo tolerance)"
    },
    "limit": {
      "type": "integer",
      "description": "Maximum results to return",
      "default": 10,
      "minimum": 1,
      "maximum": 100
    },
    "labels": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Filter by labels (OR logic)"
    },
    "author": {
      "type": "string",
      "description": "Filter by author email"
    },
    "created_after": {
      "type": "string",
      "format": "date",
      "description": "Filter: created after date (YYYY-MM-DD)"
    },
    "created_before": {
      "type": "string",
      "format": "date",
      "description": "Filter: created before date (YYYY-MM-DD)"
    },
    "updated_after": {
      "type": "string",
      "format": "date",
      "description": "Filter: updated after date (YYYY-MM-DD)"
    },
    "updated_before": {
      "type": "string",
      "format": "date",
      "description": "Filter: updated before date (YYYY-MM-DD)"
    },
    "sort": {
      "type": "string",
      "enum": ["created_at", "-created_at", "updated_at", "-updated_at"],
      "description": "Sort order (prefix with - for descending)"
    }
  },
  "required": ["query"]
}
```

**Output:**

```json
{
  "results": [
    {
      "id": "page-abc-123",
      "title": "Authentication Guide",
      "path": "getting-started/authentication.md",
      "snippet": "...handles OAuth2 authentication flows for the API...",
      "labels": ["documentation", "security"],
      "author": "john.doe@example.com",
      "created_at": "2024-01-10T10:00:00Z",
      "updated_at": "2024-06-15T14:30:00Z",
      "url": "https://company.atlassian.net/wiki/spaces/ENG/pages/123456"
    }
  ],
  "total": 3,
  "query": "authentication"
}
```

### read_page

Read the full content of a specific page.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Relative path to the markdown file (e.g., 'getting-started/authentication.md')"
    },
    "id": {
      "type": "string",
      "description": "Page ID from frontmatter or search results"
    }
  },
  "oneOf": [
    { "required": ["path"] },
    { "required": ["id"] }
  ]
}
```

**Output:**

```json
{
  "id": "page-abc-123",
  "title": "Authentication Guide",
  "path": "getting-started/authentication.md",
  "content": "# Authentication Guide\n\nThis guide covers...",
  "metadata": {
    "labels": ["documentation", "security"],
    "author": "john.doe@example.com",
    "created_at": "2024-01-10T10:00:00Z",
    "updated_at": "2024-06-15T14:30:00Z",
    "url": "https://company.atlassian.net/wiki/spaces/ENG/pages/123456"
  }
}
```

## Configuration

### Claude Code

Add to `~/.claude/mcp.json` or project `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "confluence-eng": {
      "command": "cn",
      "args": ["mcp", "/path/to/engineering-wiki"]
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "confluence-eng": {
      "command": "cn",
      "args": ["mcp", "/path/to/engineering-wiki"]
    }
  }
}
```

### VS Code (Copilot)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "confluence-eng": {
      "command": "cn",
      "args": ["mcp", "${workspaceFolder}/docs/wiki"]
    }
  }
}
```

## Architecture

### New Files

```
src/
├── lib/
│   └── mcp/
│       ├── index.ts           # MCP server setup
│       ├── server.ts          # McpServer instance and transport
│       ├── tools/
│       │   ├── search.ts      # search tool implementation
│       │   └── read-page.ts   # read_page tool implementation
│       └── types.ts           # MCP-specific types
└── cli/
    └── commands/
        └── mcp.ts             # cn mcp command
```

### Dependencies

Add to `package.json`:

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

### Key Implementation Details

1. **stdio transport**: Use `StdioServerTransport` from SDK
2. **Logging**: All logs to stderr (stdout reserved for JSON-RPC)
3. **Graceful shutdown**: Handle SIGINT/SIGTERM to close connections
4. **Error responses**: Return MCP-compliant error objects

## Error Handling

### Startup Errors

| Condition | Exit Code | stderr Message |
|-----------|-----------|----------------|
| No .confluence.json | 1 | `Error: Not a cn space. Run 'cn clone' first or specify a path.` |
| Meilisearch unavailable | 9 | `Error: Meilisearch not available at http://localhost:7700. Start it with: docker run -d -p 7700:7700 getmeili/meilisearch:latest` |
| Index not found | 10 | `Error: No search index found for space "ENG". Run 'cn search index' first.` |

### Tool Errors

Return MCP error responses (not exit codes):

| Condition | Error Code | Message |
|-----------|------------|---------|
| Invalid query params | -32602 | `Invalid params: {details}` |
| Page not found | -32602 | `Page not found: {path_or_id}` |
| Search failed | -32603 | `Search error: {details}` |

## Testing Strategy

### Unit Tests

- `mcp/server.test.ts` - Server initialization, tool registration
- `mcp/tools/search.test.ts` - Search tool input validation, output formatting
- `mcp/tools/read-page.test.ts` - Page reading, path/ID resolution

### Integration Tests

- End-to-end MCP message flow (mock stdio)
- Real Meilisearch queries
- Error handling paths

### Manual Testing

```bash
# Test with MCP Inspector
npx @anthropic-ai/mcp-inspector cn mcp

# Test with Claude Code
claude --mcp-config test-mcp.json
```

## Security Considerations

1. **Local only**: stdio transport cannot be accessed remotely
2. **Read-only**: No tools modify files or Confluence
3. **Path validation**: `read_page` validates paths are within space directory
4. **No credentials exposed**: MCP responses never include API tokens

## Rollout Plan

### Phase 1: Core Implementation
- `cn mcp` command with stdio transport
- `search` tool with full filter support
- `read_page` tool with path and ID lookup
- Documentation and examples

### Phase 2: Polish
- MCP Inspector compatibility testing
- Error message improvements
- Performance optimization

### Phase 3: Future Enhancements (out of scope for v1)
- `list_pages` tool for browsing
- MCP Resources for direct file access
- HTTP transport option
- Multi-space support

## Open Questions

1. **Tool naming**: Should tools be namespaced (e.g., `confluence_search`) or simple (`search`)?
   - Proposal: Simple names since server is already Confluence-specific

2. **Snippet length**: How long should search result snippets be?
   - Proposal: 200 characters, matching `cn search` behavior

3. **Content format**: Should `read_page` return raw markdown or strip frontmatter?
   - Proposal: Return content without frontmatter, metadata in separate field

## References

- [Model Context Protocol Specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Servers Repository](https://github.com/modelcontextprotocol/servers)
- [cn search PRD](./search.md)
- [ADR-0021: Meilisearch for Local Search](../adr/0021-use-meilisearch-for-local-search.md)
