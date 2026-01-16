import { describe, expect, test } from 'bun:test';
import {
  ConfigError,
  FileSystemError,
  ParseError,
  ValidationError,
  ApiError,
  RateLimitError,
  AuthError,
  SyncError,
  NetworkError,
  SpaceNotFoundError,
  PageNotFoundError,
  VersionConflictError,
  EXIT_CODES,
  getExitCodeForError,
} from '../lib/errors.js';

describe('Error types', () => {
  describe('ConfigError', () => {
    test('has correct _tag', () => {
      const error = new ConfigError('Test error');
      expect(error._tag).toBe('ConfigError');
      expect(error.message).toBe('Test error');
      expect(error.name).toBe('ConfigError');
    });
  });

  describe('FileSystemError', () => {
    test('has correct _tag', () => {
      const error = new FileSystemError('File not found');
      expect(error._tag).toBe('FileSystemError');
      expect(error.message).toBe('File not found');
    });
  });

  describe('ParseError', () => {
    test('has correct _tag', () => {
      const error = new ParseError('Invalid JSON');
      expect(error._tag).toBe('ParseError');
    });
  });

  describe('ValidationError', () => {
    test('has correct _tag', () => {
      const error = new ValidationError('Invalid config');
      expect(error._tag).toBe('ValidationError');
    });
  });

  describe('ApiError', () => {
    test('has correct _tag and statusCode', () => {
      const error = new ApiError('Not found', 404);
      expect(error._tag).toBe('ApiError');
      expect(error.statusCode).toBe(404);
    });
  });

  describe('RateLimitError', () => {
    test('has correct _tag and retryAfter', () => {
      const error = new RateLimitError('Too many requests', 60);
      expect(error._tag).toBe('RateLimitError');
      expect(error.retryAfter).toBe(60);
    });

    test('handles undefined retryAfter', () => {
      const error = new RateLimitError('Too many requests');
      expect(error.retryAfter).toBeUndefined();
    });
  });

  describe('AuthError', () => {
    test('has correct _tag and statusCode', () => {
      const error = new AuthError('Unauthorized', 401);
      expect(error._tag).toBe('AuthError');
      expect(error.statusCode).toBe(401);
    });
  });

  describe('SyncError', () => {
    test('has correct _tag', () => {
      const error = new SyncError('Sync failed');
      expect(error._tag).toBe('SyncError');
    });
  });

  describe('NetworkError', () => {
    test('has correct _tag', () => {
      const error = new NetworkError('Connection failed');
      expect(error._tag).toBe('NetworkError');
    });
  });

  describe('SpaceNotFoundError', () => {
    test('has correct _tag and spaceKey', () => {
      const error = new SpaceNotFoundError('TEST');
      expect(error._tag).toBe('SpaceNotFoundError');
      expect(error.spaceKey).toBe('TEST');
      expect(error.message).toBe('Space not found: TEST');
    });
  });

  describe('PageNotFoundError', () => {
    test('has correct _tag and pageId', () => {
      const error = new PageNotFoundError('123456');
      expect(error._tag).toBe('PageNotFoundError');
      expect(error.pageId).toBe('123456');
      expect(error.message).toBe('Page not found: 123456');
    });
  });

  describe('VersionConflictError', () => {
    test('has correct _tag and versions', () => {
      const error = new VersionConflictError(3, 5);
      expect(error._tag).toBe('VersionConflictError');
      expect(error.localVersion).toBe(3);
      expect(error.remoteVersion).toBe(5);
      expect(error.message).toContain('local version 3');
      expect(error.message).toContain('remote version 5');
    });
  });
});

describe('EXIT_CODES', () => {
  test('has all expected codes', () => {
    expect(EXIT_CODES.SUCCESS).toBe(0);
    expect(EXIT_CODES.GENERAL_ERROR).toBe(1);
    expect(EXIT_CODES.CONFIG_ERROR).toBe(2);
    expect(EXIT_CODES.AUTH_ERROR).toBe(3);
    expect(EXIT_CODES.NETWORK_ERROR).toBe(4);
    expect(EXIT_CODES.SPACE_NOT_FOUND).toBe(5);
    expect(EXIT_CODES.INVALID_ARGUMENTS).toBe(6);
    expect(EXIT_CODES.PAGE_NOT_FOUND).toBe(7);
    expect(EXIT_CODES.VERSION_CONFLICT).toBe(8);
  });
});

describe('getExitCodeForError', () => {
  test('returns CONFIG_ERROR for ConfigError', () => {
    const error = new ConfigError('Test');
    expect(getExitCodeForError(error)).toBe(EXIT_CODES.CONFIG_ERROR);
  });

  test('returns CONFIG_ERROR for ValidationError', () => {
    const error = new ValidationError('Test');
    expect(getExitCodeForError(error)).toBe(EXIT_CODES.CONFIG_ERROR);
  });

  test('returns AUTH_ERROR for AuthError', () => {
    const error = new AuthError('Test', 401);
    expect(getExitCodeForError(error)).toBe(EXIT_CODES.AUTH_ERROR);
  });

  test('returns NETWORK_ERROR for NetworkError', () => {
    const error = new NetworkError('Test');
    expect(getExitCodeForError(error)).toBe(EXIT_CODES.NETWORK_ERROR);
  });

  test('returns NETWORK_ERROR for RateLimitError', () => {
    const error = new RateLimitError('Test');
    expect(getExitCodeForError(error)).toBe(EXIT_CODES.NETWORK_ERROR);
  });

  test('returns SPACE_NOT_FOUND for SpaceNotFoundError', () => {
    const error = new SpaceNotFoundError('TEST');
    expect(getExitCodeForError(error)).toBe(EXIT_CODES.SPACE_NOT_FOUND);
  });

  test('returns PAGE_NOT_FOUND for PageNotFoundError', () => {
    const error = new PageNotFoundError('123456');
    expect(getExitCodeForError(error)).toBe(EXIT_CODES.PAGE_NOT_FOUND);
  });

  test('returns VERSION_CONFLICT for VersionConflictError', () => {
    const error = new VersionConflictError(3, 5);
    expect(getExitCodeForError(error)).toBe(EXIT_CODES.VERSION_CONFLICT);
  });

  test('returns GENERAL_ERROR for other errors', () => {
    const error = new ApiError('Test', 500);
    expect(getExitCodeForError(error)).toBe(EXIT_CODES.GENERAL_ERROR);
  });
});
