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

## cn sync

Sync a Confluence space to the current directory.

### Usage

```
cn sync [options]
cn sync --init <SPACE_KEY>
```

### Options

```
--init <key>     Initialize sync for a space (creates .confluence.json)
--dry-run        Show what would be synced without making changes
--force          Full re-sync (re-download all pages)
--depth <n>      Limit sync depth (default: unlimited)
```

### Sync Modes

**Smart Sync (default):**
- Only syncs pages where remote version > local version
- Handles title/parent changes by moving local files
- Most efficient for regular use

**Full Sync (`--force`):**
- Re-downloads all pages regardless of local state
- Use when local state may be corrupted
- Treats all pages as "added"

### Behavior

**With `--init`:**
1. Verify space exists
2. Create `.confluence.json` with space metadata
3. Print instructions to run `cn sync`

**Smart Sync (default):**
1. Read `.confluence.json` from current directory
2. Compare remote versions with local sync state
3. Download new/modified pages
4. Move files if title/parent changed
5. Remove deleted pages
6. Update sync state

**Full Sync (`--full`):**
1. Read `.confluence.json` from current directory
2. Treat all remote pages as "added"
3. Re-download all pages
4. Update sync state

### Output

```
$ cn sync
Syncing space: Engineering (ENG)
  ↓ Getting Started/Installation.md (modified)
  ↓ API Reference/Endpoints.md (new)
  × Old Page.md (deleted)
✓ Synced 2 pages, deleted 1
```

### Progress Output

Sync command shows detailed progress during execution:

- **Fetching phase**: "Fetching pages from Confluence..." with spinner
- **Diff phase**: "Comparing with local state..." or show counts (e.g., "Found 5 changes")
- **Per-page progress**: Show each page as it's downloaded/written
- **Rate limiting**: Indicate when rate limited and retry countdown
- **Summary**: Final counts of added/modified/deleted

Example improved output:
```
$ cn sync
Syncing space: Engineering (ENG)
⠋ Fetching pages from Confluence...
  Found 42 pages, comparing with local state...
  3 new, 2 modified, 1 deleted

  [1/6] ↓ getting-started/installation.md (new)
  [2/6] ↓ getting-started/quick-start.md (new)
  [3/6] ↓ api-reference/endpoints.md (modified)
  [4/6] ↓ api-reference/auth.md (modified)
  [5/6] ↓ getting-started/config.md (new)
  [6/6] × deprecated/old-page.md (deleted)

✓ Synced 5 pages, deleted 1
```

### File Naming

1. Slugify page title: "Getting Started" → "getting-started"
2. Use `index.md` for pages with children
3. Append counter for conflicts: `page.md`, `page-2.md`

### Example Directory Structure

```
./
├── .confluence.json
├── Home.md
├── getting-started/
│   ├── index.md
│   └── installation.md
└── api-reference/
    ├── index.md
    └── endpoints.md
```

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
✗ No .confluence.json found. Run 'cn sync --init <SPACE_KEY>' to initialize.
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
| `cn push` | Push local changes to Confluence |
| `cn diff` | Show differences between local and remote |
| `cn search` | Search pages in synced content |
| `cn watch` | Watch for remote changes |
