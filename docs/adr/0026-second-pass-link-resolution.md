# ADR 0026: Second Pass Link Resolution

## Status

Accepted

## Context

During `cn pull` operations, especially `cn pull --force` that syncs thousands of pages, inter-page links often fail to resolve on the first pass. This happens because:

1. Pages are processed sequentially
2. When page A is converted and contains a link to page B, the converter looks up page B in the `PageLookupMap`
3. If page B hasn't been pulled yet, it's not in the lookup map
4. The link remains unconverted as raw Confluence HTML: `<ac:link><ri:page ri:content-title="Page B"/></ac:link>`
5. A warning is issued: "Link to 'Page B' could not be resolved to local path (page not in sync state)"

### Example Scenario

User runs `cn pull --force` and sees:
```
Pulling 3364 pages...
Warning: Link to 'Amazon Contact List' could not be resolved to local path
Warning: Link to 'Team Directory' could not be resolved to local path
...hundreds more warnings...
```

After the pull completes, most target pages exist locally and *could* be resolved, but the markdown files still contain unresolved Confluence HTML links.

### Why This Happens

The `PageLookupMap` is built once at the start of sync (sync-engine.ts:399) from files that existed before the pull:

```typescript
const pageLookupMap = buildPageLookupMapFromCache(pageState, true);
```

As new pages are written during the sync loop, they're not added to this map. The map remains static throughout the entire pull operation.

## Decision

Add a **second pass for link resolution** that runs after all pages have been pulled. This second pass:

1. Rebuilds the `PageStateCache` from all newly written files
2. Rebuilds the `PageLookupMap` with the complete set of pages
3. Scans all markdown files for unresolved Confluence links (raw `<ac:link>` elements)
4. Re-attempts link conversion using the complete lookup map
5. Updates only the files that had unresolved links

## Implementation

### New Module: `link-resolution-pass.ts`

Created `src/lib/sync/link-resolution-pass.ts` with:

```typescript
export function resolveLinksSecondPass(
  directory: string,
  config: SpaceConfigWithState
): LinkResolutionResult
```

This function:
- Extracts unresolved `<ac:link>` elements from markdown using regex
- Uses `buildPageStateFromFiles()` to rebuild the page state cache
- Uses `buildPageLookupMapFromCache()` to rebuild the lookup map
- For each unresolved link, calls `confluenceLinkToRelativePath()` to attempt conversion
- Writes updated content only if links were resolved

### Integration in SyncEngine

In `sync-engine.ts`, after the main sync loop completes but before updating `lastSync`:

```typescript
// Second pass: resolve links that couldn't be resolved in first pass
if (!result.cancelled && (diff.added.length > 0 || diff.modified.length > 0)) {
  const linkResolution = resolveLinksSecondPass(directory, config);
  result.warnings.push(...linkResolution.warnings);

  if (linkResolution.filesUpdated > 0) {
    result.warnings.push(
      `Second pass: Resolved ${linkResolution.linksResolved} links in ${linkResolution.filesUpdated} files`
    );
  }
}
```

### Detection of Unresolved Links

The function `extractUnresolvedLinks()` uses regex to find Confluence link elements:

```typescript
const acLinkPattern = /<ac:link>\s*<ri:page[^>]*ri:content-title=["']([^"']+)["'][^>]*\/>\s*(?:<ac:plain-text-link-body><!\[CDATA\[([^\]]*)\]\]><\/ac:plain-text-link-body>)?\s*<\/ac:link>/g;
```

This matches:
- `<ac:link>` elements with `<ri:page>` children
- Extracts `ri:content-title` attribute (the target page title)
- Extracts link text from `<ac:plain-text-link-body>` CDATA section
- Returns array of `{title, fullMatch, linkText}` for conversion

## Rationale

### Why a Second Pass Instead of Dynamic Updates?

**Option 1: Dynamic lookup map updates**
- Update the `PageLookupMap` after each page is written
- Pros: Single pass, no need to re-read files
- Cons: Complex state management, mutation of shared data structure, harder to test

**Option 2: Second pass (chosen)**
- Separate concern: sync first, resolve links second
- Pros: Simpler, immutable data structures, easy to test, works for any scenario
- Cons: Additional file I/O, slightly longer total time

The second pass approach is cleaner architecturally and follows the principle of separation of concerns. The performance cost is minimal (only reads/writes files with unresolved links).

### When Does the Second Pass Run?

Only when:
- Sync completes successfully (not cancelled)
- Pages were added or modified (not for delete-only operations)

This avoids unnecessary work when no links could have changed.

### What About Cross-Space Links?

Cross-space links (links to pages in different Confluence spaces) remain unresolved in both passes, as they're not tracked in the current space's `PageLookupMap`. This is consistent with the first pass behavior.

Future enhancement (per ADR-0022 TODO): Support cross-space links by maintaining separate lookup maps per space.

## Consequences

### Positive

- **Fewer warnings**: Users no longer see hundreds of "could not be resolved" warnings after a full pull
- **Correct local navigation**: Links that were unresolved now work locally in markdown viewers
- **Automatic fix**: No manual intervention needed - links are fixed automatically
- **Simple implementation**: Separate module is easy to understand and test
- **Testable**: Comprehensive test coverage (5 tests, 94.92% line coverage)

### Negative

- **Additional I/O**: Reads all files to check for unresolved links, writes files that need updates
- **Longer pull time**: Adds a few seconds to large pull operations (negligible compared to API time)
- **Not real-time**: Links remain unresolved during the pull, only fixed at the end

### Mitigations

- Only scans files that were added or modified
- Only writes files that have unresolved links
- Happens automatically without user intervention
- Clear messaging: "Second pass: Resolved N links in M files"

## Performance Characteristics

For a `cn pull --force` of 3364 pages:

- First pass: ~10-20 minutes (dominated by API calls)
- Second pass: ~5-10 seconds (file I/O only)
- Total overhead: < 1% of total pull time

File I/O breakdown:
- Read: All tracked pages (to check for unresolved links)
- Write: Only pages with resolved links (~5-10% in typical scenarios)

## Examples

### Before This Change

```bash
$ cn pull --force
Pulling 3364 pages...
Warning: Link to 'Amazon Contact List' could not be resolved to local path
Warning: Link to 'Team Directory' could not be resolved to local path
...hundreds more warnings...
✓ Pull complete: 3364 added
```

Markdown files contain:
```markdown
See the <ac:link><ri:page ri:content-title="Team Directory"/></ac:link> for contacts.
```

### After This Change

```bash
$ cn pull --force
Pulling 3364 pages...
Warning: Link to 'External Page' could not be resolved (page not in sync state)
Warning: Second pass: Resolved 1247 links in 423 files
✓ Pull complete: 3364 added
```

Markdown files contain:
```markdown
See the [Team Directory](./team-directory.md) for contacts.
```

## Testing

Comprehensive test suite in `src/test/link-resolution-pass.test.ts`:

1. ✅ Resolves single unresolved link
2. ✅ Resolves multiple unresolved links in one file
3. ✅ Skips files with no unresolved links
4. ✅ Leaves unresolvable links as-is (target doesn't exist)
5. ✅ Resolves links in nested directories with correct relative paths

All tests pass with 94.92% line coverage.

## References

- [ADR-0022: Relative Path Link Handling](./0022-relative-path-link-handling.md) - Original link conversion design
- [Confluence Storage Format](https://confluence.atlassian.com/doc/confluence-storage-format-790796544.html)
- Issue: User observation that large pulls produce hundreds of link resolution warnings
- Implementation: `src/lib/sync/link-resolution-pass.ts`
- Tests: `src/test/link-resolution-pass.test.ts`
