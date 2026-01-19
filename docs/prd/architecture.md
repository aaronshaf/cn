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
│   │       ├── clone.ts          # cn clone
│   │       ├── pull.ts           # cn pull
│   │       ├── push.ts           # cn push
│   │       ├── status.ts         # cn status
│   │       ├── tree.ts           # cn tree
│   │       ├── open.ts           # cn open
│   │       └── search.ts         # cn search
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
│   │   │   ├── html-converter.ts # Markdown → HTML (marked)
│   │   │   ├── frontmatter.ts    # YAML frontmatter handling
│   │   │   └── slugify.ts        # Title → filename
│   │   ├── search/
│   │   │   ├── index.ts          # Search facade
│   │   │   ├── client.ts         # Meilisearch client wrapper
│   │   │   ├── indexer.ts        # Scan files and build index
│   │   │   └── types.ts          # Search types
│   │   ├── file-scanner.ts       # Detect changed files for push
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
- `GET /wiki/api/v2/pages/{id}/labels` - Get page labels
- `GET /wiki/api/v2/folders/{id}` - Get folder details (discovered via page parentIds)
- `GET /wiki/api/v2/users/{accountId}` - Get user details (for author names and emails)
- `POST /wiki/api/v2/pages` - Create new page
- `PUT /wiki/api/v2/pages/{id}` - Update existing page

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
3. Discover folders referenced by pages (via parentId) and fetch folder details
4. Compute diff (added, modified, deleted pages)
5. For each changed page:
   - Fetch full content
   - Fetch labels
   - Fetch author and last modifier user details (name and email)
   - Convert HTML → Markdown with frontmatter
   - Resolve path including folder hierarchy
   - Write to filesystem
6. Update sync state

### 4. MarkdownConverter

Convert Confluence storage format to Markdown (pull).

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
- Page links → relative markdown paths (`./path/to/page.md`)

### 4b. HtmlConverter

Convert Markdown to Confluence storage format (push).

```typescript
class HtmlConverter {
  // Convert Markdown to Confluence Storage Format HTML
  convert(markdown: string): { html: string; warnings: string[] }
}
```

**Marked Custom Renderer:**
- Code blocks → Confluence code macro (`ac:structured-macro`)
- Blockquotes starting with "Info:", "Note:", "Warning:", "Tip:" → panel macros
- Tables → Confluence table format
- Relative `.md` links → Confluence page links (`<ac:link><ri:page>`)
- External links, bold, italic → standard HTML
- Warnings for unsupported elements (user mentions, local images, task lists)

### 5. FileScanner

Detect files that need to be pushed.

```typescript
// Scan for changed files in directory tree
function detectPushCandidates(directory: string): PushCandidate[]

interface PushCandidate {
  path: string
  type: 'new' | 'modified'
}
```

**Detection Logic:**
- New files: markdown files without `page_id` in frontmatter
- Modified files: file mtime > `synced_at` timestamp in frontmatter
- Excludes: `node_modules/`, `.git/`, `dist/`, `build/`, etc.

### 6. SpaceConfig

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

## Link Handling

### Overview

Confluence page links are converted to relative markdown paths for local navigation, then back to Confluence storage format on push.

### Pull: Confluence → Relative Paths

When syncing from Confluence, `<ac:link><ri:page>` elements are converted to relative markdown links:

```xml
<!-- Confluence storage format -->
<ac:link>
  <ri:page ri:content-title="Architecture Overview" ri:space-key="ENG" />
  <ac:plain-text-link-body><![CDATA[See Architecture]]></ac:plain-text-link-body>
</ac:link>

<!-- Becomes markdown -->
[See Architecture](./Architecture/Overview.md)
```

**Algorithm:**
1. Parse Confluence link to extract `ri:content-title` and optional `ri:space-key`
2. Look up target page in sync state by title (and space if cross-space)
3. Calculate relative path from current page to target page
4. Replace link with markdown format `[text](relative-path.md)`
5. Warn if target page not found in sync state

**Cross-space links:** Currently unsupported - preserved as full Confluence URLs with warning.

### Push: Relative Paths → Confluence

When pushing to Confluence, relative `.md` links are converted to Confluence page references:

```markdown
<!-- Local markdown -->
[See Architecture](./Architecture/Overview.md)

<!-- Becomes Confluence storage format -->
<ac:link>
  <ri:page ri:content-title="Architecture Overview" ri:space-key="ENG" />
  <ac:plain-text-link-body><![CDATA[See Architecture]]></ac:plain-text-link-body>
</ac:link>
```

**Algorithm:**
1. Detect markdown links with relative paths ending in `.md`
2. Resolve relative path to absolute filesystem path
3. Read target file's frontmatter to extract `title` and `space_key`
4. Generate Confluence link using `ri:content-title` and `ri:space-key`
5. Warn if target file doesn't exist or lacks required frontmatter

**Note:** Confluence internally resolves `ri:content-title` to page IDs, so links survive title changes in Confluence.

### Title Changes & File Renaming

When a page title changes in Confluence, the local file is automatically re-slugged to match:

**Detection:**
1. During pull, compare `title` in frontmatter vs. incoming page title
2. If different, calculate new slug from new title
3. If slug conflicts with existing file, append number suffix (`-2`, `-3`, etc.)
4. Rename file to new slug

**Reference Updates:**
1. Scan all markdown files in the space for links to the old path
2. Update relative paths to point to new location
3. Report files with updated references

**Example:**
```
Title changes: "Getting Started" → "Quick Start Guide"
File rename: getting-started.md → quick-start-guide.md
Update refs: ["Home.md", "README.md"] point to new path
```

## Data Flow

### Pull Flow (Confluence → Local)

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Confluence API │────▶│   SyncEngine     │────▶│  Local Files    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
         │                       │                        │
         │                       ▼                        │
         │              ┌──────────────────┐              │
         │              │ MarkdownConverter│              │
         │              │  (turndown)      │              │
         │              └──────────────────┘              │
         │                       │                        │
         ▼                       ▼                        ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Page Tree     │     │   Frontmatter    │     │ .confluence.json│
│                 │     │   + Markdown     │     │   Sync State    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

### Push Flow (Local → Confluence)

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Local Files    │────▶│  FileScanner     │────▶│  Push Command   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
         │                                                │
         │                                                ▼
         │                                       ┌──────────────────┐
         │                                       │  HtmlConverter   │
         │                                       │    (marked)      │
         │                                       └──────────────────┘
         │                                                │
         ▼                                                ▼
┌─────────────────┐                              ┌─────────────────┐
│   Frontmatter   │                              │ Confluence API  │
│   + Markdown    │                              │  POST/PUT Page  │
└─────────────────┘                              └─────────────────┘
         │                                                │
         ▼                                                ▼
┌─────────────────┐                              ┌─────────────────┐
│  Version Check  │                              │ Update Local    │
│                 │                              │  Frontmatter +  │
│                 │                              │  .confluence.json│
└─────────────────┘                              └─────────────────┘
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
- `turndown` - HTML to Markdown (pull)
- `marked` - Markdown to HTML (push)
- `meilisearch` - Search engine client (for `cn search`)
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
   - Bidirectional sync (pull and push)
   - Version conflict detection prevents accidental overwrites
   - Rate limiting awareness with exponential backoff
   - Graceful handling of 401/403

3. **File Operations:**
   - Sanitize filenames (prevent path traversal)
   - Validate paths stay within sync directory
   - Safe handling of symlinks
