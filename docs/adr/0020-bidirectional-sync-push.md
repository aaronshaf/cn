# ADR 0020: Bidirectional Sync - Push Command

## Status

Accepted

## Context

ADR-0007 established one-way sync (Confluence to local) as the initial approach. Users now need the ability to push local edits back to Confluence, completing bidirectional sync.

Requirements:
1. Push individual markdown files to Confluence
2. Detect and handle version conflicts
3. Convert markdown back to Confluence Storage Format
4. Provide clear feedback on conversion limitations

## Decision

Implement `cn push` command for pushing local markdown files to Confluence:
- `cn push <file>` - Push a single file
- `cn push` - Scan for changes and prompt y/n for each file

Supports both updating existing pages and creating new ones.

### Version Conflict Handling

Use optimistic concurrency with version checking:

```bash
# Normal flow - versions match
cn push ./docs/page.md
✓ Pushed: Page Title (version 3 → 4)

# Conflict - remote modified since pull
cn push ./docs/page.md
Version conflict detected.
  Local version:  3
  Remote version: 5

# Force push - overwrites remote
cn push ./docs/page.md --force
✓ Pushed: Page Title (version 5 → 6)
```

### Creating New Pages

Pages without `page_id` in frontmatter are created as new pages:

```bash
# Create new-feature.md with just content (no frontmatter)
cn push ./docs/new-feature.md
Creating: new-feature
  (New page - no page_id in frontmatter)
  Creating page on Confluence...

✓ Created: new-feature (page_id: 789012)
```

After creation, frontmatter is populated with all metadata:
- `page_id`, `created_at`, `author_id`, `version`, `url`, etc.

Optional: specify `parent_id` in frontmatter to set parent page.

### Batch Mode

When invoked without a file argument, `cn push` scans for changes:

```bash
$ cn push
Scanning for changes...

Found 3 file(s) to push:
  [N] new-feature.md
  [M] getting-started.md
  [M] api-reference/auth.md

? Push new-feature.md? (create) y
...
? Push getting-started.md? (update) y
...
? Push api-reference/auth.md? (update) n

Push complete:
  2 pushed
  1 skipped
```

**Change Detection:**
- Compares file modification time (mtime) against `synced_at` in frontmatter
- Files without `page_id` are detected as new pages
- Scans all `.md` files, excluding `node_modules/`, `.git/`, `dist/`, `build/`, etc.

**Dry Run Mode:**
- `cn push --dry-run` shows what would be pushed without making changes

### Markdown to HTML Conversion

Use `marked` library with custom renderer for Confluence Storage Format:

```typescript
const renderer: Partial<Renderer> = {
  code(token: Tokens.Code): string {
    // Convert to Confluence code macro
    return `<ac:structured-macro ac:name="code">
      <ac:parameter ac:name="language">${token.lang}</ac:parameter>
      <ac:plain-text-body><![CDATA[${token.text}]]></ac:plain-text-body>
    </ac:structured-macro>`;
  },
  // ... other renderers
};
```

### Supported Elements

| Markdown | Confluence |
|----------|------------|
| Headings | `<h1>` - `<h6>` |
| Bold/Italic | `<strong>`, `<em>` |
| Code blocks | `ac:structured-macro` (code) |
| Inline code | `<code>` |
| Lists | `<ul>`, `<ol>`, `<li>` |
| Links | `<a href="">` |
| Tables | `<table>`, `<thead>`, `<tbody>` |
| Blockquotes | `<blockquote>` or info panel macro |
| Horizontal rules | `<hr />` |

### Unsupported Elements (Warnings)

Elements that cannot be converted display warnings:

| Element | Warning |
|---------|---------|
| User mentions (@username) | Render as plain text |
| Local images (./img.png) | Won't display in Confluence |
| Task list checkboxes | Converted to regular list items |
| Footnotes | Render as plain text |

## Rationale

### Why `marked` instead of alternatives

- **remark/rehype**: More powerful but complex plugin system; overkill for our needs
- **showdown**: Less active maintenance, fewer TypeScript types
- **marked**: Lightweight, fast, well-maintained, extensible renderer

### Why y/n prompts for batch mode

- Safer than bulk push - requires explicit intent for each file
- Avoids accidental overwrites of multiple pages
- User maintains full control over what gets pushed
- Simple flow that doesn't require learning new options

### Why mtime-based change detection

- Simple and fast - no need to hash file contents
- `synced_at` already stored in frontmatter after pull/push
- False positives are harmless - user can skip with "n"
- Matches user intuition about "modified" files

### Why version-based conflict detection

- Confluence increments version on every edit
- Local frontmatter stores version from last pull
- Simple comparison catches all changes
- `--force` available for intentional overwrites

## Implementation

```typescript
export async function pushCommand(options: PushCommandOptions): Promise<void> {
  // 1. Parse markdown and extract frontmatter
  const { frontmatter, content } = parseMarkdown(markdownContent);

  // 2. Check if new page or existing
  if (!frontmatter.page_id) {
    // Create new page
    const createdPage = await client.createPage({
      spaceId: spaceConfig.spaceId,
      title: frontmatter.title || filename,
      parentId: frontmatter.parent_id,
      body: { representation: 'storage', value: html }
    });
    // Populate frontmatter with page_id, created_at, author_id, etc.
  } else {
    // Update existing page
    // 3. Fetch remote version
    const remotePage = await client.getPage(pageId);

    // 4. Check version conflict (unless --force)
    if (!options.force && frontmatter.version !== remotePage.version.number) {
      throw new VersionConflictError(frontmatter.version, remotePage.version.number);
    }

    // 5. Update page
    await client.updatePage({
    id: pageId,
    title: frontmatter.title,
    body: { representation: 'storage', value: html },
    version: { number: remoteVersion + 1 }
  });

  // 7. Update local frontmatter with new version
  // 8. Update .confluence.json sync state
}
```

## Consequences

### Positive

- Users can edit pages locally and push changes
- Create new pages directly from local markdown files
- Batch mode scans for changes and prompts for each file
- Version conflicts prevent accidental overwrites
- Clear warnings for unsupported elements
- Frontmatter automatically updated after push

### Negative

- Not all markdown features convert perfectly
- Confluence macros from original page are lost on round-trip

## Future Work

- `cn push --all` - push all changed files without prompts
- Better macro preservation on round-trip
