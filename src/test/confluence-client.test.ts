import { describe, expect, test } from 'bun:test';
import { http, HttpResponse } from 'msw';
import { Effect } from 'effect';
import { ConfluenceClient } from '../lib/confluence-client/client.js';
import { AuthError, FolderNotFoundError, RateLimitError, SpaceNotFoundError } from '../lib/errors.js';
import { createValidFolder } from './msw-schema-validation.js';
import { server } from './setup-msw.js';
import { createValidPage, createValidSpace } from './msw-schema-validation.js';

const testConfig = {
  confluenceUrl: 'https://test.atlassian.net',
  email: 'test@example.com',
  apiToken: 'test-token',
};

describe('ConfluenceClient', () => {
  describe('verifyConnection', () => {
    test('succeeds when API returns spaces', async () => {
      const client = new ConfluenceClient(testConfig);
      const result = await client.verifyConnection();
      expect(result).toBe(true);
    });

    test('throws AuthError on 401', async () => {
      server.use(
        http.get('*/wiki/api/v2/spaces', () => {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      expect(async () => {
        await client.verifyConnection();
      }).toThrow();
    });

    test('throws AuthError on 403', async () => {
      server.use(
        http.get('*/wiki/api/v2/spaces', () => {
          return HttpResponse.json({ error: 'Forbidden' }, { status: 403 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      expect(async () => {
        await client.verifyConnection();
      }).toThrow();
    });
  });

  describe('getSpaces', () => {
    test('returns list of spaces', async () => {
      const client = new ConfluenceClient(testConfig);
      const response = await client.getSpaces();

      expect(response.results).toBeArray();
      expect(response.results.length).toBeGreaterThan(0);
      expect(response.results[0]).toHaveProperty('key');
      expect(response.results[0]).toHaveProperty('name');
    });

    test('handles spaces with null description', async () => {
      server.use(
        http.get('*/wiki/api/v2/spaces', () => {
          return HttpResponse.json({
            results: [
              {
                id: 'space-null-desc',
                key: 'NULL',
                name: 'Space with null description',
                description: null,
              },
            ],
          });
        }),
      );

      const client = new ConfluenceClient(testConfig);
      const response = await client.getSpaces();

      expect(response.results).toBeArray();
      expect(response.results[0].key).toBe('NULL');
      expect(response.results[0].description).toBeNull();
    });
  });

  describe('getSpacesEffect', () => {
    test('returns spaces with Effect', async () => {
      const client = new ConfluenceClient(testConfig);
      const result = await Effect.runPromise(Effect.either(client.getSpacesEffect()));

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right.results).toBeArray();
      }
    });
  });

  describe('getSpaceByKey', () => {
    test('returns space for valid key', async () => {
      server.use(
        http.get('*/wiki/api/v2/spaces', ({ request }) => {
          const url = new URL(request.url);
          const keys = url.searchParams.get('keys');
          if (keys === 'DOCS') {
            return HttpResponse.json({
              results: [createValidSpace({ key: 'DOCS', name: 'Documentation' })],
            });
          }
          return HttpResponse.json({ results: [] });
        }),
      );

      const client = new ConfluenceClient(testConfig);
      const space = await client.getSpaceByKey('DOCS');

      expect(space.key).toBe('DOCS');
      expect(space.name).toBe('Documentation');
    });

    test('throws SpaceNotFoundError for invalid key', async () => {
      server.use(
        http.get('*/wiki/api/v2/spaces', () => {
          return HttpResponse.json({ results: [] });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      expect(async () => {
        await client.getSpaceByKey('INVALID');
      }).toThrow();
    });
  });

  describe('getSpaceByKeyEffect', () => {
    test('fails with SpaceNotFoundError for missing space', async () => {
      server.use(
        http.get('*/wiki/api/v2/spaces', () => {
          return HttpResponse.json({ results: [] });
        }),
      );

      const client = new ConfluenceClient(testConfig);
      const result = await Effect.runPromise(Effect.either(client.getSpaceByKeyEffect('MISSING')));

      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        expect(result.left).toBeInstanceOf(SpaceNotFoundError);
      }
    });
  });

  describe('getPagesInSpace', () => {
    test('returns pages in space', async () => {
      const client = new ConfluenceClient(testConfig);
      const response = await client.getPagesInSpace('space-123');

      expect(response.results).toBeArray();
    });
  });

  describe('getPage', () => {
    test('returns page by ID', async () => {
      const client = new ConfluenceClient(testConfig);
      const page = await client.getPage('page-123');

      expect(page.id).toBe('page-123');
      expect(page.title).toBeDefined();
    });
  });

  describe('getAllPagesInSpace', () => {
    test('fetches all pages with pagination', async () => {
      const client = new ConfluenceClient(testConfig);
      const pages = await client.getAllPagesInSpace('space-123');

      expect(pages).toBeArray();
    });
  });

  describe('getLabels', () => {
    test('returns labels for page', async () => {
      const client = new ConfluenceClient(testConfig);
      const response = await client.getLabels('page-123');

      expect(response.results).toBeArray();
    });
  });

  describe('getFolder', () => {
    test('returns folder by ID', async () => {
      const client = new ConfluenceClient(testConfig);
      const folder = await client.getFolder('folder-123');

      expect(folder.id).toBe('folder-123');
      expect(folder.type).toBe('folder');
      expect(folder.title).toBeDefined();
    });
  });

  describe('discoverFolders', () => {
    test('discovers folders referenced by pages', async () => {
      server.use(
        http.get('*/wiki/api/v2/folders/:folderId', ({ params }) => {
          return HttpResponse.json({
            id: params.folderId,
            type: 'folder',
            title: `Folder ${params.folderId}`,
            parentId: 'page-1', // Parent is a known page, not another folder
            parentType: 'page',
          });
        }),
      );

      const client = new ConfluenceClient(testConfig);
      const pages = [
        { id: 'page-1', title: 'Page 1', spaceId: 'space-1', parentId: null },
        { id: 'page-2', title: 'Page 2', spaceId: 'space-1', parentId: 'folder-1' },
        { id: 'page-3', title: 'Page 3', spaceId: 'space-1', parentId: 'page-1' },
      ];

      const folders = await client.discoverFolders(pages);

      expect(folders).toHaveLength(1);
      expect(folders[0].id).toBe('folder-1');
    });

    test('returns empty array when no folders referenced', async () => {
      const client = new ConfluenceClient(testConfig);
      const pages = [
        { id: 'page-1', title: 'Page 1', spaceId: 'space-1', parentId: null },
        { id: 'page-2', title: 'Page 2', spaceId: 'space-1', parentId: 'page-1' },
      ];

      const folders = await client.discoverFolders(pages);

      expect(folders).toHaveLength(0);
    });
  });

  describe('getFolder (404 handling)', () => {
    test('throws FolderNotFoundError on 404', async () => {
      server.use(
        http.get('*/wiki/api/v2/folders/:folderId', () => {
          return HttpResponse.json({ error: 'Not found' }, { status: 404 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      try {
        await client.getFolder('nonexistent-folder');
        expect.unreachable('Should have thrown');
      } catch (error) {
        // Effect wraps errors - check the message
        expect(String(error)).toContain('Folder not found: nonexistent-folder');
      }
    });
  });

  describe('createFolder', () => {
    test('creates a folder successfully', async () => {
      server.use(
        http.post('*/wiki/api/v2/folders', async ({ request }) => {
          const body = (await request.json()) as { spaceId: string; title: string; parentId?: string };
          const folder = createValidFolder({
            id: 'new-folder-123',
            title: body.title,
            parentId: body.parentId || null,
          });
          return HttpResponse.json(folder);
        }),
      );

      const client = new ConfluenceClient(testConfig);
      const folder = await client.createFolder({
        spaceId: 'space-123',
        title: 'New Folder',
      });

      expect(folder.id).toBe('new-folder-123');
      expect(folder.title).toBe('New Folder');
      expect(folder.type).toBe('folder');
    });

    test('creates a folder with parent', async () => {
      server.use(
        http.post('*/wiki/api/v2/folders', async ({ request }) => {
          const body = (await request.json()) as { spaceId: string; title: string; parentId?: string };
          const folder = createValidFolder({
            id: 'child-folder-123',
            title: body.title,
            parentId: body.parentId || null,
          });
          return HttpResponse.json(folder);
        }),
      );

      const client = new ConfluenceClient(testConfig);
      const folder = await client.createFolder({
        spaceId: 'space-123',
        title: 'Child Folder',
        parentId: 'parent-folder-123',
      });

      expect(folder.id).toBe('child-folder-123');
      expect(folder.parentId).toBe('parent-folder-123');
    });

    test('handles 401 authentication error', async () => {
      server.use(
        http.post('*/wiki/api/v2/folders', () => {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      try {
        await client.createFolder({ spaceId: 'space-123', title: 'Test' });
        expect.unreachable('Should have thrown');
      } catch (error) {
        // Effect wraps errors - check the message
        expect(String(error)).toContain('Invalid credentials');
      }
    });
  });

  describe('movePage', () => {
    test('moves a page successfully', async () => {
      server.use(
        http.put('*/wiki/rest/api/content/:pageId/move/:position/:targetId', () => {
          // Response body varies and is not validated - just need 200 OK
          return HttpResponse.json({});
        }),
      );

      const client = new ConfluenceClient(testConfig);
      // movePage returns void - just verify it doesn't throw
      await client.movePage('page-123', 'folder-456', 'append');
    });

    test('handles 404 when page not found', async () => {
      server.use(
        http.put('*/wiki/rest/api/content/:pageId/move/:position/:targetId', () => {
          return HttpResponse.json({ error: 'Not found' }, { status: 404 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      await expect(client.movePage('nonexistent', 'folder-456')).rejects.toThrow();
    });

    test('handles 401 authentication error', async () => {
      server.use(
        http.put('*/wiki/rest/api/content/:pageId/move/:position/:targetId', () => {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      try {
        await client.movePage('page-123', 'folder-456');
        expect.unreachable('Should have thrown');
      } catch (error) {
        // Effect wraps errors - check the message
        expect(String(error)).toContain('Invalid credentials');
      }
    });
  });

  describe('rate limiting', () => {
    test('handles 429 responses', async () => {
      let requestCount = 0;

      server.use(
        http.get('*/wiki/api/v2/spaces', () => {
          requestCount++;
          if (requestCount < 2) {
            return HttpResponse.json(
              { error: 'Rate limited' },
              {
                status: 429,
                headers: { 'Retry-After': '1' },
              },
            );
          }
          return HttpResponse.json({
            results: [createValidSpace()],
          });
        }),
      );

      const client = new ConfluenceClient(testConfig);
      const response = await client.getSpaces();

      expect(response.results).toBeArray();
      expect(requestCount).toBe(2);
    });
  });
});
