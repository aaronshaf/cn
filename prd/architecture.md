# cn - Architecture

## Project Structure

```
cn/
├── src/
│   ├── cli.ts                    # Entry point (shebang)
│   ├── cli/
│   │   ├── index.ts              # Command router
│   │   └── commands/
│   │       ├── setup.ts          # cn setup
│   │       ├── sync.ts           # cn sync
│   │       ├── status.ts         # cn status
│   │       ├── tree.ts           # cn tree
│   │       └── open.ts           # cn open
│   ├── lib/
│   │   ├── config.ts             # ConfigManager (~/.cn/config.json)
│   │   ├── confluence-client/
│   │   │   ├── index.ts          # ConfluenceClient facade
│   │   │   ├── confluence-client-base.ts
│   │   │   ├── confluence-client-pages.ts
│   │   │   ├── confluence-client-spaces.ts
│   │   │   └── confluence-client-types.ts
│   │   ├── sync/
│   │   │   ├── sync-engine.ts    # Core sync logic
│   │   │   ├── sync-state.ts     # Track sync state
│   │   │   └── conflict-resolver.ts
│   │   ├── markdown/
│   │   │   ├── converter.ts      # HTML → Markdown (turndown)
│   │   │   ├── frontmatter.ts    # YAML frontmatter handling
│   │   │   └── slugify.ts        # Title → filename
│   │   └── space-config.ts       # .confluence.json handling
│   └── test/
│       ├── mocks/
│       │   ├── server.ts         # MSW setup
│       │   └── handlers.ts       # API mock handlers
│       └── fixtures/
│           └── confluence-api-responses.ts
├── prd/                          # PRD documents
├── package.json
├── tsconfig.json
├── biome.json
└── bunfig.toml
```

## Core Components

### 1. ConfigManager

Manages global user configuration stored in `~/.cn/config.json`.

```typescript
// ~/.cn/config.json
{
  "confluenceUrl": "https://company.atlassian.net",
  "email": "user@example.com",
  "apiToken": "****"
}
```

**Responsibilities:**
- Read/write configuration with Effect
- Validate configuration schema
- Set file permissions (600)
- Provide both async and Effect-based APIs

### 2. ConfluenceClient

Modular client for Confluence REST API v2.

```typescript
class ConfluenceClient extends ConfluenceClientBase {
  private pagesClient: ConfluenceClientPages
  private spacesClient: ConfluenceClientSpaces
}
```

**API Endpoints:**
- `GET /wiki/api/v2/spaces` - List spaces
- `GET /wiki/api/v2/spaces/{id}` - Get space details
- `GET /wiki/api/v2/pages` - List pages (with pagination)
- `GET /wiki/api/v2/pages/{id}` - Get page content
- `GET /wiki/api/v2/pages/{id}/children` - Get child pages

**Authentication:**
- Basic Auth: `email:apiToken` base64 encoded
- Header: `Authorization: Basic <token>`

### 3. SyncEngine

Core synchronization logic.

```typescript
class SyncEngine {
  // Fetch full page tree from Confluence
  fetchPageTree(spaceKey: string): Effect<PageTree, SyncError>

  // Compare remote vs local state
  computeDiff(remote: PageTree, local: SyncState): SyncDiff

  // Apply changes to local filesystem
  applyChanges(diff: SyncDiff, outputDir: string): Effect<SyncResult, SyncError>
}
```

**Sync Algorithm:**
1. Load local `.confluence.json` and sync state
2. Fetch page tree from Confluence API
3. Compute diff (added, modified, deleted pages)
4. For each changed page:
   - Fetch full content
   - Convert HTML → Markdown
   - Write to filesystem
5. Update sync state

### 4. MarkdownConverter

Convert Confluence storage format to Markdown.

```typescript
class MarkdownConverter {
  // Configure turndown with Confluence-specific rules
  constructor(options: ConverterOptions)

  // Convert HTML to Markdown
  convert(html: string): string

  // Add frontmatter to markdown
  addFrontmatter(markdown: string, metadata: PageMetadata): string
}
```

**Turndown Rules:**
- Code blocks with language detection
- Tables
- Task lists
- Mentions → plain text
- Macros → stripped with warning

### 5. SpaceConfig

Manages per-folder `.confluence.json` files.

```typescript
// .confluence.json
{
  "spaceKey": "ENGINEERING",
  "spaceId": "123456",
  "spaceName": "Engineering",
  "lastSync": "2024-01-15T10:30:00Z",
  "syncState": {
    "pages": {
      "page-id-1": {
        "version": 5,
        "lastModified": "2024-01-14T08:00:00Z",
        "localPath": "Getting-Started/index.md"
      }
    }
  }
}
```

## Data Flow

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Confluence API │────▶│   SyncEngine     │────▶│  Local Files    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
         │                       │                        │
         │                       ▼                        │
         │              ┌──────────────────┐              │
         │              │ MarkdownConverter│              │
         │              └──────────────────┘              │
         │                       │                        │
         ▼                       ▼                        ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Page Tree     │     │   Frontmatter    │     │ .confluence.json│
│                 │     │   + Markdown     │     │   Sync State    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## Error Handling

Using Effect for type-safe errors:

```typescript
// Error types
class ConfigError extends Error { readonly _tag = 'ConfigError' }
class ApiError extends Error { readonly _tag = 'ApiError' }
class SyncError extends Error { readonly _tag = 'SyncError' }
class FileSystemError extends Error { readonly _tag = 'FileSystemError' }

// Effect-based operations
const syncSpace = (spaceKey: string): Effect<
  SyncResult,
  ConfigError | ApiError | SyncError | FileSystemError
>
```

## Dependencies

**Production:**
- `effect` - Functional error handling
- `@effect/schema` - Schema validation
- `turndown` - HTML to Markdown
- `@inquirer/prompts` - Interactive prompts
- `chalk` - Terminal colors
- `ora` - Spinners
- `gray-matter` - Frontmatter parsing
- `slugify` - Filename generation

**Development:**
- `typescript`
- `@biomejs/biome` - Linting/formatting
- `bun-types`
- `msw` - API mocking for tests

## Security Considerations

1. **Credentials Storage:**
   - Config file at `~/.cn/config.json` with 600 permissions
   - API tokens never logged or displayed
   - No credentials in sync state files

2. **API Access:**
   - Read-only operations only (initial release)
   - Rate limiting awareness
   - Graceful handling of 401/403

3. **File Operations:**
   - Sanitize filenames (prevent path traversal)
   - Validate paths stay within sync directory
   - Safe handling of symlinks
