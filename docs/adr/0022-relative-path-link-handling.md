# ADR 0022: Relative Path Link Handling

## Status

Accepted

## Context

Confluence pages frequently link to other pages within the same space. When syncing to local markdown files, we need to decide how to represent these inter-page links.

Users want to:
1. Navigate between pages locally using markdown viewers (VS Code, Obsidian, GitHub)
2. Push changes back to Confluence without breaking links
3. Have links survive page renames in Confluence

### Confluence Link Format

Confluence stores page links using the `<ac:link>` element with resource identifiers:

```xml
<ac:link>
  <ri:page ri:content-title="Page Title" ri:space-key="SPACE" />
  <ac:plain-text-link-body><![CDATA[Link text]]></ac:plain-text-link-body>
</ac:link>
```

Confluence internally resolves `ri:content-title` to page IDs, so links survive title changes.

### Options Considered

| Option | Local Navigation | Round-trip Stability | Complexity |
|--------|-----------------|---------------------|------------|
| **Relative paths** | ✅ Works | ✅ Good | Low |
| Full URLs | ❌ Browser only | ✅ Perfect | Very low |
| Page ID refs | ❌ Custom format | ✅ Perfect | Medium |
| Wiki-style `[[Page]]` | ⚠️ Tool-specific | ⚠️ Fragile | Medium |
| Link map file | ✅ Works | ✅ Good | High |

## Decision

Use **relative markdown paths** for inter-page links, converting between Confluence and markdown formats bidirectionally.

### Pull (Confluence → Local)

```xml
<!-- Confluence -->
<ac:link>
  <ri:page ri:content-title="Architecture Overview" />
</ac:link>

<!-- Becomes -->
[Architecture Overview](./Architecture/Overview.md)
```

### Push (Local → Confluence)

```markdown
<!-- Local -->
[Architecture Overview](./Architecture/Overview.md)

<!-- Becomes -->
<ac:link>
  <ri:page ri:content-title="Architecture Overview" ri:space-key="ENG" />
</ac:link>
```

## Rationale

### Why relative paths

1. **Standard markdown** - Works in all markdown viewers without custom extensions
2. **Local navigation** - Click links in VS Code, Obsidian, GitHub to jump between pages
3. **Simple conversion** - Straightforward mapping using sync state and frontmatter
4. **No extra files** - No link maps or metadata files needed

### How it survives renames

When a page is renamed in Confluence:

1. Confluence automatically updates all links (uses page IDs internally)
2. User runs `cn pull`
3. Frontmatter updates with new title
4. Local filename is re-slugged to match new title
5. All local markdown links pointing to old path are updated to new path

Example:
```
Confluence: "Getting Started" → "Quick Start Guide"
Local file: getting-started.md → quick-start-guide.md
References: Update all links in other files to new path
```

### Why not full URLs

While most stable (no conversion needed), full Confluence URLs don't work for local navigation - clicking opens a browser instead of jumping to the local file.

### Why not page ID references

Custom formats like `[Link](@page:123456)` or `[Link](./file.md#confluence:123456)` are not standard markdown and break in most viewers.

### Why not wiki-style links

`[[Page Title]]` is not standard markdown, and title-based lookup is fragile when multiple pages have similar titles or when titles change.

## Consequences

### Positive

- Links work locally in any markdown viewer
- Clean, standard markdown files
- Round-trip conversion maintains link integrity
- Automatic file renaming keeps things in sync

### Negative

- Link conversion adds complexity to pull/push flows
- Broken if user manually renames files without updating references
- Cross-space links not yet supported (preserved as full URLs)

### Mitigations

- Detect and warn about broken local links during push
- Automatic reference updating when files are renamed during pull
- Future: `cn check-links` command to validate all links
- Future: Support cross-space links with space-qualified paths

## Implementation Notes

### Pull Algorithm

1. Parse `<ac:link><ri:page>` elements from Confluence HTML
2. Extract `ri:content-title` and `ri:space-key`
3. Look up target page in sync state by title
4. Calculate relative path from current page to target page
5. Replace with markdown link `[text](relative-path.md)`
6. Warn if target page not found

### Push Algorithm

1. Parse markdown links ending in `.md`
2. Resolve relative path to absolute filesystem path
3. Read target file's frontmatter to get `title` and `space_key`
4. Generate Confluence link using `ri:content-title` and `ri:space-key`
5. Warn if target file missing or lacks frontmatter

### File Renaming on Title Change

1. During pull, detect title changes by comparing frontmatter
2. Calculate new slug from new title
3. Handle slug conflicts by appending number suffix (`-2`, `-3`, etc.)
4. Rename file
5. Scan all markdown files for links to old path
6. Update relative paths to point to new location

### Sync State Requirements

`.confluence.json` must maintain mapping of:
- Page IDs → local paths
- Page titles → page IDs

This allows efficient lookup during link conversion.

## References

- [Confluence Storage Format Documentation](https://confluence.atlassian.com/doc/confluence-storage-format-790796544.html)
- [How Confluence handles page renames](https://community.atlassian.com/forums/Confluence-questions/I-changed-the-name-on-a-page-I-can-edit-but-a-link-to-that-page/qaq-p/2273398)
- [PRD: Architecture](../prd/architecture.md#link-handling)
