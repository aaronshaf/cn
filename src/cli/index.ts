#!/usr/bin/env bun
import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES } from '../lib/errors.js';
import { cloneCommand } from './commands/clone.js';
import { doctorCommand } from './commands/doctor.js';
import { openCommand } from './commands/open.js';
import { pullCommand } from './commands/pull.js';
import { pushCommand } from './commands/push.js';
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
${chalk.bold('cn clone - Clone one or more Confluence spaces to new folders')}

${chalk.yellow('Usage:')}
  cn clone <SPACE_KEY> [SPACE_KEY...]

${chalk.yellow('Description:')}
  Creates new directories and initializes them for Confluence spaces.
  Similar to "git clone" - sets up everything needed to pull pages.
  Each space is cloned into a directory named after its space key.

${chalk.yellow('Arguments:')}
  SPACE_KEY                 One or more Confluence space keys (required)

${chalk.yellow('Options:')}
  --help                    Show this help message

${chalk.yellow('Examples:')}
  cn clone DOCS             Clone DOCS space to ./DOCS/
  cn clone ABC DEF GHI      Clone multiple spaces to ./ABC/, ./DEF/, ./GHI/
  cn clone ENG PROD TEST    Clone three spaces sequentially
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

function showDoctorHelp(): void {
  console.log(`
${chalk.bold('cn doctor - Health check for synced spaces')}

${chalk.yellow('Usage:')}
  cn doctor [options]

${chalk.yellow('Description:')}
  Scans the current directory for common issues:
  - Duplicate page_ids (same page in multiple files)
  - Orphaned files (local files without Confluence pages)
  - Version mismatches

${chalk.yellow('Options:')}
  --fix                     Auto-fix issues (delete stale files)
  --xml                     Output in XML format for LLM parsing
  --help                    Show this help message

${chalk.yellow('Examples:')}
  cn doctor                 Run health check interactively
  cn doctor --fix           Auto-fix all detected issues
  cn doctor --xml           Output results in XML format
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
  cn doctor                 Health check for sync issues

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

        // Get space keys (all non-flag arguments after 'clone')
        const spaceKeys = subArgs.filter((arg) => !arg.startsWith('--'));
        if (spaceKeys.length === 0) {
          console.error(chalk.red('At least one space key is required.'));
          console.log(chalk.gray('Usage: cn clone <SPACE_KEY> [SPACE_KEY...]'));
          process.exit(EXIT_CODES.INVALID_ARGUMENTS);
        }

        await cloneCommand({ spaceKeys });
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

      case 'doctor':
        if (args.includes('--help')) {
          showDoctorHelp();
          process.exit(EXIT_CODES.SUCCESS);
        }
        await doctorCommand({
          fix: args.includes('--fix'),
          xml: args.includes('--xml'),
        });
        break;

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
