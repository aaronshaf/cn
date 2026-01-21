# cn - Confluence CLI

CLI tool for syncing Atlassian Confluence spaces and local markdown files.

## Project Documentation

**When implementing features:** Consult `docs/prd/` for specifications and `docs/adr/` for architectural context.

**When making architectural decisions:** Create a new ADR in `docs/adr/` following the existing format (see `docs/adr/README.md`).

### `docs/prd/` - Product Requirements Documents

Product specifications and design documents:

| File | Purpose |
|------|---------|
| `overview.md` | Project overview, goals, design decisions |
| `architecture.md` | Technical architecture and component design |
| `commands.md` | CLI command specifications |
| `data-model.md` | Data structures, schemas, file formats |

### `docs/adr/` - Architecture Decision Records

Records of significant architectural decisions with context and rationale:

| ADR | Decision |
|-----|----------|
| `0001-use-effect-for-error-handling.md` | Type-safe error handling with Effect |
| `0002-use-bun-runtime.md` | Bun as the JavaScript runtime |
| `0003-store-credentials-in-home-directory.md` | `~/.cn/config.json` for credentials |
| `0004-use-turndown-for-html-to-markdown.md` | Turndown for HTML conversion |
| `0005-use-nested-folders-for-page-hierarchy.md` | Directory structure mirrors page tree |
| `0006-use-comprehensive-frontmatter.md` | Rich YAML frontmatter metadata |
| `0007-one-way-sync-initial-release.md` | Initial one-way sync (superseded by 0020) |
| `0008-use-msw-for-api-mocking.md` | MSW for HTTP mocking in tests |
| `0009-git-hooks-for-quality.md` | Pre-commit hooks for code quality |
| `0010-exponential-backoff-for-rate-limits.md` | Retry strategy for API rate limits |
| `0011-llm-friendly-xml-output.md` | `--xml` flag for LLM consumption |
| `0012-confluence-cloud-only.md` | Cloud only, no Data Center support |
| `0013-typescript-isolated-declarations.md` | Explicit return types on exports |
| `0014-code-coverage-enforcement.md` | Coverage threshold in pre-commit |
| `0015-biome-configuration.md` | Biome linter/formatter settings |
| `0016-bunfig-toml-configuration.md` | Bun runtime and test config |
| `0017-dual-async-effect-api.md` | Both async and Effect methods |
| `0018-confluence-folder-support.md` | V2 API folder discovery for hierarchy |
| `0019-sync-modes.md` | Smart vs full sync modes |
| `0020-bidirectional-sync-push.md` | Push command for bidirectional sync |
| `0024-frontmatter-source-of-truth.md` | Frontmatter as source of truth for sync state |

## Style

- No emoticons in documentation

## Git

- Never use `--no-verify` when committing - always fix pre-commit hook issues first

## Tech Stack

- **Runtime**: Bun 1.2.0+
- **Language**: TypeScript
- **Error Handling**: Effect library
- **HTML→MD**: turndown
- **MD→HTML**: marked
- **Linting**: Biome

## Commands

```bash
cn setup     # Configure Confluence credentials
cn clone     # Clone a space to a new folder
cn pull      # Pull changes from Confluence
cn push      # Push local file to Confluence
cn status    # Check connection and sync status
cn tree      # Display page hierarchy
cn open      # Open page in browser
```

## Key Files

- `~/.cn/config.json` - User credentials (600 permissions)
- `.confluence.json` - Per-folder space configuration and sync state

## Reference Projects

- [`ji`](https://github.com/aaronshaf/ji) - Jira CLI (design patterns reference)
- [`confluence-cli`](https://github.com/pchuri/confluence-cli) - Existing Confluence CLI
