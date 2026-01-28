import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { http, HttpResponse } from 'msw';
import { cloneCommand } from '../cli/commands/clone.js';
import { server } from './setup-msw.js';
import { createValidSpace, createValidPage } from './msw-schema-validation.js';

describe('cloneCommand', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    // Create a unique test directory
    testDir = join(tmpdir(), `cn-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Change to test directory
    originalCwd = process.cwd();
    process.chdir(testDir);

    // Mock config
    process.env.HOME = testDir;
    const configDir = join(testDir, '.cn');
    mkdirSync(configDir, { recursive: true });
    Bun.write(
      join(configDir, 'config.json'),
      JSON.stringify({
        baseUrl: 'https://test.atlassian.net',
        email: 'test@example.com',
        apiToken: 'test-token',
      }),
    );
  });

  afterEach(() => {
    // Restore original directory
    process.chdir(originalCwd);

    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe('single space', () => {
    beforeEach(() => {
      // Mock API responses for single space
      server.use(
        http.get('*/wiki/api/v2/spaces', ({ request }) => {
          const url = new URL(request.url);
          const keys = url.searchParams.get('keys');
          if (keys === 'TEST1') {
            return HttpResponse.json({
              results: [createValidSpace({ id: 'space-123', key: 'TEST1', name: 'Test Space 1' })],
            });
          }
          return HttpResponse.json({ results: [] });
        }),
        http.get('*/wiki/api/v2/spaces/:spaceId/pages', () => {
          return HttpResponse.json({
            results: [
              createValidPage({
                id: 'page-1',
                spaceId: 'space-123',
                title: 'Home',
                parentId: null,
              }),
            ],
          });
        }),
        http.get('*/wiki/api/v2/pages/:pageId', () => {
          return HttpResponse.json(
            createValidPage({
              id: 'page-1',
              spaceId: 'space-123',
              title: 'Home',
              parentId: null,
              body: '<p>Test content</p>',
            }),
          );
        }),
      );
    });

    test('clones a single space successfully', async () => {
      await cloneCommand({ spaceKeys: ['TEST1'] });

      // Verify directory was created
      expect(existsSync(join(testDir, 'TEST1'))).toBe(true);

      // Verify .confluence.json was created
      expect(existsSync(join(testDir, 'TEST1', '.confluence.json'))).toBe(true);
    });

    test('throws error if directory already exists', async () => {
      // Create directory first
      mkdirSync(join(testDir, 'TEST1'));

      const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      await expect(cloneCommand({ spaceKeys: ['TEST1'] })).rejects.toThrow('process.exit called');

      exitSpy.mockRestore();
    });
  });

  describe('multiple spaces', () => {
    beforeEach(() => {
      // Mock API responses for multiple spaces
      server.use(
        http.get('*/wiki/api/v2/spaces', ({ request }) => {
          const url = new URL(request.url);
          const keys = url.searchParams.get('keys');

          if (keys === 'TEST1') {
            return HttpResponse.json({
              results: [createValidSpace({ id: 'space-123', key: 'TEST1', name: 'Test Space 1' })],
            });
          }
          if (keys === 'TEST2') {
            return HttpResponse.json({
              results: [createValidSpace({ id: 'space-456', key: 'TEST2', name: 'Test Space 2' })],
            });
          }
          if (keys === 'TEST3') {
            return HttpResponse.json({
              results: [createValidSpace({ id: 'space-789', key: 'TEST3', name: 'Test Space 3' })],
            });
          }
          return HttpResponse.json({ results: [] });
        }),
        http.get('*/wiki/api/v2/spaces/:spaceId/pages', () => {
          return HttpResponse.json({
            results: [
              createValidPage({
                id: 'page-1',
                spaceId: 'space-123',
                title: 'Home',
                parentId: null,
              }),
            ],
          });
        }),
        http.get('*/wiki/api/v2/pages/:pageId', () => {
          return HttpResponse.json(
            createValidPage({
              id: 'page-1',
              spaceId: 'space-123',
              title: 'Home',
              parentId: null,
              body: '<p>Test content</p>',
            }),
          );
        }),
      );
    });

    test('clones multiple spaces successfully', async () => {
      await cloneCommand({ spaceKeys: ['TEST1', 'TEST2', 'TEST3'] });

      // Verify all directories were created
      expect(existsSync(join(testDir, 'TEST1'))).toBe(true);
      expect(existsSync(join(testDir, 'TEST2'))).toBe(true);
      expect(existsSync(join(testDir, 'TEST3'))).toBe(true);

      // Verify .confluence.json was created for each
      expect(existsSync(join(testDir, 'TEST1', '.confluence.json'))).toBe(true);
      expect(existsSync(join(testDir, 'TEST2', '.confluence.json'))).toBe(true);
      expect(existsSync(join(testDir, 'TEST3', '.confluence.json'))).toBe(true);
    });

    test('continues cloning when one space fails', async () => {
      // Pre-create TEST2 directory to cause failure
      mkdirSync(join(testDir, 'TEST2'));

      const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      await expect(cloneCommand({ spaceKeys: ['TEST1', 'TEST2', 'TEST3'] })).rejects.toThrow('process.exit called');

      // Verify TEST1 and TEST3 were still created
      expect(existsSync(join(testDir, 'TEST1'))).toBe(true);
      expect(existsSync(join(testDir, 'TEST3'))).toBe(true);

      // Verify TEST2 already existed
      expect(existsSync(join(testDir, 'TEST2', '.confluence.json'))).toBe(false);

      // Verify process.exit was called with error code
      expect(exitSpy).toHaveBeenCalled();

      exitSpy.mockRestore();
    });

    test('exits with error code when all spaces fail', async () => {
      // Pre-create all directories to cause all failures
      mkdirSync(join(testDir, 'TEST1'));
      mkdirSync(join(testDir, 'TEST2'));
      mkdirSync(join(testDir, 'TEST3'));

      const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      await expect(cloneCommand({ spaceKeys: ['TEST1', 'TEST2', 'TEST3'] })).rejects.toThrow('process.exit called');

      expect(exitSpy).toHaveBeenCalled();

      exitSpy.mockRestore();
    });
  });

  describe('error handling', () => {
    test('exits if not configured', async () => {
      // Create a new test directory without config
      const noConfigDir = join(tmpdir(), `cn-test-noconfig-${Date.now()}`);
      mkdirSync(noConfigDir, { recursive: true });

      // Save and override CN_CONFIG_PATH to point to directory without config
      const savedConfigPath = process.env.CN_CONFIG_PATH;
      process.env.CN_CONFIG_PATH = noConfigDir;

      const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      try {
        await expect(cloneCommand({ spaceKeys: ['TEST1'] })).rejects.toThrow('process.exit called');
      } finally {
        exitSpy.mockRestore();

        // Restore
        if (savedConfigPath) {
          process.env.CN_CONFIG_PATH = savedConfigPath;
        } else {
          delete process.env.CN_CONFIG_PATH;
        }

        // Clean up
        if (existsSync(noConfigDir)) {
          rmSync(noConfigDir, { recursive: true });
        }
      }
    });

    test('handles space not found error', async () => {
      // Mock API to return no spaces
      server.use(
        http.get('*/wiki/api/v2/spaces', () => {
          return HttpResponse.json({ results: [] });
        }),
      );

      const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      await expect(cloneCommand({ spaceKeys: ['NOTFOUND'] })).rejects.toThrow('process.exit called');

      exitSpy.mockRestore();
    });

    test('handles duplicate space keys', async () => {
      const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      await expect(cloneCommand({ spaceKeys: ['TEST1', 'TEST2', 'TEST1'] })).rejects.toThrow('process.exit called');

      exitSpy.mockRestore();
    });
  });

  describe('console output', () => {
    beforeEach(() => {
      // Mock API responses for console output tests
      server.use(
        http.get('*/wiki/api/v2/spaces', ({ request }) => {
          const url = new URL(request.url);
          const keys = url.searchParams.get('keys');
          if (keys === 'TEST1' || keys === 'TEST2' || keys === 'TEST3') {
            return HttpResponse.json({
              results: [
                createValidSpace({
                  id: `space-${keys}`,
                  key: keys || 'TEST1',
                  name: `Test Space ${keys}`,
                }),
              ],
            });
          }
          return HttpResponse.json({ results: [] });
        }),
        http.get('*/wiki/api/v2/spaces/:spaceId/pages', () => {
          return HttpResponse.json({
            results: [
              createValidPage({
                id: 'page-1',
                spaceId: 'space-123',
                title: 'Home',
                parentId: null,
              }),
            ],
          });
        }),
        http.get('*/wiki/api/v2/pages/:pageId', () => {
          return HttpResponse.json(
            createValidPage({
              id: 'page-1',
              spaceId: 'space-123',
              title: 'Home',
              parentId: null,
              body: '<p>Test content</p>',
            }),
          );
        }),
      );
    });

    test('displays separator and progress for multiple spaces', async () => {
      const consoleSpy = spyOn(console, 'log');

      await cloneCommand({ spaceKeys: ['TEST1', 'TEST2', 'TEST3'] });

      // Check for progress indicators
      const output = consoleSpy.mock.calls.map((call) => call[0]).join('\n');
      expect(output).toContain('Cloning 1/3:');
      expect(output).toContain('Cloning 2/3:');
      expect(output).toContain('Cloning 3/3:');
      expect(output).toContain('Clone Summary');
      expect(output).toContain('Successfully cloned:');

      consoleSpy.mockRestore();
    });

    test('does not display separator for single space', async () => {
      const consoleSpy = spyOn(console, 'log');

      await cloneCommand({ spaceKeys: ['TEST1'] });

      // Check that separator is NOT displayed
      const output = consoleSpy.mock.calls.map((call) => call[0]).join('\n');
      expect(output).not.toContain('Clone Summary');
      expect(output).not.toContain('Cloning 1/1:');

      consoleSpy.mockRestore();
    });

    test('displays failure details in summary', async () => {
      // Pre-create TEST2 directory to cause failure
      mkdirSync(join(testDir, 'TEST2'));

      const consoleSpy = spyOn(console, 'log');
      const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      await expect(cloneCommand({ spaceKeys: ['TEST1', 'TEST2', 'TEST3'] })).rejects.toThrow('process.exit called');

      const output = consoleSpy.mock.calls.map((call) => call[0]).join('\n');
      expect(output).toContain('Failed to clone:');
      expect(output).toContain('TEST2');
      expect(output).toContain('already exists');

      consoleSpy.mockRestore();
      exitSpy.mockRestore();
    });
  });
});
