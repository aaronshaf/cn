# cn - Commands Specification

## Global Options

```
--help, -h     Show help
--version, -v  Show version
--verbose      Enable verbose output
--xml          Output in XML format (LLM-friendly)
```

---

## cn setup

Interactive configuration wizard for first-time setup.

### Usage

```
cn setup
```

### Flow

1. Prompt for Confluence URL
2. Prompt for email
3. Prompt for API token (hidden input)
4. Verify connection by calling `/wiki/api/v2/spaces?limit=1`
5. Save to `~/.cn/config.json` with 600 permissions

### Example

```
$ cn setup
? Confluence URL: https://company.atlassian.net
? Email: user@example.com
? API Token: ****
✓ Connection verified
✓ Configuration saved to ~/.cn/config.json
```

### Errors

- Invalid URL format
- Invalid email format
- Connection failed (network error)
- Authentication failed (401)
- Permission denied (403)

---

## cn clone

Clone a Confluence space to a new local directory.

### Usage

```
cn clone <SPACE_KEY> [directory]
```

### Arguments

- `SPACE_KEY` - The Confluence space key (required)
- `directory` - Target directory name (defaults to space key)

### Behavior

1. Verify space exists via API
2. Create target directory
3. Create `.confluence.json` with space metadata
4. Print instructions to run `cn pull`

### Example

```
$ cn clone ENG
✓ Cloned space "Engineering" (ENG) into ENG

  cd ENG
  cn pull

$ cn clone ENG my-engineering
✓ Cloned space "Engineering" (ENG) into my-engineering

  cd my-engineering
  cn pull
```

### Errors

- Space not found
- Directory already exists
- Permission denied

---

## cn pull

Pull pages from Confluence to the current directory.

### Usage

```
cn pull [options]
```

### Options

```
--dry-run             Show what would be pulled without making changes
--force               Full re-pull (re-download all pages)
--page <path-or-id>   Force resync specific page (can use multiple times)
--depth <n>           Limit pull depth (default: unlimited)
```

### Pull Modes

**Smart Pull (default):**
- Only pulls pages where remote version > local version
- Handles title/parent changes by moving local files
- Most efficient for regular use

**Full Pull (`--force`):**
- Re-downloads all pages regardless of local state
- Deletes all existing tracked files first
- Use when local state may be corrupted

**Page-specific Pull (`--page`):**
- Force re-download specific pages regardless of version
- Accepts local file paths or Confluence page IDs
- Useful for re-converting pages after converter improvements
- Can specify multiple pages: `--page file1.md --page file2.md`

### Behavior

**Smart Pull (default):**
1. Read `.confluence.json` from current directory
2. Compare remote versions with local sync state
3. Download new/modified pages
4. Move files if title/parent changed
5. Remove deleted pages
6. Update sync state

**Full Pull (`--force`):**
1. Read `.confluence.json` from current directory
2. Delete all tracked files
3. Re-download all pages
4. Update sync state

### Output

```
$ cn pull
Pulling space: Engineering (ENG)
⠋ Fetching pages from Confluence...
  Found 42 pages and 3 folders
  3 new, 2 modified, 1 deleted

  ✓ getting-started/installation.md
  ✓ getting-started/quick-start.md
  ✓ api-reference/endpoints.md
  ✓ api-reference/auth.md
  ✓ getting-started/config.md
  ✓ deprecated/old-page.md (deleted)

✓ Pull complete: 5 added, 1 deleted
```

### File Naming

1. Slugify page title: "Getting Started" → "getting-started"
2. Use `README.md` for pages with children
3. Append counter for conflicts: `page.md`, `page-2.md`

### Example Directory Structure

```
./
├── .confluence.json
├── README.md                    # Space homepage
├── getting-started/
│   ├── README.md                # "Getting Started" page (has children)
│   └── installation.md
└── api-reference/
    ├── README.md
    └── endpoints.md
```

---

## cn push

Push local markdown files to Confluence. Creates new pages if `page_id` is missing, updates existing pages otherwise.

### Usage

```
cn push [file] [options]
```

### Options

| Option | Description |
|--------|-------------|
| `--force` | Ignore version conflicts and overwrite remote changes |
| `--dry-run` | Show what would be pushed without making changes |

### Arguments

- `file` - Path to the markdown file to push (optional)

### Modes

**Single File Mode** (`cn push <file>`):
- Pushes the specified file to Confluence
- Creates new page if no `page_id` in frontmatter
- Updates existing page if `page_id` is present

**Batch Mode** (`cn push`):
- Scans all markdown files in directory tree
- Detects changed files (file mtime > `synced_at`)
- Detects new files (no `page_id` in frontmatter)
- Prompts y/n for each file before pushing
- Excludes: `node_modules/`, `.git/`, `dist/`, `build/`, etc.

### Flow (Existing Page)

1. Read and parse markdown file
2. Fetch current remote page version
3. Compare versions (unless `--force`)
4. Convert markdown to Confluence Storage Format HTML
5. Update page via API
6. Update local frontmatter with new metadata
7. Rename file if title changed
8. Update `.confluence.json` sync state

### Flow (New Page)

1. Read and parse markdown file
2. Detect missing `page_id` in frontmatter
3. Convert markdown to Confluence Storage Format HTML
4. Create page via API (uses `spaceId` from `.confluence.json`)
5. Populate frontmatter with all metadata (`page_id`, `created_at`, `author_id`, etc.)
6. Rename file to match title slug
7. Update `.confluence.json` sync state

### Requirements

- Must be in a directory with `.confluence.json`
- For new pages: optionally specify `parent_id` in frontmatter to set parent page
- For new pages: title comes from frontmatter `title` field or filename

### Output (Update Existing)

```
$ cn push ./docs/getting-started.md
Pushing: Getting Started
  Checking remote version...
  Converting markdown to HTML...
  Pushing to Confluence (version 3 → 4)...

✓ Pushed: Getting Started (version 3 → 4)
  https://company.atlassian.net/wiki/spaces/ENG/pages/123456/Getting+Started
```

### Output (Create New)

```
$ cn push ./docs/new-feature.md
Creating: New Feature
  (New page - no page_id in frontmatter)
  Converting markdown to HTML...
  Creating page on Confluence...
  Renamed: new-feature.md → new-feature.md

✓ Created: New Feature (page_id: 789012)
  https://company.atlassian.net/wiki/spaces/ENG/pages/789012/New+Feature
```

### Output (Batch Mode)

```
$ cn push
Scanning for changes...

Found 3 file(s) to push:
  [N] new-feature.md
  [M] getting-started.md
  [M] api-reference/auth.md

? Push new-feature.md? (create) yes
Creating: new-feature
  (New page - no page_id in frontmatter)
  Converting markdown to HTML...
  Creating page on Confluence...

✓ Created: new-feature (page_id: 789012)

? Push getting-started.md? (update) yes
Pushing: Getting Started
  Checking remote version...
  Converting markdown to HTML...
  Pushing to Confluence (version 3 → 4)...

✓ Pushed: Getting Started (version 3 → 4)

? Push api-reference/auth.md? (update) no

Push complete:
  2 pushed
  1 skipped
```

### Output (Dry Run)

```
$ cn push --dry-run
Scanning for changes...

Found 3 file(s) to push:
  [N] new-feature.md
  [M] getting-started.md
  [M] api-reference/auth.md

--- DRY RUN MODE ---
Would push 1 new and 2 modified file(s)
No changes were made (dry run mode)
```

### Version Conflict

```
$ cn push ./docs/getting-started.md
Pushing: Getting Started
  Checking remote version...

Version conflict detected.
  Local version:  3
  Remote version: 5

The page has been modified on Confluence since your last pull.
Options:
  - Run "cn pull --page ./docs/getting-started.md" to get the latest version
  - Run "cn push ./docs/getting-started.md --force" to overwrite remote changes
```

### Conversion Warnings

```
$ cn push ./docs/getting-started.md
Pushing: Getting Started
  Checking remote version...
  Converting markdown to HTML...

Conversion warnings:
  ! User mentions (@username) will render as plain text. Use Confluence UI to add mentions.
  ! Local image "./screenshot.png" will not display in Confluence. Use absolute URLs.

  Pushing to Confluence (version 3 → 4)...

✓ Pushed: Getting Started (version 3 → 4)
```

### Supported Markdown

| Element | Support |
|---------|---------|
| Headings | Full |
| Paragraphs | Full |
| Bold/Italic | Full |
| Code blocks | Full (converts to Confluence code macro) |
| Inline code | Full |
| Lists (ordered/unordered) | Full |
| Links | Full |
| Tables | Full |
| Horizontal rules | Full |
| Blockquotes | Full (special panels for Info:/Note:/Warning:/Tip:) |

### Unsupported Elements (Warnings)

| Element | Behavior |
|---------|----------|
| User mentions (@username) | Rendered as plain text |
| Local images | Warning, image won't display |
| Task list checkboxes | Converted to regular list items |
| Footnotes | Rendered as plain text |
| Confluence macros | Not preserved from original |

### Errors

| Error | Exit Code | Description |
|-------|-----------|-------------|
| Page not found | 7 | Page deleted from Confluence |
| Version conflict | 8 | Remote version differs (use --force) |
| Authentication failed | 3 | Invalid credentials |
| Network error | 4 | Connection failed |
| No space configured | 2 | Missing `.confluence.json` file |

---

## cn status

Check connection status and sync information.

### Usage

```
cn status
```

### Output (No Config)

```
$ cn status
✗ Not configured. Run 'cn setup' first.
```

### Output (Not in Sync Folder)

```
$ cn status
✓ Connected to https://company.atlassian.net
✗ No .confluence.json found. Run 'cn clone <SPACE_KEY>' to clone a space.
```

### Output (In Sync Folder)

```
$ cn status
✓ Connected to https://company.atlassian.net
Space: Engineering (ENG)
  Last sync: 2024-01-15 10:30:00
  Local pages: 42
  Remote pages: 44
  Pending changes: 2 new, 1 modified
```

### XML Output

```
$ cn status --xml
<confluence-status>
  <connection status="connected" url="https://company.atlassian.net"/>
  <space key="ENG" name="Engineering" id="123456"/>
  <sync>
    <last-sync>2024-01-15T10:30:00Z</last-sync>
    <local-pages>42</local-pages>
    <remote-pages>44</remote-pages>
    <pending added="2" modified="1" deleted="0"/>
  </sync>
</confluence-status>
```

---

## cn tree

Display the page hierarchy of a space.

### Usage

```
cn tree [SPACE_KEY]
cn tree [options]
```

### Options

```
--remote    Show remote tree (from Confluence API)
--local     Show local tree (from .confluence.json) [default]
--depth <n> Limit tree depth
--xml       Output as XML (inherited from global)
```

### Output

```
$ cn tree ENG
Engineering (ENG)
├── Home
├── Getting Started
│   ├── Installation
│   ├── Quick Start
│   └── Configuration
├── API Reference
│   ├── Authentication
│   └── Endpoints
└── FAQ
```

### XML Output

```xml
$ cn tree ENG --xml
<page-tree space="ENG" name="Engineering">
  <page id="1" title="Home" depth="0">
    <page id="2" title="Getting Started" depth="1">
      <page id="3" title="Installation" depth="2"/>
      <page id="4" title="Quick Start" depth="2"/>
      <page id="5" title="Configuration" depth="2"/>
    </page>
    <page id="6" title="API Reference" depth="1">
      <page id="7" title="Authentication" depth="2"/>
      <page id="8" title="Endpoints" depth="2"/>
    </page>
    <page id="9" title="FAQ" depth="1"/>
  </page>
</page-tree>
```

### Behavior

- Without arguments: show tree for current directory's space
- With space key: show tree for specified space
- `--remote` fetches live from API
- `--local` uses cached sync state

---

## cn open

Open a page in the default browser.

### Usage

```
cn open [PAGE]
cn open [options]
```

### Options

```
--space <key>  Specify space (default: current directory's space)
```

### Arguments

- No argument: open space home page
- Page title: open matching page
- Page ID: open specific page
- Path: open page at local path

### Examples

```
# Open space home
$ cn open

# Open by title (fuzzy match)
$ cn open "Getting Started"

# Open by local file path
$ cn open ./getting-started/installation.md

# Open by page ID
$ cn open 123456
```

### Behavior

1. Resolve page to Confluence URL
2. Open URL in default browser using `open` (macOS) / `xdg-open` (Linux)

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Configuration error (not configured) |
| 3 | Authentication error |
| 4 | Network error |
| 5 | Space not found |
| 6 | Invalid arguments |
| 7 | Page not found |
| 8 | Version conflict |

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CN_CONFIG_PATH` | Override config file location |
| `CN_DEBUG` | Enable debug logging |
| `NO_COLOR` | Disable colored output |

---

## Future Commands (Planned)

| Command | Description |
|---------|-------------|
| `cn diff` | Show differences between local and remote |
| `cn search` | Search pages in synced content |
| `cn watch` | Watch for remote changes |
