# cn search - Product Requirements Document

## Problem Statement

Users with large Confluence spaces (100+ pages) struggle to find relevant content quickly. Current options are inadequate:

1. **grep/ripgrep on local files** - No typo tolerance, no relevance ranking, requires regex knowledge
2. **Confluence web search** - Requires network, slow, cluttered with unrelated spaces
3. **Manual browsing** - Impractical for large spaces, relies on memory of page structure

Users need fast, typo-tolerant, offline search across their synced Confluence content with relevance ranking and filtering capabilities.

## Goals

| Goal | Metric | Target |
|------|--------|--------|
| Fast search | Query response time | < 50ms for 1000+ pages |
| Typo tolerance | User can find "authentication" by typing "authentcation" | Works correctly |
| Offline capable | Search works without network | 100% offline |
| Filterable | Filter by labels, author, date | Supported |
| Index freshness | Index updates after pull | Automatic via hook |

## Non-Goals

- Real-time sync with Confluence (search is local-only)
- Semantic/AI search (full-text only for v1)
- Cross-space search (index per space)
- Search result pagination in v1 (top N results)

## User Personas

### Power User
- Has multiple Confluence spaces synced locally
- Searches frequently for specific topics
- Values speed and keyboard-driven workflow
- Wants to filter by labels or author

### Casual User
- Uses search occasionally
- May not remember exact page titles
- Benefits from typo tolerance
- Prefers simple commands

## Solution Overview

Integrate [Meilisearch](https://www.meilisearch.com/) as a local search engine. Users run Meilisearch via Docker or binary, and `cn` indexes local markdown content for fast, typo-tolerant search.

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Local Markdown │────▶│  cn search index │────▶│   Meilisearch   │
│     Files       │     │                  │     │  (localhost)    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                         │
                                                         ▼
┌─────────────────┐                              ┌─────────────────┐
│  cn search      │─────────────────────────────▶│  Search Results │
│    "query"      │                              │  (ranked)       │
└─────────────────┘                              └─────────────────┘
```

## Prerequisites

Users must run Meilisearch locally:

```bash
# Option 1: Docker (recommended)
docker run -d -p 7700:7700 \
  -v $(pwd)/meili_data:/meili_data \
  getmeili/meilisearch:latest

# Option 2: Homebrew (macOS)
brew install meilisearch
meilisearch --db-path ./meili_data

# Option 3: Direct binary
curl -L https://install.meilisearch.com | sh
./meilisearch --db-path ./meili_data
```

## Commands

### cn search

Search indexed content.

```
cn search <query> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--labels <label>` | Filter by label (can be repeated) |
| `--author <email>` | Filter by author email |
| `--created-after <date>` | Documents created after date (YYYY-MM-DD) |
| `--created-before <date>` | Documents created before date (YYYY-MM-DD) |
| `--updated-after <date>` | Documents updated after date (YYYY-MM-DD) |
| `--updated-before <date>` | Documents updated before date (YYYY-MM-DD) |
| `--created-within <duration>` | Created within duration (e.g., 30d, 2w, 3m, 1y) |
| `--updated-within <duration>` | Updated within duration (e.g., 7d, 2w) |
| `--stale <duration>` | Not updated within duration (e.g., 90d, 6m) |
| `--sort <field>` | Sort by created_at or updated_at (prefix with - for desc) |
| `--limit <n>` | Max results (default: 10) |
| `--json` | Output as JSON |
| `--xml` | Output as XML |

**Examples:**

```bash
# Basic search
cn search "authentication"

# Search with typo
cn search "authentcation"  # Still finds "authentication"

# Filter by label
cn search "api" --labels documentation

# Filter by author
cn search "setup" --author "john.doe@example.com"

# Multiple filters
cn search "config" --labels api --labels internal

# JSON output for scripting
cn search "error handling" --json

# Date filtering - documents updated in last 30 days
cn search "api" --updated-within 30d

# Date filtering - stale documentation
cn search "" --stale 90d --labels documentation

# Absolute date range - content from 2024
cn search "kubernetes" --created-after 2024-01-01 --created-before 2024-12-31

# Sort by most recently updated
cn search "security" --sort -updated_at --limit 10

# Find oldest content
cn search "" --sort created_at --limit 20
```

**Output:**

```
$ cn search "authentication"
Found 3 results for "authentication"

1. Authentication Guide
   getting-started/authentication.md
   ...handles OAuth2 authentication flows for the API...

2. API Security
   api-reference/security.md
   ...token-based authentication using JWT...

3. SSO Configuration
   admin/sso-config.md
   ...SAML authentication setup for enterprise...
```

**XML Output:**

```xml
$ cn search "authentication" --xml
<search-results query="authentication" count="3">
  <result rank="1">
    <title>Authentication Guide</title>
    <path>getting-started/authentication.md</path>
    <page_id>page-abc-123</page_id>
    <labels>
      <label>documentation</label>
      <label>security</label>
    </labels>
    <snippet>...handles OAuth2 authentication flows for the API...</snippet>
  </result>
  <!-- ... -->
</search-results>
```

### cn search index

Build or update the search index.

```
cn search index [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--force` | Rebuild index from scratch |
| `--dry-run` | Show what would be indexed |

**Examples:**

```bash
# Build/update index
cn search index

# Force full rebuild
cn search index --force

# Preview indexing
cn search index --dry-run
```

**Output:**

```
$ cn search index
Indexing space: Engineering (ENG)
  Scanning markdown files...
  Found 142 pages

  Connecting to Meilisearch (http://localhost:7700)...
  Indexing documents...

✓ Indexed 142 pages in 1.2s
```

### cn search status

Check search index status and Meilisearch connection.

```
cn search status
```

**Output:**

```
$ cn search status
Search Status
  Meilisearch: ✓ Connected (http://localhost:7700)
  Index: cn-eng (142 documents)
  Last indexed: 2024-01-15 10:30:00
  Space: Engineering (ENG)
```

**Output (Not Connected):**

```
$ cn search status
Search Status
  Meilisearch: ✗ Not connected

  To start Meilisearch:
    docker run -d -p 7700:7700 getmeili/meilisearch:latest
```

## Configuration

### Space Config: `.confluence.json`

Add optional search configuration:

```json
{
  "spaceKey": "ENG",
  "spaceId": "123456",
  "spaceName": "Engineering",
  "search": {
    "meilisearchUrl": "http://localhost:7700",
    "apiKey": null,
    "indexName": "cn-eng"
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `meilisearchUrl` | `http://localhost:7700` | Meilisearch server URL |
| `apiKey` | `null` | API key (if Meilisearch requires auth) |
| `indexName` | `cn-{spaceKey}` | Index name in Meilisearch |

### Global Config: `~/.cn/config.json`

Optional global Meilisearch defaults:

```json
{
  "confluenceUrl": "https://company.atlassian.net",
  "email": "user@example.com",
  "apiToken": "****",
  "search": {
    "meilisearchUrl": "http://localhost:7700",
    "apiKey": null
  }
}
```

## Data Model

### Indexed Document

Each markdown file is indexed as a document:

```typescript
interface SearchDocument {
  // Primary key
  id: string                // page_id from frontmatter

  // Searchable fields
  title: string
  content: string           // Full markdown body (without frontmatter)

  // Filterable fields
  space_key: string
  labels: string[]
  author_email: string
  last_modifier_email: string

  // Sortable fields
  created_at: number        // Unix timestamp
  updated_at: number        // Unix timestamp

  // Display fields
  local_path: string
  url: string
  parent_title: string | null
}
```

### Meilisearch Index Settings

```typescript
const indexSettings = {
  searchableAttributes: [
    'title',      // Highest priority
    'content'     // Lower priority
  ],
  filterableAttributes: [
    'space_key',
    'labels',
    'author_email',
    'last_modifier_email'
  ],
  sortableAttributes: [
    'created_at',
    'updated_at'
  ],
  rankingRules: [
    'words',
    'typo',
    'proximity',
    'attribute',
    'sort',
    'exactness'
  ]
}
```

## Architecture

### New Files

```
src/
├── lib/
│   └── search/
│       ├── index.ts           # Search facade
│       ├── indexer.ts         # Build index from files
│       ├── client.ts          # Meilisearch client wrapper
│       └── types.ts           # Search types
└── cli/
    └── commands/
        └── search.ts          # cn search command
```

### Dependencies

Add to `package.json`:

```json
{
  "dependencies": {
    "meilisearch": "^0.44.0"
  }
}
```

## Error Handling

| Error | Exit Code | Message |
|-------|-----------|---------|
| Meilisearch not running | 9 | `Meilisearch not available at {url}. Start it with: docker run -d -p 7700:7700 getmeili/meilisearch:latest` |
| Index not found | 10 | `No search index found. Run 'cn search index' first.` |
| No results | 0 | `No results found for "{query}"` |
| Invalid filter | 6 | `Invalid filter: {details}` |

## Integration with Pull

After `cn pull`, automatically suggest re-indexing:

```
$ cn pull
✓ Pull complete: 5 added, 2 modified, 1 deleted

Tip: Run 'cn search index' to update the search index.
```

Future enhancement: Add `--index` flag to pull:

```
$ cn pull --index
✓ Pull complete: 5 added, 2 modified, 1 deleted
✓ Search index updated
```

## Testing Strategy

### Unit Tests

- `indexer.test.ts` - Document extraction from markdown
- `client.test.ts` - Meilisearch client wrapper (mocked)
- `search.test.ts` - Search command parsing

### Integration Tests

- Real Meilisearch instance (Docker in CI)
- Index creation and search queries
- Filter combinations

### Test Fixtures

```typescript
// test/fixtures/search-documents.ts
export const searchFixtures = [
  {
    id: 'page-1',
    title: 'Authentication Guide',
    content: 'OAuth2 authentication flows...',
    labels: ['documentation', 'security'],
    // ...
  }
]
```

## Rollout Plan

### Phase 1: Core Search
- `cn search <query>` - basic search
- `cn search index` - build index
- `cn search status` - check connection

### Phase 2: Filters
- `--labels` filter
- `--author` filter
- `--limit` option

### Phase 3: Integration
- `cn pull --index` flag
- Auto-index suggestion after pull

### Phase 4: Enhancements (Future)
- `--sort` option (by date, relevance)
- Highlighted snippets in results
- Interactive search mode (fzf-style)

## Open Questions

1. **Index location**: Should Meilisearch data be stored in the space folder or globally?
   - Proposal: Global `~/.cn/meili_data` or user-managed

2. **Multi-space search**: Should users be able to search across all synced spaces?
   - Proposal: Defer to v2, single-space for now

3. **Stale index warning**: Warn if index is older than last sync?
   - Proposal: Yes, show warning in search results

## References

- [Meilisearch Documentation](https://www.meilisearch.com/docs)
- [Meilisearch JavaScript SDK](https://github.com/meilisearch/meilisearch-js)
- [ADR-0011: LLM-friendly XML output](../adr/0011-llm-friendly-xml-output.md)

---

**Sources (PRD Best Practices):**
- [Product School PRD Template](https://productschool.com/blog/product-strategy/product-template-requirements-document-prd)
- [Aha! PRD Best Practices](https://www.aha.io/roadmapping/guide/requirements-management/what-is-a-prd-(product-requirements-document))
- [Perforce PRD Guide](https://www.perforce.com/blog/alm/how-write-product-requirements-document-prd)
- [Atlassian PRD Guide](https://www.atlassian.com/agile/product-management/requirements)
