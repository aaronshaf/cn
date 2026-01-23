# ADR 0025: Filter Archived Pages from Sync

## Status

Accepted

## Context

Confluence pages can have different status values:
- `current` - Active pages that are visible and editable
- `archived` - Pages moved to archive (hidden from navigation, read-only)
- `trashed` - Pages in trash (recoverable, scheduled for deletion)
- `draft` - Unpublished draft pages

The Confluence API v2 `/spaces/{id}/pages` endpoint returns pages with all status values by default. We need to decide how to handle non-current pages during sync operations.

## Decision

Filter out pages with `status != "current"` during sync operations. Treat archived and trashed pages as if they were deleted.

## Rationale

1. **Mirrors Confluence UX**: Archiving a page removes it from navigation and search in Confluence. Deleting it locally mirrors this behavior.

2. **Consistency**: "Archive" in Confluence means "remove from view". Having archived pages remain locally would be inconsistent with their status in Confluence.

3. **Clean local workspace**: Users archive pages to declutter. Keeping them locally defeats this purpose.

4. **Simplicity**: No need for special handling, archive folders, or status tracking. Archived = deleted locally.

5. **Trashed pages included**: Pages in trash are also filtered since they're scheduled for deletion.

## Implementation

### API Client Filtering
```typescript
// src/lib/confluence-client/client.ts
async getAllPagesInSpace(spaceId: string): Promise<Page[]> {
  // ... pagination logic ...
  allPages.push(...response.results.filter((page) => page.status === 'current'));
  // ...
}
```

### Sync Engine Filtering
```typescript
// src/lib/sync/sync-engine.ts
computeDiff(remotePages: Page[], ...): SyncDiff {
  // Filter at diff computation as defense-in-depth
  const currentPages = remotePages.filter((page) => page.status === 'current');
  // ... diff logic uses currentPages ...
}
```

### Behavior Examples

| Scenario | Local State | Remote State | Result |
|----------|------------|--------------|--------|
| Page archived | `page.md` exists | `status: "archived"` | File deleted |
| Fresh clone | No files | Has archived pages | Archived pages not synced |
| Page restored | File deleted | `status: "current"` | File re-synced as "added" |

## Consequences

### Positive
- Clean local workspace mirrors Confluence UI
- Simple implementation (no special handling)
- No ambiguity about what to sync
- Consistent behavior across all commands

### Negative
- Archived pages are deleted locally (cannot browse locally)
- No local history of archived content
- Re-archiving causes file deletion (potential for accidental loss if user has local edits)

### Mitigations
- Git tracking recommended: deleted files remain in git history
- Clear messaging: pull command shows "X deleted" for archived pages
- Documentation: clarify that archived = deleted locally

## Alternatives Considered

### Alternative 1: Sync to `_archived/` folder
- **Pro**: Preserves archived content locally
- **Con**: Complicates file structure, requires special handling, unclear if archived folder should be synced back
- **Rejected**: Adds complexity for unclear benefit

### Alternative 2: Add `--include-archived` flag
- **Pro**: User choice
- **Con**: Two modes to maintain, unclear default behavior
- **Rejected**: Adds complexity, most users won't need archived pages

### Alternative 3: Preserve archived pages, mark in frontmatter
- **Pro**: Full local copy
- **Con**: Clutters workspace, files that shouldn't be visible are visible
- **Rejected**: Defeats purpose of archiving

## Future Considerations

If users request archived page access:
1. Could add `--include-archived` flag to `clone` and `pull` commands
2. Could sync to `_archived/` folder with clear documentation
3. Could add `cn restore <page>` command to unarchive

Any such additions would warrant a new ADR.
