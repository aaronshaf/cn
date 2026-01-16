# cn

CLI for syncing Confluence spaces to local markdown.

## Install

```bash
bun install -g @aaronshaf/cn
```

## Getting Started

```bash
# 1. Configure your Confluence credentials
cn setup

# 2. Clone a Confluence space
cn clone <SPACE_KEY>

# 3. Pull the pages
cd <SPACE_KEY>
cn pull
```

The space key is the identifier in your Confluence URL:
`https://yoursite.atlassian.net/wiki/spaces/<SPACE_KEY>/...`

Credentials are stored in `~/.cn/config.json`. Space configuration is saved to `.confluence.json` in the synced directory.

## Usage

```bash
# Clone a space to a new directory
cn clone DOCS

# Pull changes from Confluence
cn pull

# Pull specific pages only
cn pull --page ./path/to/page.md

# Push a single file to Confluence
cn push ./path/to/page.md

# Push changed files (prompts for each)
cn push

# Push with dry run (preview without changes)
cn push --dry-run

# Force push (overwrite remote changes)
cn push ./path/to/page.md --force

# Check connection status
cn status

# View page hierarchy
cn tree

# Open page in browser
cn open
```

## Requirements

- Bun 1.2.0+
- Confluence Cloud account

## Development

```bash
bun install
bun run cn --help
bun test
```

## License

MIT
