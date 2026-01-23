# cn - Data Model

## Configuration Files

### Global Config: `~/.cn/config.json`

User credentials and global settings. File permissions: 600 (owner read/write only).

```typescript
interface Config {
  confluenceUrl: string   // e.g., "https://company.atlassian.net"
  email: string           // e.g., "user@example.com"
  apiToken: string        // Confluence API token
}
```

**Schema (Effect Schema):**

```typescript
const ConfigSchema = Schema.Struct({
  confluenceUrl: Schema.String.pipe(
    Schema.pattern(/^https:\/\/.+\.atlassian\.net$/)
  ),
  email: Schema.String.pipe(
    Schema.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
  ),
  apiToken: Schema.String.pipe(Schema.minLength(1))
})
```

---

### Space Config: `.confluence.json`

Per-folder configuration specifying which Confluence space to sync.

```typescript
interface SpaceConfig {
  spaceKey: string        // e.g., "ENG"
  spaceId: string         // e.g., "123456"
  spaceName: string       // e.g., "Engineering"
  lastSync: string | null // ISO 8601 timestamp
  syncState: SyncState
}

interface SyncState {
  pages: Record<string, PageSyncInfo>
}

interface PageSyncInfo {
  pageId: string
  version: number
  lastModified: string    // ISO 8601
  localPath: string       // Relative path from root
}
```

**Example:**

```json
{
  "spaceKey": "ENG",
  "spaceId": "123456",
  "spaceName": "Engineering",
  "lastSync": "2024-01-15T10:30:00Z",
  "syncState": {
    "pages": {
      "page-abc-123": {
        "pageId": "page-abc-123",
        "version": 5,
        "lastModified": "2024-01-14T08:00:00Z",
        "localPath": "getting-started/index.md"
      }
    }
  }
}
```

---

## Markdown Frontmatter

Every synced markdown file includes YAML frontmatter with page metadata.

```typescript
interface PageFrontmatter {
  // Required
  page_id: string
  title: string
  space_key: string

  // Timestamps
  created_at: string      // ISO 8601
  updated_at: string      // ISO 8601

  // Version info
  version: number

  // Hierarchy
  parent_id: string | null
  parent_title: string | null
  child_count?: number        // Number of direct child pages (optional)

  // Author info
  author_id: string
  author_name: string
  author_email: string
  last_modifier_id: string
  last_modifier_name: string
  last_modifier_email: string

  // Additional metadata
  labels: string[]
  url: string             // Full Confluence URL

  // Sync metadata
  synced_at: string       // ISO 8601
}
```

**Example:**

```yaml
---
page_id: "page-abc-123"
title: "Getting Started"
space_key: "ENG"
created_at: "2023-06-15T09:00:00Z"
updated_at: "2024-01-14T08:00:00Z"
version: 5
parent_id: "page-root-001"
parent_title: "Home"
child_count: 3
author_id: "user-123"
author_name: "John Doe"
author_email: "john.doe@example.com"
last_modifier_id: "user-456"
last_modifier_name: "Jane Smith"
last_modifier_email: "jane.smith@example.com"
labels:
  - documentation
  - onboarding
url: "https://company.atlassian.net/wiki/spaces/ENG/pages/123456/Getting+Started"
synced_at: "2024-01-15T10:30:00Z"
---

# Getting Started

Page content here...
```

### Child Count

The `child_count` field tracks the number of direct child pages (not including folders or nested descendants).

**Behavior:**
- **Full sync** (`cn pull`): Computed from the complete page hierarchy and explicitly set
- **Specific-page sync** (`cn pull <file>`): Field is `undefined` (requires full sync for accurate count)
- **Old synced files**: May not have `child_count` field (backward compatible)
- **Leaf pages**: `child_count: 0`
- **Pages with children**: `child_count: N` where N > 0

**Use cases:**
- Identify hub pages with many children (high child_count values)
- Find leaf pages vs parent pages
- Track content organization patterns

### Title and H1 Heading

The page title appears in two places:
1. **Frontmatter `title` field** - The authoritative page title
2. **H1 heading** - Added at the start of content for readability

**Pull behavior:** When pulling from Confluence, an H1 heading (`# {title}`) is automatically added at the start of the content. This makes the markdown file readable standalone, since Confluence displays the title separately from the body.

**Push behavior:** When pushing to Confluence, the first H1 heading is stripped from the content before converting to HTML. The title is taken from (in priority order):
1. Frontmatter `title` field
2. First `# H1` heading in content
3. Filename

This prevents duplicate titles appearing in Confluence (once in the page header, once in the body).

---

## Confluence API Types

### Space (from API)

```typescript
interface ConfluenceSpace {
  id: string
  key: string
  name: string
  type: "global" | "personal"
  status: "current" | "archived"
  homepageId: string
  description?: {
    plain?: { value: string }
    view?: { value: string }
  }
  _links: {
    webui: string
    self: string
  }
}
```

### Page (from API)

```typescript
interface ConfluencePage {
  id: string
  status: "current" | "trashed" | "draft" | "archived"
  title: string
  spaceId: string
  parentId: string | null
  parentType: "page" | null
  position: number | null
  authorId: string
  ownerId: string
  lastOwnerId: string
  createdAt: string
  version: {
    number: number
    message: string
    minorEdit: boolean
    authorId: string
    createdAt: string
  }
  body?: {
    storage?: { value: string }
    atlas_doc_format?: { value: string }
  }
  _links: {
    webui: string
    editui: string
    tinyui: string
  }
}
```

**Note on page status filtering**: Only pages with `status: "current"` are synchronized. Pages with other statuses (`archived`, `trashed`, `draft`) are filtered out and treated as deleted locally during sync operations. See ADR-0025 for rationale.

---

## Internal Types

### Page Tree

```typescript
interface PageTree {
  root: PageNode
  pages: Map<string, PageNode>  // pageId -> node
}

interface PageNode {
  page: ConfluencePage
  children: PageNode[]
  depth: number
  localPath: string | null
}
```

### Sync Diff

```typescript
interface SyncDiff {
  added: PageNode[]
  modified: PageNode[]
  deleted: PageSyncInfo[]
  unchanged: PageSyncInfo[]
}

interface SyncResult {
  added: number
  modified: number
  deleted: number
  errors: SyncError[]
  duration: number  // milliseconds
}
```

---

## File Naming Rules

### Slugification

```typescript
function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')     // Remove special chars
    .replace(/[\s_]+/g, '-')       // Spaces to hyphens
    .replace(/-+/g, '-')           // Collapse multiple hyphens
    .replace(/^-|-$/g, '')         // Trim hyphens
}
```

### Examples

| Title | Filename |
|-------|----------|
| "Getting Started" | `getting-started.md` |
| "API Reference" | `api-reference.md` |
| "FAQ & Support" | `faq-support.md` |
| "2024 Roadmap" | `2024-roadmap.md` |
| "What's New?" | `whats-new.md` |

### Conflict Resolution

When multiple pages have the same slugified title:

```
page.md
page-2.md
page-3.md
```

The counter is appended before the extension. The original (first encountered) page gets no counter.

### Directory Structure Rules

1. Pages with children become directories with `index.md`
2. Leaf pages are single `.md` files

```
parent-page/
├── index.md           # Parent page content
├── child-page.md      # Leaf child
└── another-child/     # Child with grandchildren
    ├── index.md
    └── grandchild.md
```
