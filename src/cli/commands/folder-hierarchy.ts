/**
 * Folder hierarchy management for push operations
 * Per ADR-0023: Folder push workflow support
 */

import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { dirname } from 'node:path';
import type { ConfluenceClient, CreateFolderRequest } from '../../lib/confluence-client/index.js';
import { ApiError, EXIT_CODES } from '../../lib/errors.js';
import {
  getFolderByPath,
  updateFolderSyncInfo,
  writeSpaceConfig,
  type FolderSyncInfo,
  type SpaceConfigWithState,
} from '../../lib/space-config.js';

/**
 * Result of ensureFolderHierarchy operation
 */
export interface FolderHierarchyResult {
  parentId: string | undefined;
  /** True if page should be created at root then moved to folder (v2 API workaround) */
  shouldUseMoveWorkaround: boolean;
  updatedConfig: SpaceConfigWithState;
}

// Maximum folder hierarchy depth to prevent hitting Confluence limits
const MAX_FOLDER_DEPTH = 10;

// Characters not allowed in Confluence page/folder titles
const INVALID_TITLE_CHARS = /[|\\/:*?"<>]/g;

/**
 * Error thrown during folder hierarchy operations
 */
export class FolderHierarchyError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = 'FolderHierarchyError';
  }
}

/**
 * Sanitize folder title for Confluence
 * Removes invalid characters and returns sanitized title
 */
export function sanitizeFolderTitle(title: string): { sanitized: string; wasModified: boolean } {
  const sanitized = title.replace(INVALID_TITLE_CHARS, '-').trim();
  return { sanitized, wasModified: sanitized !== title };
}

/**
 * Ensure folder hierarchy exists for a file path
 * Per ADR-0023: Creates Confluence folders matching local directory structure
 *
 * @param client - Confluence client
 * @param spaceConfig - Current space configuration
 * @param directory - Base directory of the space
 * @param filePath - Relative path to the file (e.g., "docs/api/endpoints.md")
 * @param dryRun - If true, don't actually create folders
 * @returns The leaf folder ID as parentId and updated config
 */
export async function ensureFolderHierarchy(
  client: ConfluenceClient,
  spaceConfig: SpaceConfigWithState,
  directory: string,
  filePath: string,
  dryRun = false,
): Promise<FolderHierarchyResult> {
  // Extract directory path from file path
  const normalizedPath = filePath.replace(/^\.\//, '');
  const dirPath = dirname(normalizedPath);

  // Root level file - no folder needed
  if (dirPath === '.') {
    return { parentId: undefined, shouldUseMoveWorkaround: false, updatedConfig: spaceConfig };
  }

  // Split directory path into segments
  const segments = dirPath.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) {
    return { parentId: undefined, shouldUseMoveWorkaround: false, updatedConfig: spaceConfig };
  }

  // Path traversal validation - reject paths with ..
  if (segments.some((s) => s === '..')) {
    throw new FolderHierarchyError(
      `Invalid path: "${dirPath}" contains path traversal sequences`,
      EXIT_CODES.INVALID_ARGUMENTS,
    );
  }

  // Folder depth guard - prevent hitting Confluence hierarchy limits
  if (segments.length > MAX_FOLDER_DEPTH) {
    throw new FolderHierarchyError(
      `Folder hierarchy too deep: ${segments.length} levels (max: ${MAX_FOLDER_DEPTH})`,
      EXIT_CODES.INVALID_ARGUMENTS,
    );
  }

  let config = spaceConfig;
  let currentParentId: string | undefined;
  let currentPath = '';

  // Iterate through each directory segment
  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;

    // Check if folder already exists in local config
    const existingLocalFolder = getFolderByPath(config, currentPath);
    if (existingLocalFolder) {
      currentParentId = existingLocalFolder.folderId;
      continue;
    }

    // Sanitize folder title for Confluence
    const { sanitized: folderTitle, wasModified } = sanitizeFolderTitle(segment);
    if (wasModified) {
      console.log(chalk.yellow(`  Note: Folder title sanitized: "${segment}" → "${folderTitle}"`));
    }

    // Check if folder already exists on Confluence (not in local config)
    const existingRemoteFolder = await client.findFolderByTitle(config.spaceKey, folderTitle, currentParentId);
    if (existingRemoteFolder) {
      console.log(
        chalk.gray(
          `  Found existing folder on Confluence: ${existingRemoteFolder.title} (id: ${existingRemoteFolder.id})`,
        ),
      );

      // Track folder in config
      const folderInfo: FolderSyncInfo = {
        folderId: existingRemoteFolder.id,
        title: existingRemoteFolder.title,
        parentId: currentParentId,
        localPath: currentPath,
      };
      config = updateFolderSyncInfo(config, folderInfo);
      writeSpaceConfig(directory, config);

      currentParentId = existingRemoteFolder.id;
      continue;
    }

    if (dryRun) {
      console.log(chalk.gray(`  Would create folder: ${currentPath}`));
      // In dry run, we can't continue because we don't have a real folder ID
      // Return early indicating folders would need to be created
      return { parentId: undefined, shouldUseMoveWorkaround: true, updatedConfig: config };
    }

    // Prompt user for confirmation before creating folder
    const shouldCreate = await confirm({
      message: `Create folder "${folderTitle}" on Confluence?`,
      default: true,
    });

    if (!shouldCreate) {
      console.log(chalk.yellow(`  Skipping folder creation for "${folderTitle}"`));
      throw new FolderHierarchyError(
        `Cannot push to subdirectory without creating folder hierarchy`,
        EXIT_CODES.GENERAL_ERROR,
      );
    }

    console.log(chalk.gray(`  Creating folder: ${folderTitle}...`));

    // Create folder on Confluence
    const createRequest: CreateFolderRequest = {
      spaceId: config.spaceId,
      title: folderTitle,
      parentId: currentParentId,
    };

    try {
      const folder = await client.createFolder(createRequest);
      console.log(chalk.green(`  Created folder: ${folder.title} (id: ${folder.id})`));

      // Track folder in config
      const folderInfo: FolderSyncInfo = {
        folderId: folder.id,
        title: folder.title,
        parentId: currentParentId,
        localPath: currentPath,
      };
      config = updateFolderSyncInfo(config, folderInfo);

      // Save config immediately so we don't lose folder tracking on failure
      writeSpaceConfig(directory, config);

      currentParentId = folder.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(`  Failed to create folder "${folderTitle}": ${message}`));
      throw new FolderHierarchyError(`Failed to create folder: ${folderTitle}`, EXIT_CODES.GENERAL_ERROR);
    }
  }

  // Return the leaf folder ID - page will be created with this as parentId
  // The v2 API supports creating pages directly under folders
  return { parentId: currentParentId, shouldUseMoveWorkaround: false, updatedConfig: config };
}
