import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { ConfluenceClient } from '../../lib/confluence-client/index.js';
import { ConfigManager } from '../../lib/config.js';
import { EXIT_CODES } from '../../lib/errors.js';
import { extractPageId } from '../../lib/markdown/index.js';
import { readSpaceConfig } from '../../lib/space-config.js';

export interface OpenCommandOptions {
  page?: string;
  spaceKey?: string;
}

/**
 * Open a URL in the default browser
 * Uses spawn with arguments array to prevent command injection
 */
function openUrl(url: string): void {
  const os = platform();
  let command: string;
  let args: string[];

  switch (os) {
    case 'darwin':
      command = 'open';
      args = [url];
      break;
    case 'win32':
      command = 'cmd';
      args = ['/c', 'start', '', url];
      break;
    default:
      command = 'xdg-open';
      args = [url];
  }

  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', (error) => {
    console.error(chalk.red(`Failed to open browser: ${error.message}`));
    console.log(chalk.gray(`URL: ${url}`));
  });
  child.unref();
}

/**
 * Open command - opens a page in the browser
 */
export async function openCommand(options: OpenCommandOptions = {}): Promise<void> {
  const configManager = new ConfigManager();
  const config = await configManager.getConfig();

  if (!config) {
    console.error(chalk.red('Not configured. Please run "cn setup" first.'));
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  const client = new ConfluenceClient(config);
  const directory = process.cwd();

  // Get space info
  let spaceKey: string | undefined = options.spaceKey;
  let spaceId: string | undefined;

  if (!spaceKey) {
    const spaceConfig = readSpaceConfig(directory);
    if (spaceConfig) {
      spaceKey = spaceConfig.spaceKey;
      spaceId = spaceConfig.spaceId;
    }
  }

  // If no page specified, open space home
  if (!options.page) {
    if (!spaceKey) {
      console.error(chalk.red('No space specified and no space configured in this directory.'));
      console.log(chalk.gray('Specify a page to open or run "cn sync --init <SPACE_KEY>" first.'));
      process.exit(EXIT_CODES.CONFIG_ERROR);
    }

    const url = `${config.confluenceUrl}/wiki/spaces/${spaceKey}`;
    console.log(chalk.gray(`Opening space: ${url}`));
    openUrl(url);
    return;
  }

  const pageArg = options.page;

  // Check if it's a file path
  if (pageArg.endsWith('.md') || pageArg.includes('/')) {
    const filePath = pageArg.startsWith('/') ? pageArg : join(directory, pageArg);

    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const pageId = extractPageId(content);

        if (pageId) {
          const page = await client.getPage(pageId, false);
          const webui = page._links?.webui;
          if (webui) {
            const url = `${config.confluenceUrl}/wiki${webui}`;
            console.log(chalk.gray(`Opening page: ${url}`));
            openUrl(url);
            return;
          }
        }
      } catch (_error) {
        // Fall through to other methods
      }
    }
  }

  // Check if it's a page ID (numeric string)
  if (/^\d+$/.test(pageArg)) {
    try {
      const page = await client.getPage(pageArg, false);
      const webui = page._links?.webui;
      if (webui) {
        const url = `${config.confluenceUrl}/wiki${webui}`;
        console.log(chalk.gray(`Opening page: ${url}`));
        openUrl(url);
        return;
      }
    } catch (_error) {
      // Fall through to title search
    }
  }

  // Search by title
  if (!spaceId && spaceKey) {
    try {
      const space = await client.getSpaceByKey(spaceKey);
      spaceId = space.id;
    } catch (_error) {
      console.error(chalk.red(`Space "${spaceKey}" not found.`));
      process.exit(EXIT_CODES.SPACE_NOT_FOUND);
    }
  }

  if (!spaceId) {
    console.error(chalk.red('No space specified. Use --space or configure a space in this directory.'));
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  // Search for page by title
  try {
    const pages = await client.getAllPagesInSpace(spaceId);
    const matchingPage = pages.find(
      (p) => p.title.toLowerCase() === pageArg.toLowerCase() || p.title.toLowerCase().includes(pageArg.toLowerCase()),
    );

    if (matchingPage) {
      const webui = matchingPage._links?.webui;
      if (webui) {
        const url = `${config.confluenceUrl}/wiki${webui}`;
        console.log(chalk.gray(`Opening page: ${url}`));
        openUrl(url);
        return;
      }

      // Fallback to constructing URL
      const url = `${config.confluenceUrl}/wiki/spaces/${spaceKey}/pages/${matchingPage.id}`;
      console.log(chalk.gray(`Opening page: ${url}`));
      openUrl(url);
      return;
    }

    console.error(chalk.red(`Page "${pageArg}" not found in space ${spaceKey}.`));
    process.exit(EXIT_CODES.GENERAL_ERROR);
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
    process.exit(EXIT_CODES.GENERAL_ERROR);
  }
}
