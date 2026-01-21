# ADR 0024: Frontmatter as Source of Truth for Sync State

## Status

Accepted

## Context

The `.confluence.json` file stores a `pages` object with full `PageSyncInfo` for every page:

```typescript
interface PageSyncInfo {
  pageId: string;
  version: number;
  lastModified?: string;
  localPath: string;
  title?: string;
}
```

With thousands of pages, this creates several problems:

1. **Large file size**: Several MB for large spaces
2. **Noisy git diffs**: Every sync updates version/lastModified for all changed pages
3. **Redundant data**: Frontmatter already contains version, title, and updated_at

The frontmatter in each markdown file already stores:
- `page_id`: Unique identifier
- `title`: Page title
- `version`: Current version number
- `updated_at`: Last modification timestamp
- `synced_at`: When the file was last synced

## Decision

Store only minimal page mappings in `.confluence.json`. Use frontmatter as the source of truth for version, title, and timestamps.

### Before (Legacy Format)

```json
{
  "spaceKey": "DOCS",
  "spaceId": "space-123",
  "spaceName": "Documentation",
  "pages": {
    "page-123": {
      "pageId": "page-123",
      "version": 5,
      "lastModified": "2024-01-14T08:00:00Z",
      "localPath": "docs/intro.md",
      "title": "Introduction"
    }
  }
}
```

### After (New Format)

```json
{
  "spaceKey": "DOCS",
  "spaceId": "space-123",
  "spaceName": "Documentation",
  "pages": {
    "page-123": "docs/intro.md"
  }
}
```

The version, title, and lastModified are read from each file's frontmatter when needed.

### New Module: page-state.ts

Introduces a `PageStateCache` that builds full page information from frontmatter:

```typescript
interface FullPageInfo {
  pageId: string;
  localPath: string;
  title: string;
  version: number;
  updatedAt?: string;
  syncedAt?: string;
}

interface PageStateCache {
  pages: Map<string, FullPageInfo>;
  pathToPageId: Map<string, string>;
}

function buildPageStateFromFiles(
  directory: string,
  pageMappings: Record<string, string>
): PageStateCache;
```

This cache is built on-demand when operations need full page information (e.g., diff computation, link resolution).

### Auto-Migration

When `readSpaceConfig()` detects the legacy format, it automatically migrates to the new format:

```typescript
function readSpaceConfig(directory: string): SpaceConfigWithState | null {
  const parsed = JSON.parse(content);

  // Detect legacy format
  if (isLegacyFormat(parsed.pages)) {
    const migratedPages = migrateLegacyPages(parsed.pages);
    const migrated = { ...parsed, pages: migratedPages };
    writeSpaceConfig(directory, migrated);
    return migrated;
  }

  return parsed;
}
```

## Rationale

### Why frontmatter is the better source of truth

1. **Already exists**: Every synced file has frontmatter with this metadata
2. **Self-contained**: Each file knows its own state without external lookup
3. **Git-friendly**: Frontmatter changes only when the specific page changes
4. **No duplication**: Single source of truth instead of two

### Why build cache on-demand

1. **Memory efficient**: Only load what's needed for the current operation
2. **Lazy evaluation**: Small operations don't pay the cost of reading all files
3. **Cache reuse**: Build once per operation, reuse for diff and link resolution

### Why auto-migrate

1. **Zero user action**: Existing users don't need to do anything
2. **Safe**: Migration preserves all mappings
3. **One-time cost**: Config is rewritten immediately, future reads are fast

## Implementation

### Updated Components

| Component | Change |
|-----------|--------|
| `space-config.ts` | Schema change, migration logic |
| `page-state.ts` | **NEW** - PageStateCache builder |
| `link-converter.ts` | `buildPageLookupMapFromCache()` |
| `sync-engine.ts` | Build cache for diff/links |
| `sync-specific.ts` | Build cache for sync |
| `push.ts` | Build cache for link resolution |
| `status.ts` | Build cache for diff |
| `tree.ts` | Work with simplified mappings |
| `handlers.ts` (MCP) | Simplified page lookup |

### Performance Characteristics

| Operation | Before | After |
|-----------|--------|-------|
| Page count | O(1) from JSON | O(1) from JSON |
| Get page path | O(1) lookup | O(1) lookup |
| Get version/title | O(1) from JSON | O(file read) - lazy |
| Build lookup map | O(n) memory | O(n) file reads |
| Diff computation | O(n) memory | O(n) file reads |

The trade-off is acceptable because:
- File reads are fast (local disk, small frontmatter)
- Cache is built once per operation
- Config file size reduction is significant for large spaces

## Consequences

### Positive

- **Smaller config files**: Orders of magnitude smaller for large spaces
- **Cleaner git diffs**: Only structural changes appear in `.confluence.json`
- **Single source of truth**: Frontmatter is authoritative for page metadata
- **Automatic migration**: No user action required

### Negative

- **Increased I/O**: Operations that need full info must read files
- **Cache building overhead**: First operation in a session reads all files
- **Migration writes to disk**: First read after upgrade rewrites config

### Mitigations

- Build cache once per operation, reuse for all lookups
- Cache building is parallelizable if needed in the future
- Migration is a one-time operation per space

## Related ADRs

- ADR-0006: Comprehensive frontmatter metadata (establishes frontmatter content)
- ADR-0022: Relative path link handling (uses page lookup maps)
