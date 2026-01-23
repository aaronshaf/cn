/**
 * Folder API operations for Confluence
 * Per ADR-0018 and ADR-0023
 */

import { Effect, pipe, Schedule, Schema } from 'effect';
import {
  ApiError,
  AuthError,
  FolderNotFoundError,
  NetworkError,
  PageNotFoundError,
  RateLimitError,
} from '../errors.js';
import { FolderSchema, type CreateFolderRequest, type Folder } from './types.js';

/**
 * Retry configuration for rate limiting
 */
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const rateLimitRetrySchedule = Schedule.exponential(BASE_DELAY_MS).pipe(
  Schedule.jittered,
  Schedule.whileInput((error: unknown) => error instanceof RateLimitError),
  Schedule.upTo(MAX_RETRIES * BASE_DELAY_MS * 32),
);

/**
 * Get a folder by ID (Effect version)
 */
export function getFolderEffect(
  baseUrl: string,
  authHeader: string,
  folderId: string,
): Effect.Effect<Folder, ApiError | AuthError | NetworkError | RateLimitError | FolderNotFoundError> {
  const makeRequest = Effect.tryPromise({
    try: async () => {
      const url = `${baseUrl}/wiki/api/v2/folders/${folderId}`;
      const response = await fetch(url, {
        headers: { Authorization: authHeader, Accept: 'application/json' },
      });

      if (response.status === 404) throw new FolderNotFoundError(folderId);
      if (response.status === 401) throw new AuthError('Invalid credentials', 401);
      if (response.status === 403) throw new AuthError('Access denied', 403);
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        throw new RateLimitError('Rate limited', retryAfter ? Number.parseInt(retryAfter, 10) : undefined);
      }
      if (!response.ok) throw new ApiError(`API error: ${response.status}`, response.status);

      const data = await response.json();
      return Schema.decodeUnknownSync(FolderSchema)(data);
    },
    catch: (error) => {
      if (
        error instanceof FolderNotFoundError ||
        error instanceof AuthError ||
        error instanceof ApiError ||
        error instanceof RateLimitError
      ) {
        return error;
      }
      return new NetworkError(`Network error: ${error}`);
    },
  });

  return pipe(makeRequest, Effect.retry(rateLimitRetrySchedule));
}

/**
 * Create a new folder (Effect version)
 */
export function createFolderEffect(
  baseUrl: string,
  authHeader: string,
  request: CreateFolderRequest,
): Effect.Effect<Folder, ApiError | AuthError | NetworkError | RateLimitError> {
  const url = `${baseUrl}/wiki/api/v2/folders`;

  const makeRequest = Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: authHeader, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        throw new RateLimitError('Rate limited', retryAfter ? Number.parseInt(retryAfter, 10) : undefined);
      }
      if (response.status === 401) throw new AuthError('Invalid credentials', 401);
      if (response.status === 403) throw new AuthError('Access denied', 403);
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
      Schema.decodeUnknown(FolderSchema)(data).pipe(
        Effect.mapError((e) => new ApiError(`Invalid response: ${e}`, 500)),
      ),
    ),
    Effect.retry(rateLimitRetrySchedule),
  );
}

/**
 * Move a page to a new parent (Effect version)
 * Uses v1 API: PUT /wiki/rest/api/content/{id}/move/{position}/{targetId}
 * Returns void since response structure varies and is not needed by callers
 */
export function movePageEffect(
  baseUrl: string,
  authHeader: string,
  pageId: string,
  targetId: string,
  position: 'append' | 'prepend' = 'append',
): Effect.Effect<void, ApiError | AuthError | NetworkError | RateLimitError | PageNotFoundError> {
  const url = `${baseUrl}/wiki/rest/api/content/${pageId}/move/${position}/${targetId}`;

  const makeRequest = Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: authHeader, Accept: 'application/json', 'Content-Type': 'application/json' },
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        throw new RateLimitError('Rate limited', retryAfter ? Number.parseInt(retryAfter, 10) : undefined);
      }
      if (response.status === 401) throw new AuthError('Invalid credentials', 401);
      if (response.status === 403) throw new AuthError('Access denied', 403);
      if (response.status === 404) throw new PageNotFoundError(pageId);
      if (!response.ok) {
        const errorText = await response.text();
        throw new ApiError(`API request failed: ${response.status} ${errorText}`, response.status);
      }
      // Response body not validated - structure varies when moving to folders vs pages
    },
    catch: (error) => {
      if (
        error instanceof RateLimitError ||
        error instanceof AuthError ||
        error instanceof ApiError ||
        error instanceof PageNotFoundError
      ) {
        return error;
      }
      return new NetworkError(`Network error: ${error}`);
    },
  });

  return pipe(makeRequest, Effect.retry(rateLimitRetrySchedule));
}
