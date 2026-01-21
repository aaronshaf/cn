# ADR 0006: Use Comprehensive Frontmatter Metadata

## Status

Accepted

## Context

Synced markdown files need metadata to track their Confluence source. Need to decide how much metadata to include.

Options:
1. **Minimal** - Just `page_id` and `title`
2. **Essential** - Add `version`, `last_modified`, `parent_id`
3. **Comprehensive** - Full metadata including labels, authors, URL

## Decision

Use comprehensive frontmatter with all available metadata.

## Rationale

- **Tooling**: Rich metadata enables better tooling integration
- **Traceability**: Full audit trail of page history
- **Labels**: Enable filtering/searching by Confluence labels locally
- **Authors**: Know who created/modified content (includes names and emails fetched from Confluence API)
- **URL**: Quick access back to Confluence page

## Consequences

### Positive
- Complete metadata available locally
- Can build advanced tooling (search by label, filter by author)
- Easy to trace back to source
- Supports future bidirectional sync

### Negative
- Larger file headers
- More data to keep in sync
- Some metadata may rarely be used

## Schema

Note: `space_key` is no longer included in frontmatter as it's inferred from `.confluence.json` in the directory root.

```yaml
---
page_id: "abc123"
title: "Getting Started"
created_at: "2023-06-15T09:00:00Z"
updated_at: "2024-01-14T08:00:00Z"
version: 5
parent_id: "root001"
parent_title: "Home"
author_id: "user123"
author_name: "John Doe"
author_email: "john.doe@example.com"
last_modifier_id: "user456"
last_modifier_name: "Jane Smith"
last_modifier_email: "jane.smith@example.com"
labels:
  - documentation
  - onboarding
url: "https://company.atlassian.net/wiki/spaces/ENG/pages/123/Getting+Started"
synced_at: "2024-01-15T10:30:00Z"
---
```

## Library

Use `gray-matter` for parsing and serializing frontmatter.
