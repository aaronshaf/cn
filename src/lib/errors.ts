/**
 * Error types for cn CLI with discriminated unions using _tag property
 * These error types follow the Effect pattern for type-safe error handling
 */

/**
 * Configuration-related errors (missing config, invalid config path)
 */
export class ConfigError extends Error {
  readonly _tag = 'ConfigError' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * File system operation errors
 */
export class FileSystemError extends Error {
  readonly _tag = 'FileSystemError' as const;

  constructor(message: string) {
    super(message);
    this.name = 'FileSystemError';
  }
}

/**
 * JSON parsing errors
 */
export class ParseError extends Error {
  readonly _tag = 'ParseError' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/**
 * Schema validation errors
 */
export class ValidationError extends Error {
  readonly _tag = 'ValidationError' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * API request errors with status code
 */
export class ApiError extends Error {
  readonly _tag = 'ApiError' as const;
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

/**
 * Rate limit errors (429 responses)
 */
export class RateLimitError extends Error {
  readonly _tag = 'RateLimitError' as const;
  readonly retryAfter?: number;

  constructor(message: string, retryAfter?: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/**
 * Authentication errors (401, 403)
 */
export class AuthError extends Error {
  readonly _tag = 'AuthError' as const;
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}

/**
 * Sync operation errors
 */
export class SyncError extends Error {
  readonly _tag = 'SyncError' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SyncError';
  }
}

/**
 * Network/connectivity errors
 */
export class NetworkError extends Error {
  readonly _tag = 'NetworkError' as const;

  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * Space not found errors
 */
export class SpaceNotFoundError extends Error {
  readonly _tag = 'SpaceNotFoundError' as const;
  readonly spaceKey: string;

  constructor(spaceKey: string) {
    super(`Space not found: ${spaceKey}`);
    this.name = 'SpaceNotFoundError';
    this.spaceKey = spaceKey;
  }
}

/**
 * Page not found errors (404 when updating)
 */
export class PageNotFoundError extends Error {
  readonly _tag = 'PageNotFoundError' as const;
  readonly pageId: string;

  constructor(pageId: string) {
    super(`Page not found: ${pageId}`);
    this.name = 'PageNotFoundError';
    this.pageId = pageId;
  }
}

/**
 * Version conflict errors (409 when updating with stale version)
 */
export class VersionConflictError extends Error {
  readonly _tag = 'VersionConflictError' as const;
  readonly localVersion: number;
  readonly remoteVersion: number;

  constructor(localVersion: number, remoteVersion: number) {
    super(`Version conflict: local version ${localVersion} does not match remote version ${remoteVersion}`);
    this.name = 'VersionConflictError';
    this.localVersion = localVersion;
    this.remoteVersion = remoteVersion;
  }
}

/**
 * Union type of all error types for comprehensive error handling
 */
export type CnError =
  | ConfigError
  | FileSystemError
  | ParseError
  | ValidationError
  | ApiError
  | RateLimitError
  | AuthError
  | SyncError
  | NetworkError
  | SpaceNotFoundError
  | PageNotFoundError
  | VersionConflictError;

/**
 * Exit codes for CLI
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  CONFIG_ERROR: 2,
  AUTH_ERROR: 3,
  NETWORK_ERROR: 4,
  SPACE_NOT_FOUND: 5,
  INVALID_ARGUMENTS: 6,
  PAGE_NOT_FOUND: 7,
  VERSION_CONFLICT: 8,
} as const;

/**
 * Get exit code for a given error
 */
export function getExitCodeForError(error: CnError): number {
  switch (error._tag) {
    case 'ConfigError':
    case 'ValidationError':
      return EXIT_CODES.CONFIG_ERROR;
    case 'AuthError':
      return EXIT_CODES.AUTH_ERROR;
    case 'NetworkError':
    case 'RateLimitError':
      return EXIT_CODES.NETWORK_ERROR;
    case 'SpaceNotFoundError':
      return EXIT_CODES.SPACE_NOT_FOUND;
    case 'PageNotFoundError':
      return EXIT_CODES.PAGE_NOT_FOUND;
    case 'VersionConflictError':
      return EXIT_CODES.VERSION_CONFLICT;
    default:
      return EXIT_CODES.GENERAL_ERROR;
  }
}
