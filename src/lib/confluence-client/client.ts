import { Effect, pipe, Schedule, Schema } from 'effect';
import type { Config } from '../config.js';
import {
  ApiError,
  AuthError,
  type FolderNotFoundError,
  NetworkError,
  type PageNotFoundError,
  RateLimitError,
  SpaceNotFoundError,
  type VersionConflictError,
} from '../errors.js';
import {
  createFolderEffect as createFolderEffectFn,
  getFolderEffect as getFolderEffectFn,
  movePageEffect as movePageEffectFn,
} from './folder-operations.js';
import {
  createPageEffect as createPageEffectFn,
  setContentPropertyEffect as setContentPropertyEffectFn,
  updatePageEffect as updatePageEffectFn,
} from './page-operations.js';
import {
  FolderSchema,
  LabelsResponseSchema,
  PageSchema,
  PagesResponseSchema,
  SpaceSchema,
  SpacesResponseSchema,
  UserSchema,
  type CreateFolderRequest,
  type CreatePageRequest,
  type Folder,
  type Label,
  type LabelsResponse,
  type Page,
  type PagesResponse,
  type Space,
  type SpacesResponse,
  type UpdatePageRequest,
  type User,
  type VersionConflictResponse,
} from './types.js';

/**
 * Retry configuration for rate limiting
 * Uses exponential backoff with jitter per ADR-0010
 */
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
/** Shared retry schedule for rate-limited requests */
const rateLimitRetrySchedule = Schedule.exponential(BASE_DELAY_MS).pipe(
  Schedule.jittered,
  Schedule.whileInput((error: unknown) => error instanceof RateLimitError),
  Schedule.upTo(MAX_RETRIES * BASE_DELAY_MS * 32),
);

/**
 * Confluence API v2 client
 * Only supports Confluence Cloud (*.atlassian.net) per ADR-0012
 */
export class ConfluenceClient {
  private baseUrl: string;
  private authHeader: string;
  constructor(config: Config) {
    this.baseUrl = config.confluenceUrl;
    this.authHeader = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`;
  }

  /**
   * Make an authenticated API request with retry logic
   */
  private fetchWithRetryEffect<T>(
    path: string,
    schema: Schema.Schema<T>,
    options?: RequestInit,
  ): Effect.Effect<T, ApiError | AuthError | NetworkError | RateLimitError> {
    const url = `${this.baseUrl}/wiki/api/v2${path}`;

    const makeRequest = Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          ...options,
          headers: {
            Authorization: this.authHeader,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...options?.headers,
          },
        });

        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          throw new RateLimitError(
            'Rate limited by Confluence API',
            retryAfter ? Number.parseInt(retryAfter, 10) : undefined,
          );
        }

        if (response.status === 401) {
          throw new AuthError('Invalid credentials. Please check your email and API token.', 401);
        }

        if (response.status === 403) {
          throw new AuthError('Access denied. Please check your permissions.', 403);
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new ApiError(`API request failed: ${response.status} ${errorText}`, response.status);
        }

        return response.json();
      },
      catch: (error) => {
        if (error instanceof RateLimitError || error instanceof AuthError || error instanceof ApiError) {
          return error;
        }
        return new NetworkError(`Network error: ${error}`);
      },
    });

    return pipe(
      makeRequest,
      Effect.flatMap((data) =>
        Schema.decodeUnknown(schema)(data).pipe(Effect.mapError((e) => new ApiError(`Invalid response: ${e}`, 500))),
      ),
      Effect.retry(rateLimitRetrySchedule),
    );
  }

  /**
   * Async wrapper for fetch with retry
   */
  private async fetchWithRetry<T>(path: string, schema: Schema.Schema<T>, options?: RequestInit): Promise<T> {
    return Effect.runPromise(this.fetchWithRetryEffect(path, schema, options));
  }

  // ================== Spaces API ==================

  /**
   * Get all spaces (Effect version)
   */
  getSpacesEffect(limit = 25): Effect.Effect<SpacesResponse, ApiError | AuthError | NetworkError | RateLimitError> {
    return this.fetchWithRetryEffect(`/spaces?limit=${limit}`, SpacesResponseSchema);
  }

  /**
   * Get all spaces (async version)
   */
  async getSpaces(limit = 25): Promise<SpacesResponse> {
    return this.fetchWithRetry(`/spaces?limit=${limit}`, SpacesResponseSchema);
  }

  /**
   * Get a space by key (Effect version)
   */
  getSpaceByKeyEffect(
    key: string,
  ): Effect.Effect<Space, ApiError | AuthError | NetworkError | RateLimitError | SpaceNotFoundError> {
    return pipe(
      this.fetchWithRetryEffect(`/spaces?keys=${key}&limit=1`, SpacesResponseSchema),
      Effect.flatMap((response) => {
        if (response.results.length === 0) {
          return Effect.fail(new SpaceNotFoundError(key));
        }
        return Effect.succeed(response.results[0]);
      }),
    );
  }

  /**
   * Get a space by key (async version)
   */
  async getSpaceByKey(key: string): Promise<Space> {
    const response = await this.fetchWithRetry(`/spaces?keys=${key}&limit=1`, SpacesResponseSchema);
    if (response.results.length === 0) {
      throw new SpaceNotFoundError(key);
    }
    return response.results[0];
  }

  /**
   * Get a space by ID (Effect version)
   */
  getSpaceByIdEffect(
    id: string,
  ): Effect.Effect<Space, ApiError | AuthError | NetworkError | RateLimitError | SpaceNotFoundError> {
    const baseUrl = this.baseUrl;
    const authHeader = this.authHeader;

    return Effect.tryPromise({
      try: async () => {
        const url = `${baseUrl}/wiki/api/v2/spaces/${id}`;
        const response = await fetch(url, {
          headers: {
            Authorization: authHeader,
            Accept: 'application/json',
          },
        });

        if (response.status === 404) {
          throw new SpaceNotFoundError(id);
        }
        if (response.status === 401) {
          throw new AuthError('Invalid credentials', 401);
        }
        if (response.status === 403) {
          throw new AuthError('Access denied', 403);
        }
        if (!response.ok) {
          throw new ApiError(`API error: ${response.status}`, response.status);
        }

        const data = await response.json();
        return Schema.decodeUnknownSync(SpaceSchema)(data);
      },
      catch: (error) => {
        if (error instanceof SpaceNotFoundError || error instanceof AuthError || error instanceof ApiError) {
          return error;
        }
        return new NetworkError(`Network error: ${error}`);
      },
    });
  }

  /**
   * Get a space by ID (async version)
   */
  async getSpaceById(id: string): Promise<Space> {
    return Effect.runPromise(this.getSpaceByIdEffect(id));
  }

  // ================== Pages API ==================

  /**
   * Get all pages in a space (Effect version)
   */
  getPagesInSpaceEffect(
    spaceId: string,
    limit = 25,
    cursor?: string,
  ): Effect.Effect<PagesResponse, ApiError | AuthError | NetworkError | RateLimitError> {
    let path = `/spaces/${spaceId}/pages?limit=${limit}&body-format=storage`;
    if (cursor) {
      path += `&cursor=${encodeURIComponent(cursor)}`;
    }
    return this.fetchWithRetryEffect(path, PagesResponseSchema);
  }

  /**
   * Get all pages in a space (async version)
   */
  async getPagesInSpace(spaceId: string, limit = 25, cursor?: string): Promise<PagesResponse> {
    return Effect.runPromise(this.getPagesInSpaceEffect(spaceId, limit, cursor));
  }

  /**
   * Get all pages in a space with pagination (async version)
   */
  async getAllPagesInSpace(spaceId: string): Promise<Page[]> {
    const allPages: Page[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.getPagesInSpace(spaceId, 100, cursor);
      allPages.push(...response.results);

      // Extract cursor from next link if present
      const nextLink = response._links?.next;
      if (nextLink) {
        const cursorMatch = nextLink.match(/cursor=([^&]+)/);
        cursor = cursorMatch ? decodeURIComponent(cursorMatch[1]) : undefined;
      } else {
        cursor = undefined;
      }
    } while (cursor);

    return allPages;
  }

  /**
   * Get a single page by ID (Effect version)
   */
  getPageEffect(
    pageId: string,
    includeBody = true,
  ): Effect.Effect<Page, ApiError | AuthError | NetworkError | RateLimitError> {
    const bodyFormat = includeBody ? '&body-format=storage' : '';
    return this.fetchWithRetryEffect(`/pages/${pageId}?${bodyFormat}`, PageSchema);
  }

  /**
   * Get a single page by ID (async version)
   */
  async getPage(pageId: string, includeBody = true): Promise<Page> {
    return Effect.runPromise(this.getPageEffect(pageId, includeBody));
  }

  /**
   * Update a page (Effect version)
   * Uses PUT /wiki/api/v2/pages/{id} endpoint
   */
  updatePageEffect(
    request: UpdatePageRequest,
  ): Effect.Effect<
    Page,
    ApiError | AuthError | NetworkError | RateLimitError | PageNotFoundError | VersionConflictError
  > {
    return updatePageEffectFn(this.baseUrl, this.authHeader, request);
  }

  /**
   * Update a page (async version)
   */
  async updatePage(request: UpdatePageRequest): Promise<Page> {
    return Effect.runPromise(this.updatePageEffect(request));
  }

  /**
   * Create a new page (Effect version)
   */
  createPageEffect(
    request: CreatePageRequest,
  ): Effect.Effect<Page, ApiError | AuthError | NetworkError | RateLimitError> {
    return createPageEffectFn(this.baseUrl, this.authHeader, request);
  }

  /**
   * Create a new page (async version)
   */
  async createPage(request: CreatePageRequest): Promise<Page> {
    return Effect.runPromise(this.createPageEffect(request));
  }

  /** Set a content property on a page (Effect version) */
  setContentPropertyEffect(
    pageId: string,
    key: string,
    value: unknown,
  ): Effect.Effect<void, ApiError | AuthError | NetworkError | RateLimitError> {
    return setContentPropertyEffectFn(this.baseUrl, this.authHeader, pageId, key, value);
  }

  /** Set a content property on a page (async version) */
  async setContentProperty(pageId: string, key: string, value: unknown): Promise<void> {
    return Effect.runPromise(this.setContentPropertyEffect(pageId, key, value));
  }

  /** Set editor version to v2 for a page (enables new editor) */
  async setEditorV2(pageId: string): Promise<void> {
    return this.setContentProperty(pageId, 'editor', 'v2');
  }

  /**
   * Get child pages of a page (Effect version)
   */
  getChildPagesEffect(
    pageId: string,
    limit = 25,
    cursor?: string,
  ): Effect.Effect<PagesResponse, ApiError | AuthError | NetworkError | RateLimitError> {
    let path = `/pages/${pageId}/children?limit=${limit}`;
    if (cursor) {
      path += `&cursor=${encodeURIComponent(cursor)}`;
    }
    return this.fetchWithRetryEffect(path, PagesResponseSchema);
  }

  /**
   * Get child pages of a page (async version)
   */
  async getChildPages(pageId: string, limit = 25, cursor?: string): Promise<PagesResponse> {
    return Effect.runPromise(this.getChildPagesEffect(pageId, limit, cursor));
  }

  // ================== Labels API ==================

  /**
   * Get labels for a page (Effect version)
   */
  getLabelsEffect(
    pageId: string,
    limit = 25,
  ): Effect.Effect<LabelsResponse, ApiError | AuthError | NetworkError | RateLimitError> {
    return this.fetchWithRetryEffect(`/pages/${pageId}/labels?limit=${limit}`, LabelsResponseSchema);
  }

  /**
   * Get labels for a page (async version)
   */
  async getLabels(pageId: string, limit = 25): Promise<LabelsResponse> {
    return Effect.runPromise(this.getLabelsEffect(pageId, limit));
  }

  /**
   * Get all labels for a page (async version)
   */
  async getAllLabels(pageId: string): Promise<Label[]> {
    const response = await this.getLabels(pageId, 100);
    return [...response.results];
  }

  // ================== Users API ==================

  /**
   * Get user information by account ID (Effect version)
   * Uses v1 API as v2 does not have a user endpoint
   */
  getUserEffect(accountId: string): Effect.Effect<User, ApiError | AuthError | NetworkError | RateLimitError> {
    const url = `${this.baseUrl}/wiki/rest/api/user?accountId=${encodeURIComponent(accountId)}`;

    const makeRequest = Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          headers: {
            Authorization: this.authHeader,
            Accept: 'application/json',
          },
        });

        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          throw new RateLimitError(
            'Rate limited by Confluence API',
            retryAfter ? Number.parseInt(retryAfter, 10) : undefined,
          );
        }

        if (response.status === 401) {
          throw new AuthError('Invalid credentials', 401);
        }

        if (response.status === 403) {
          throw new AuthError('Access denied', 403);
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new ApiError(`API request failed: ${response.status} ${errorText}`, response.status);
        }

        return response.json();
      },
      catch: (error) => {
        if (error instanceof RateLimitError || error instanceof AuthError || error instanceof ApiError) {
          return error;
        }
        return new NetworkError(`Network error: ${error}`);
      },
    });

    return pipe(
      makeRequest,
      Effect.flatMap((data) =>
        Schema.decodeUnknown(UserSchema)(data).pipe(
          Effect.mapError((e) => new ApiError(`Invalid user response: ${e}`, 500)),
        ),
      ),
      Effect.retry(rateLimitRetrySchedule),
    );
  }

  /**
   * Get user information by account ID (async version)
   */
  async getUser(accountId: string): Promise<User> {
    return Effect.runPromise(this.getUserEffect(accountId));
  }

  // ================== Folders API ==================

  /**
   * Get a folder by ID (Effect version)
   * Uses v2 /folders/{id} endpoint per ADR-0018
   */
  getFolderEffect(
    folderId: string,
  ): Effect.Effect<Folder, ApiError | AuthError | NetworkError | RateLimitError | FolderNotFoundError> {
    return getFolderEffectFn(this.baseUrl, this.authHeader, folderId);
  }

  /**
   * Get a folder by ID (async version)
   */
  async getFolder(folderId: string): Promise<Folder> {
    return Effect.runPromise(this.getFolderEffect(folderId));
  }

  /**
   * Discover and fetch all folders referenced by pages
   * Finds pages with parentIds that don't match any page and fetches those as folders
   */
  async discoverFolders(pages: Page[]): Promise<Folder[]> {
    const pageIds = new Set(pages.map((p) => p.id));
    const potentialFolderIds = new Set<string>();

    // Find parentIds that aren't pages
    for (const page of pages) {
      if (page.parentId && !pageIds.has(page.parentId)) {
        potentialFolderIds.add(page.parentId);
      }
    }

    // Fetch each potential folder
    const folders: Folder[] = [];
    for (const folderId of potentialFolderIds) {
      try {
        const folder = await this.getFolder(folderId);
        folders.push(folder);

        // Check if this folder's parent is also a folder we need
        if (folder.parentId && !pageIds.has(folder.parentId) && !potentialFolderIds.has(folder.parentId)) {
          potentialFolderIds.add(folder.parentId);
        }
      } catch {
        // Silently skip if folder fetch fails (might be deleted)
      }
    }

    return folders;
  }

  /**
   * Get all pages and folders in a space
   */
  async getAllContentInSpace(spaceId: string): Promise<{ pages: Page[]; folders: Folder[] }> {
    const pages = await this.getAllPagesInSpace(spaceId);
    const folders = await this.discoverFolders(pages);
    return { pages, folders };
  }

  /**
   * Create a new folder (Effect version)
   * Uses POST /wiki/api/v2/folders endpoint
   */
  createFolderEffect(
    request: CreateFolderRequest,
  ): Effect.Effect<Folder, ApiError | AuthError | NetworkError | RateLimitError> {
    return createFolderEffectFn(this.baseUrl, this.authHeader, request);
  }

  /**
   * Create a new folder (async version)
   */
  async createFolder(request: CreateFolderRequest): Promise<Folder> {
    return Effect.runPromise(this.createFolderEffect(request));
  }

  /**
   * Find a folder by title in a space
   * Uses v1 CQL search API to find folders by title
   * @param spaceKey - Space key to search in
   * @param title - Folder title to find
   * @param parentId - Optional parent folder ID (for nested folders)
   * @returns Folder if found, null otherwise
   */
  async findFolderByTitle(spaceKey: string, title: string, parentId?: string): Promise<Folder | null> {
    // Build CQL query - escape quotes in title
    const escapedTitle = title.replace(/"/g, '\\"');
    let cql = `type=folder AND space="${spaceKey}" AND title="${escapedTitle}"`;
    if (parentId) {
      cql += ` AND parent=${parentId}`;
    }

    const url = `${this.baseUrl}/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=10`;

    const response = await fetch(url, {
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
    });

    if (!response.ok) {
      // Search failed, return null rather than throwing
      return null;
    }

    const data = await response.json();
    const results = data?.results || [];

    // Find exact title match (CQL search may return partial matches)
    for (const result of results) {
      if (result.content?.type === 'folder' && result.content?.title === title) {
        // Convert v1 API result to v2 Folder format
        const content = result.content;
        return {
          id: content.id,
          type: 'folder' as const,
          title: content.title,
          parentId: content.ancestors?.length > 0 ? content.ancestors[content.ancestors.length - 1]?.id : undefined,
        };
      }
    }

    return null;
  }

  /**
   * Move a page to a new parent (Effect version)
   * Uses v1 API: PUT /wiki/rest/api/content/{id}/move/{position}/{targetId}
   */
  movePageEffect(
    pageId: string,
    targetId: string,
    position: 'append' | 'prepend' = 'append',
  ): Effect.Effect<void, ApiError | AuthError | NetworkError | RateLimitError | PageNotFoundError> {
    return movePageEffectFn(this.baseUrl, this.authHeader, pageId, targetId, position);
  }

  /**
   * Move a page to a new parent (async version)
   */
  async movePage(pageId: string, targetId: string, position: 'append' | 'prepend' = 'append'): Promise<void> {
    return Effect.runPromise(this.movePageEffect(pageId, targetId, position));
  }

  // ================== Verification ==================

  /**
   * Verify connection by fetching spaces (Effect version)
   */
  verifyConnectionEffect(): Effect.Effect<boolean, ApiError | AuthError | NetworkError | RateLimitError> {
    return pipe(
      this.getSpacesEffect(1),
      Effect.map(() => true),
    );
  }

  /**
   * Verify connection by fetching spaces (async version)
   */
  async verifyConnection(): Promise<boolean> {
    await this.getSpaces(1);
    return true;
  }
}
