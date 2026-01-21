#!/usr/bin/env bun
import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES } from '../lib/errors.js';
import { cloneCommand } from './commands/clone.js';
import { mcpCommand } from './commands/mcp.js';
import { openCommand } from './commands/open.js';
import { pullCommand } from './commands/pull.js';
import { pushCommand } from './commands/push.js';
import { searchCommand } from './commands/search.js';
import { setup } from './commands/setup.js';
import { statusCommand } from './commands/status.js';
import { treeCommand } from './commands/tree.js';

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, '..', '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
const VERSION = packageJson.version;

function showSetupHelp(): void {
  console.log(`
${chalk.bold('cn setup - Configure Confluence credentials')}

${chalk.yellow('Usage:')}
  cn setup

${chalk.yellow('Description:')}
  Interactive setup wizard that configures:
  - Confluence Cloud URL (https://*.atlassian.net)
  - Email address
  - API token (create at https://id.atlassian.com/manage/api-tokens)

  Stores configuration securely in ~/.cn/config.json with 600 permissions.

${chalk.yellow('Options:')}
  --help                    Show this help message

${chalk.yellow('Examples:')}
  cn setup                  Start interactive setup
`);
}

function showCloneHelp(): void {
  console.log(`
${chalk.bold('cn clone - Clone a Confluence space to a new folder')}

${chalk.yellow('Usage:')}
  cn clone <SPACE_KEY> [directory]

${chalk.yellow('Description:')}
  Creates a new directory and initializes it for a Confluence space.
  Similar to "git clone" - sets up everything needed to pull pages.

${chalk.yellow('Arguments:')}
  SPACE_KEY                 The Confluence space key (required)
  directory                 Target directory name (defaults to space key)

${chalk.yellow('Options:')}
  --help                    Show this help message

${chalk.yellow('Examples:')}
  cn clone DOCS             Clone into ./DOCS
  cn clone DOCS my-docs     Clone into ./my-docs
  cn clone ENG engineering  Clone ENG space into ./engineering
`);
}

function showPullHelp(): void {
  console.log(`
${chalk.bold('cn pull - Pull Confluence space to local folder')}

${chalk.yellow('Usage:')}
  cn pull [options]

${chalk.yellow('Description:')}
  Pulls pages from Confluence to the current directory.
  Must be run in a directory initialized with "cn clone".

${chalk.yellow('Modes:')}
  ${chalk.cyan('Smart pull (default)')}
    Only pulls pages that have changed since last pull.
    Compares version numbers to detect modifications.
    Handles renames and moves automatically.

  ${chalk.cyan('Full pull (--force)')}
    Re-downloads all pages regardless of local state.
    Use when local state may be corrupted or out of sync.

  ${chalk.cyan('Page-specific pull (--page)')}
    Force re-download specific pages regardless of version.
    Useful for re-converting pages after converter improvements.

${chalk.yellow('Options:')}
  --dry-run                 Show what would be pulled without making changes
  --force                   Full re-pull, ignore local state
  --page <path-or-id>       Force resync specific page (can use multiple times)
  --depth <n>               Limit depth
  --help                    Show this help message

${chalk.yellow('Examples:')}
  cn pull                             Smart pull (only changes)
  cn pull --dry-run                   Preview changes
  cn pull --force                     Full re-pull all pages
  cn pull --page ./docs/page.md       Force resync specific file
  cn pull --page 123456 --page 789    Force resync multiple pages by ID
`);
}

function showPushHelp(): void {
  console.log(`
${chalk.bold('cn push - Push local markdown files to Confluence')}

${chalk.yellow('Usage:')}
  cn push [file] [options]

${chalk.yellow('Description:')}
  Push local markdown files to Confluence.

  With a file argument: pushes that single file.
  Without arguments: scans for changed files and prompts y/n for each.

${chalk.yellow('Arguments:')}
  file                      Path to markdown file (optional)

${chalk.yellow('Options:')}
  --force                   Ignore version conflicts and overwrite
  --dry-run                 Preview changes without pushing
  --help                    Show this help message

${chalk.yellow('Examples:')}
  cn push                          Scan and prompt for all changed files
  cn push --dry-run                Preview what would be pushed
  cn push ./docs/page.md           Push single page
  cn push ./docs/page.md --force   Force push (ignore version conflict)

${chalk.yellow('Notes:')}
  - New files (no page_id) will be created on Confluence
  - Modified files are detected by comparing file mtime vs synced_at
  - Only basic markdown elements are fully supported
  - Files are automatically renamed to match page titles (except index.md/README.md)
`);
}

function showStatusHelp(): void {
  console.log(`
${chalk.bold('cn status - Check connection and sync status')}

${chalk.yellow('Usage:')}
  cn status [options]

${chalk.yellow('Description:')}
  Shows the current configuration, connection status, and sync state.

${chalk.yellow('Options:')}
  --xml                     Output in XML format for LLM parsing
  --help                    Show this help message

${chalk.yellow('Examples:')}
  cn status                 Show status with colored output
  cn status --xml           Show status in XML format
`);
}

function showTreeHelp(): void {
  console.log(`
${chalk.bold('cn tree - Display page hierarchy')}

${chalk.yellow('Usage:')}
  cn tree [space-key] [options]

${chalk.yellow('Description:')}
  Displays the page hierarchy for a space as an ASCII tree.
  If no space key is provided, uses the space in the current directory.

${chalk.yellow('Options:')}
  --remote                  Fetch live from API (default)
  --local                   Use cached sync state
  --depth <n>               Limit tree depth
  --xml                     Output in XML format for LLM parsing
  --help                    Show this help message

${chalk.yellow('Examples:')}
  cn tree                   Show tree for current directory's space
  cn tree DOCS              Show tree for DOCS space
  cn tree --depth 2         Limit to 2 levels deep
  cn tree --xml             Output in XML format
`);
}

function showOpenHelp(): void {
  console.log(`
${chalk.bold('cn open - Open page in browser')}

${chalk.yellow('Usage:')}
  cn open [page]
  cn open [options]

${chalk.yellow('Description:')}
  Opens a Confluence page in your default browser.
  Without arguments, opens the space home page.

${chalk.yellow('Arguments:')}
  page                      Page title, file path, or page ID

${chalk.yellow('Options:')}
  --space <key>             Specify space key
  --help                    Show this help message

${chalk.yellow('Examples:')}
  cn open                   Open space home
  cn open "Getting Started" Open page by title
  cn open ./docs/page.md    Open page from local file
  cn open 123456789         Open page by ID
`);
}

function showSearchHelp(): void {
  console.log(`
${chalk.bold('cn search - Search indexed content')}

${chalk.yellow('Usage:')}
  cn search <query> [options]
  cn search index [options]
  cn search status

${chalk.yellow('Description:')}
  Search local Confluence content using Meilisearch.
  Requires Meilisearch to be running locally.

${chalk.yellow('Subcommands:')}
  cn search <query>         Search indexed content
  cn search index           Build or update the search index
  cn search status          Check Meilisearch connection and index status

${chalk.yellow('Search Options:')}
  --labels <label>          Filter by label (can be repeated)
  --author <email>          Filter by author email
  --created-after <date>    Documents created after date (YYYY-MM-DD)
  --created-before <date>   Documents created before date (YYYY-MM-DD)
  --updated-after <date>    Documents updated after date (YYYY-MM-DD)
  --updated-before <date>   Documents updated before date (YYYY-MM-DD)
  --created-within <dur>    Created within duration (e.g., 30d, 2w, 3m, 1y)
  --updated-within <dur>    Updated within duration (e.g., 7d, 2w)
  --stale <dur>             Not updated within duration (e.g., 90d, 6m)
  --sort <field>            Sort by: created_at, updated_at (prefix - for desc)
  --limit <n>               Max results (default: 10)
  --json                    Output as JSON
  --xml                     Output as XML
  --help                    Show this help message

${chalk.yellow('Index Options:')}
  --force                   Rebuild index from scratch
  --dry-run                 Show what would be indexed

${chalk.yellow('Prerequisites:')}
  Requires Meilisearch running locally:
    docker run -d -p 7700:7700 getmeili/meilisearch:latest

${chalk.yellow('Examples:')}
  cn search "authentication"              Basic search
  cn search "api" --labels documentation  Filter by label
  cn search "error" --limit 5             Limit results
  cn search "api" --updated-within 30d    Updated in last 30 days
  cn search "security" --sort -updated_at Sort by most recently updated
  cn search "" --stale 90d                Find stale content
  cn search index                         Build search index
  cn search index --force                 Rebuild index
  cn search status                        Check connection
`);
}

function showMcpHelp(): void {
  console.log(`
${chalk.bold('cn mcp - Start MCP server for AI assistant integration')}

${chalk.yellow('Usage:')}
  cn mcp [path]

${chalk.yellow('Description:')}
  Launches an MCP (Model Context Protocol) server over stdio transport.
  Exposes search and read_page tools for LLM clients like Claude Code.

${chalk.yellow('Arguments:')}
  path                      Path to space directory (default: current directory)

${chalk.yellow('Options:')}
  --help                    Show this help message

${chalk.yellow('Prerequisites:')}
  1. Meilisearch running locally
  2. Index created with "cn search index"
  3. Directory has .confluence.json

${chalk.yellow('Configuration:')}
  Add to ~/.claude/mcp.json:
  {
    "mcpServers": {
      "confluence": {
        "command": "cn",
        "args": ["mcp", "/path/to/space"]
      }
    }
  }

${chalk.yellow('Examples:')}
  cn mcp                    Start server for current directory
  cn mcp ~/docs/wiki        Start server for specific space
`);
}

function showHelp(): void {
  console.log(`
${chalk.bold('cn - Confluence CLI')}

Sync Confluence spaces to local markdown files.

${chalk.yellow('Commands:')}
  cn setup                  Configure Confluence credentials
  cn clone                  Clone a space to a new folder
  cn pull                   Pull space to local folder
  cn push                   Push local file to Confluence
  cn status                 Check connection and sync status
  cn tree                   Display page hierarchy
  cn open                   Open page in browser
  cn search                 Search indexed content (requires Meilisearch)
  cn mcp                    Start MCP server for AI assistant integration

${chalk.yellow('Global Options:')}
  --help, -h                Show help message
  --version, -v             Show version number
  --verbose                 Enable verbose output
  --xml                     Output in XML format (where supported)

${chalk.yellow('Environment Variables:')}
  CN_CONFIG_PATH            Override config file location
  CN_DEBUG                  Enable debug logging
  NO_COLOR                  Disable colored output

${chalk.yellow('Examples:')}
  cn setup                  Configure credentials
  cn clone DOCS             Clone DOCS space to ./DOCS
  cn pull                   Pull changes
  cn tree                   Show page hierarchy
  cn open "My Page"         Open page in browser

${chalk.gray('For more information on a command, run: cn <command> --help')}
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Handle no arguments or help
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    process.exit(EXIT_CODES.SUCCESS);
  }

  // Handle version
  if (args[0] === '--version' || args[0] === '-v') {
    console.log(`cn version ${VERSION}`);
    process.exit(EXIT_CODES.SUCCESS);
  }

  const command = args[0];
  const subArgs = args.slice(1);

  // Check for verbose mode
  const verbose = args.includes('--verbose');
  if (verbose && process.env.CN_DEBUG !== '1') {
    process.env.CN_DEBUG = '1';
  }

  try {
    switch (command) {
      case 'setup':
        if (args.includes('--help')) {
          showSetupHelp();
          process.exit(EXIT_CODES.SUCCESS);
        }
        await setup();
        break;

      case 'clone': {
        if (args.includes('--help')) {
          showCloneHelp();
          process.exit(EXIT_CODES.SUCCESS);
        }

        // Get space key (first non-flag argument after 'clone')
        const spaceKey = subArgs.find((arg) => !arg.startsWith('--'));
        if (!spaceKey) {
          console.error(chalk.red('Space key is required.'));
          console.log(chalk.gray('Usage: cn clone <SPACE_KEY> [directory]'));
          process.exit(EXIT_CODES.INVALID_ARGUMENTS);
        }

        // Get optional directory (second non-flag argument)
        const nonFlagArgs = subArgs.filter((arg) => !arg.startsWith('--'));
        const directory = nonFlagArgs[1];

        await cloneCommand({ spaceKey, directory });
        break;
      }

      case 'pull': {
        if (args.includes('--help')) {
          showPullHelp();
          process.exit(EXIT_CODES.SUCCESS);
        }

        const dryRun = args.includes('--dry-run');
        const force = args.includes('--force');

        let depth: number | undefined;
        const depthIndex = args.indexOf('--depth');
        if (depthIndex !== -1 && depthIndex + 1 < args.length) {
          depth = Number.parseInt(args[depthIndex + 1], 10);
        }

        // Collect all --page arguments (can appear multiple times)
        const pages: string[] = [];
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--page' && i + 1 < args.length) {
            pages.push(args[i + 1]);
          }
        }

        await pullCommand({ dryRun, force, depth, pages: pages.length > 0 ? pages : undefined });
        break;
      }

      case 'push': {
        if (args.includes('--help')) {
          showPushHelp();
          process.exit(EXIT_CODES.SUCCESS);
        }

        // File is optional - if not provided, scan for changes
        const file = subArgs.find((arg) => !arg.startsWith('--'));

        await pushCommand({
          file,
          force: args.includes('--force'),
          dryRun: args.includes('--dry-run'),
        });
        break;
      }

      case 'status':
        if (args.includes('--help')) {
          showStatusHelp();
          process.exit(EXIT_CODES.SUCCESS);
        }
        await statusCommand({ xml: args.includes('--xml') });
        break;

      case 'tree': {
        if (args.includes('--help')) {
          showTreeHelp();
          process.exit(EXIT_CODES.SUCCESS);
        }

        // Find space key (first non-flag argument)
        const spaceKey = subArgs.find((arg) => !arg.startsWith('--'));

        let depth: number | undefined;
        const depthIndex = args.indexOf('--depth');
        if (depthIndex !== -1 && depthIndex + 1 < args.length) {
          depth = Number.parseInt(args[depthIndex + 1], 10);
        }

        await treeCommand({
          spaceKey,
          remote: args.includes('--remote') || !args.includes('--local'),
          depth,
          xml: args.includes('--xml'),
        });
        break;
      }

      case 'open': {
        if (args.includes('--help')) {
          showOpenHelp();
          process.exit(EXIT_CODES.SUCCESS);
        }

        // Find page argument (first non-flag argument)
        const page = subArgs.find((arg) => !arg.startsWith('--'));

        let spaceKey: string | undefined;
        const spaceIndex = args.indexOf('--space');
        if (spaceIndex !== -1 && spaceIndex + 1 < args.length) {
          spaceKey = args[spaceIndex + 1];
        }

        await openCommand({ page, spaceKey });
        break;
      }

      case 'search': {
        if (args.includes('--help')) {
          showSearchHelp();
          process.exit(EXIT_CODES.SUCCESS);
        }

        // Check for subcommands: index, status
        const firstArg = subArgs.find((arg) => !arg.startsWith('--'));

        let subcommand: 'index' | 'status' | undefined;
        let query: string | undefined;

        if (firstArg === 'index') {
          subcommand = 'index';
        } else if (firstArg === 'status') {
          subcommand = 'status';
        } else if (firstArg) {
          query = firstArg;
        }

        // Collect all --labels arguments
        const labels: string[] = [];
        for (let i = 0; i < subArgs.length; i++) {
          if (subArgs[i] === '--labels' && i + 1 < subArgs.length) {
            labels.push(subArgs[i + 1]);
          }
        }

        // Get --author value
        let author: string | undefined;
        const authorIndex = subArgs.indexOf('--author');
        if (authorIndex !== -1 && authorIndex + 1 < subArgs.length) {
          author = subArgs[authorIndex + 1];
        }

        // Get --limit value
        let limit: number | undefined;
        const limitIndex = subArgs.indexOf('--limit');
        if (limitIndex !== -1 && limitIndex + 1 < subArgs.length) {
          limit = Number.parseInt(subArgs[limitIndex + 1], 10);
        }

        // Helper to get string option value
        const getStringOption = (name: string): string | undefined => {
          const idx = subArgs.indexOf(name);
          return idx !== -1 && idx + 1 < subArgs.length ? subArgs[idx + 1] : undefined;
        };

        // Get date filter options
        const createdAfter = getStringOption('--created-after');
        const createdBefore = getStringOption('--created-before');
        const updatedAfter = getStringOption('--updated-after');
        const updatedBefore = getStringOption('--updated-before');
        const createdWithin = getStringOption('--created-within');
        const updatedWithin = getStringOption('--updated-within');
        const stale = getStringOption('--stale');
        const sort = getStringOption('--sort');

        await searchCommand({
          query,
          subcommand,
          labels: labels.length > 0 ? labels : undefined,
          author,
          limit,
          createdAfter,
          createdBefore,
          updatedAfter,
          updatedBefore,
          createdWithin,
          updatedWithin,
          stale,
          sort,
          force: subArgs.includes('--force'),
          dryRun: subArgs.includes('--dry-run'),
          json: subArgs.includes('--json'),
          xml: subArgs.includes('--xml'),
        });
        break;
      }

      case 'mcp': {
        if (args.includes('--help')) {
          showMcpHelp();
          process.exit(EXIT_CODES.SUCCESS);
        }

        // Get path (first non-flag argument)
        const path = subArgs.find((arg) => !arg.startsWith('--'));

        await mcpCommand({ path });
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.log('Run "cn help" for usage information');
        process.exit(EXIT_CODES.INVALID_ARGUMENTS);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(EXIT_CODES.GENERAL_ERROR);
  }
}

// Run the CLI
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(EXIT_CODES.GENERAL_ERROR);
});
