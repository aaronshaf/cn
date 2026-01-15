# ADR 0005: Use Nested Folders for Page Hierarchy

## Status

Accepted

## Context

Confluence pages have a hierarchical parent-child structure. Need to represent this in the local filesystem.

Options:
1. **Flat structure** - All pages in root, hierarchy in frontmatter only
2. **Flat with prefixes** - `parent--child--grandchild.md`
3. **Nested folders** - Directory structure mirrors page tree

## Decision

Use nested folders where child pages become subdirectories.

## Rationale

- **Natural mapping**: Filesystem hierarchy matches page hierarchy
- **Navigation**: Easy to browse in file explorers and editors
- **IDE support**: Folder structure works well with code editors
- **Discoverability**: Structure is self-documenting

## Consequences

### Positive
- Intuitive organization
- Works well with filesystem tools (find, tree, etc.)
- Easy to understand at a glance

### Negative
- Deep hierarchies create long paths
- Moving pages in Confluence requires restructuring locally
- Pages with children need `index.md` convention

## Structure

```
space/
├── home.md                    # Root page (no children)
├── getting-started/           # Page with children
│   ├── index.md               # "Getting Started" content
│   ├── installation.md        # Leaf child
│   └── configuration/         # Child with grandchildren
│       ├── index.md
│       └── advanced.md
└── api-reference/
    ├── index.md
    └── endpoints.md
```

## Rules

1. Leaf pages (no children) → single `.md` file
2. Pages with children → folder with `index.md`
