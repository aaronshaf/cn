# cn - Confluence CLI

## Overview

`cn` is a CLI tool for syncing Atlassian Confluence spaces to local folders as markdown files. It provides a local, offline-friendly mirror of Confluence content for reading, searching, and integration with other tools.

## Goals

1. **Local mirror of Confluence content** - Sync entire spaces to markdown files with proper hierarchy
2. **Preserve metadata** - Use frontmatter to store page metadata (IDs, labels, authors, etc.)
3. **Human-readable filenames** - Slugified page titles as filenames
4. **Offline access** - Browse Confluence content without network access
5. **Relative path links** - Convert Confluence page links to relative markdown paths for local navigation

## Non-Goals

- Real-time sync or file watching
- Collaborative editing features
- Automatic push (no background file watching/auto-push)

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript/Bun | Matches ji project, fast runtime |
| Error handling | Effect library | Type-safe errors, composable operations |
| Sync direction | Bidirectional | Pull from Confluence, push individual files back |
| Hierarchy | Nested folders | Natural representation of page tree |
| Credentials | `~/.cn/config.json` | Secure, matches ji pattern |
| Frontmatter | Comprehensive | Rich metadata for tooling integration |
| Macros | Strip and warn | Clean markdown, no data loss surprises |
| Metadata file | `.confluence.json` | Per-folder space configuration |
| HTML→MD | turndown | Proven library, configurable |
| Conflicts | Append counter | Clean names (page.md, page-2.md) |
| Page links | Relative paths | Local navigation in markdown viewers |
| Title changes | Auto re-slug files | Keep filenames in sync with titles |

## Commands

| Command | Description |
|---------|-------------|
| `cn setup` | Interactive configuration wizard |
| `cn clone` | Clone Confluence space to new directory |
| `cn pull` | Pull changes from Confluence |
| `cn push` | Push local file to Confluence |
| `cn status` | Check connection and sync status |
| `cn tree` | Display space hierarchy as tree |
| `cn open [page]` | Open page in browser |

## User Flows

### First-time Setup

```
$ cn setup
? Confluence URL: https://company.atlassian.net
? Email: user@example.com
? API Token: ****
✓ Configuration saved to ~/.cn/config.json
✓ Connection verified
```

### Clone a Space

```
$ cn clone ENG
✓ Cloned space "Engineering" (ENG) into ENG

  cd ENG
  cn pull
```

### Pull Pages

```
$ cn pull
✓ 3 pages updated
✓ 1 page added
✓ 0 pages removed
```

### Resync Specific Pages

```
$ cn pull --page ./docs/my-page.md
✓ 1 page updated
```

### Push Local Changes

```
$ cn push ./docs/my-page.md
Pushing: My Page
  Checking remote version...
  Converting markdown to HTML...
  Pushing to Confluence (version 3 → 4)...

✓ Pushed: My Page (version 3 → 4)
  https://company.atlassian.net/wiki/spaces/ENG/pages/123456/My+Page
```

## File Structure

```
my-space/
├── .confluence.json          # Space metadata
├── Home.md                   # Root page
├── Getting-Started/
│   ├── index.md              # "Getting Started" page
│   └── Installation.md       # Child page
└── API-Reference/
    ├── index.md
    └── Endpoints.md
```

## Success Metrics

- Successfully sync spaces with 1000+ pages
- Maintain sync state across incremental updates
- Complete sync of typical space (100 pages) in < 60 seconds

## Timeline

No specific timeline - implementation proceeds incrementally.

## References

- [ji project](https://github.com/aaronshaf/ji) - Design patterns reference
- [confluence-cli](https://github.com/pchuri/confluence-cli) - Existing CLI reference
- [Confluence REST API](https://developer.atlassian.com/cloud/confluence/rest/v2/intro/)
