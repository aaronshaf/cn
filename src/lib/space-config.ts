import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Schema } from 'effect';

/**
 * Page sync info schema for validation
 */
const PageSyncInfoSchema = Schema.Struct({
  pageId: Schema.String,
  version: Schema.Number,
  lastModified: Schema.optional(Schema.String),
  localPath: Schema.String,
  title: Schema.optional(Schema.String), // Added for link conversion (ADR-0022)
});

/**
 * Search configuration schema for Meilisearch integration
 */
const SearchConfigSchema = Schema.Struct({
  meilisearchUrl: Schema.optional(Schema.String),
  apiKey: Schema.optional(Schema.NullOr(Schema.String)),
  indexName: Schema.optional(Schema.String),
});

export type SearchConfig = Schema.Schema.Type<typeof SearchConfigSchema>;

/**
 * Page sync information stored in .confluence.json
 */
export type PageSyncInfo = Schema.Schema.Type<typeof PageSyncInfoSchema>;

/**
 * Space configuration schema
 */
const SpaceConfigSchema = Schema.Struct({
  spaceKey: Schema.String,
  spaceId: Schema.String,
  spaceName: Schema.String,
  lastSync: Schema.optional(Schema.String),
  syncState: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Any })),
});

export type SpaceConfig = Schema.Schema.Type<typeof SpaceConfigSchema>;

/**
 * Full space configuration schema including sync state
 */
const SpaceConfigWithStateSchema = Schema.Struct({
  spaceKey: Schema.String,
  spaceId: Schema.String,
  spaceName: Schema.String,
  lastSync: Schema.optional(Schema.String),
  syncState: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Any })),
  pages: Schema.Record({ key: Schema.String, value: PageSyncInfoSchema }),
  search: Schema.optional(SearchConfigSchema),
});

/**
 * Full space configuration including sync state
 */
export type SpaceConfigWithState = Schema.Schema.Type<typeof SpaceConfigWithStateSchema>;

const CONFIG_FILENAME = '.confluence.json';

/**
 * Read space configuration from the current directory
 * Validates the config against the schema for security
 */
export function readSpaceConfig(directory: string): SpaceConfigWithState | null {
  const configPath = join(directory, CONFIG_FILENAME);

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content);
    // Validate against schema to prevent malformed config attacks
    return Schema.decodeUnknownSync(SpaceConfigWithStateSchema)(parsed);
  } catch {
    // Invalid config file - return null to indicate no valid config
    return null;
  }
}

/**
 * Write space configuration to the current directory
 */
export function writeSpaceConfig(directory: string, config: SpaceConfigWithState): void {
  const configPath = join(directory, CONFIG_FILENAME);
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Check if a directory has space configuration
 */
export function hasSpaceConfig(directory: string): boolean {
  return existsSync(join(directory, CONFIG_FILENAME));
}

/**
 * Create initial space configuration
 */
export function createSpaceConfig(spaceKey: string, spaceId: string, spaceName: string): SpaceConfigWithState {
  return {
    spaceKey,
    spaceId,
    spaceName,
    pages: {},
  };
}

/**
 * Update the last sync time in the configuration
 */
export function updateLastSync(config: SpaceConfigWithState): SpaceConfigWithState {
  return {
    ...config,
    lastSync: new Date().toISOString(),
  };
}

/**
 * Add or update a page in the sync state
 */
export function updatePageSyncInfo(config: SpaceConfigWithState, pageInfo: PageSyncInfo): SpaceConfigWithState {
  return {
    ...config,
    pages: {
      ...config.pages,
      [pageInfo.pageId]: pageInfo,
    },
  };
}

/**
 * Remove a page from the sync state
 */
export function removePageSyncInfo(config: SpaceConfigWithState, pageId: string): SpaceConfigWithState {
  const { [pageId]: _, ...remainingPages } = config.pages;
  return {
    ...config,
    pages: remainingPages,
  };
}

/**
 * Get all tracked page IDs
 */
export function getTrackedPageIds(config: SpaceConfigWithState): string[] {
  return Object.keys(config.pages);
}
