import { describe, expect, test } from 'bun:test';
import { HttpResponse, http } from 'msw';
import { ConfluenceClient } from '../lib/confluence-client/client.js';
import { ApiError, FolderNotFoundError, PageNotFoundError, VersionConflictError } from '../lib/errors.js';
import { server } from './setup-msw.js';
import { createValidFolder, createValidPage } from './msw-schema-validation.js';

const testConfig = {
  confluenceUrl: 'https://test.atlassian.net',
  email: 'test@example.com',
  apiToken: 'test-token',
};

describe('ConfluenceClient - Push Operations', () => {
  describe('createPage', () => {
    test('creates a new page successfully', async () => {
      const newPage = createValidPage({
        id: 'new-page-123',
        title: 'New Test Page',
        spaceId: 'space-1',
        version: 1,
      });

      server.use(
        http.post('*/wiki/api/v2/pages', async ({ request }) => {
          const body = await request.json();
          expect(body).toHaveProperty('title');
          expect(body).toHaveProperty('spaceId');
          expect(body).toHaveProperty('body');
          return HttpResponse.json(newPage);
        }),
      );

      const client = new ConfluenceClient(testConfig);
      const result = await client.createPage({
        spaceId: 'space-1',
        status: 'current',
        title: 'New Test Page',
        body: {
          representation: 'storage',
          value: '<p>Test content</p>',
        },
      });

      expect(result.id).toBe('new-page-123');
      expect(result.title).toBe('New Test Page');
      expect(result.version?.number).toBe(1);
    });

    test('creates a page with parent ID', async () => {
      const newPage = createValidPage({
        id: 'child-page-456',
        title: 'Child Page',
        spaceId: 'space-1',
        parentId: 'parent-123',
        version: 1,
      });

      server.use(
        http.post('*/wiki/api/v2/pages', async ({ request }) => {
          const body = await request.json();
          expect(body).toHaveProperty('parentId', 'parent-123');
          return HttpResponse.json(newPage);
        }),
      );

      const client = new ConfluenceClient(testConfig);
      const result = await client.createPage({
        spaceId: 'space-1',
        status: 'current',
        title: 'Child Page',
        parentId: 'parent-123',
        body: {
          representation: 'storage',
          value: '<p>Child content</p>',
        },
      });

      expect(result.parentId).toBe('parent-123');
    });

    test('handles 401 authentication error', async () => {
      server.use(
        http.post('*/wiki/api/v2/pages', () => {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      expect(async () => {
        await client.createPage({
          spaceId: 'space-1',
          status: 'current',
          title: 'Test',
          body: { representation: 'storage', value: '<p>Test</p>' },
        });
      }).toThrow();
    });

    test('handles 403 permission error', async () => {
      server.use(
        http.post('*/wiki/api/v2/pages', () => {
          return HttpResponse.json({ error: 'Forbidden' }, { status: 403 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      expect(async () => {
        await client.createPage({
          spaceId: 'space-1',
          status: 'current',
          title: 'Test',
          body: { representation: 'storage', value: '<p>Test</p>' },
        });
      }).toThrow();
    });
  });

  describe('updatePage', () => {
    test('updates an existing page successfully', async () => {
      const updatedPage = createValidPage({
        id: 'page-123',
        title: 'Updated Title',
        version: 3,
      });

      server.use(
        http.put('*/wiki/api/v2/pages/page-123', async ({ request }) => {
          const body = (await request.json()) as any;
          expect(body).toHaveProperty('title', 'Updated Title');
          expect(body).toHaveProperty('version');
          expect(body.version.number).toBe(3);
          return HttpResponse.json(updatedPage);
        }),
      );

      const client = new ConfluenceClient(testConfig);
      const result = await client.updatePage({
        id: 'page-123',
        status: 'current',
        title: 'Updated Title',
        body: {
          representation: 'storage',
          value: '<p>Updated content</p>',
        },
        version: { number: 3 },
      });

      expect(result.title).toBe('Updated Title');
      expect(result.version?.number).toBe(3);
    });

    test('throws PageNotFoundError on 404', async () => {
      server.use(
        http.put('*/wiki/api/v2/pages/missing-page', () => {
          return HttpResponse.json({ error: 'Not Found' }, { status: 404 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      try {
        await client.updatePage({
          id: 'missing-page',
          status: 'current',
          title: 'Test',
          body: { representation: 'storage', value: '<p>Test</p>' },
          version: { number: 2 },
        });
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        // Effect wraps errors, so we need to check the cause
        expect(error.message).toContain('Page not found');
        expect(error.message).toContain('missing-page');
      }
    });

    test('throws VersionConflictError on 409', async () => {
      server.use(
        http.put('*/wiki/api/v2/pages/page-123', () => {
          return HttpResponse.json({ version: { number: 5 } }, { status: 409 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      try {
        await client.updatePage({
          id: 'page-123',
          status: 'current',
          title: 'Test',
          body: { representation: 'storage', value: '<p>Test</p>' },
          version: { number: 3 },
        });
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        // Effect wraps errors, check the message
        expect(error.message).toContain('Version conflict');
        expect(error.message).toContain('3');
        expect(error.message).toContain('5');
      }
    });

    test('handles version conflict with missing remote version', async () => {
      server.use(
        http.put('*/wiki/api/v2/pages/page-123', () => {
          return HttpResponse.json({}, { status: 409 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      try {
        await client.updatePage({
          id: 'page-123',
          status: 'current',
          title: 'Test',
          body: { representation: 'storage', value: '<p>Test</p>' },
          version: { number: 3 },
        });
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        // Effect wraps errors, check the message
        expect(error.message).toContain('Version conflict');
        expect(error.message).toContain('3');
        expect(error.message).toContain('0');
      }
    });

    test('handles 401 authentication error', async () => {
      server.use(
        http.put('*/wiki/api/v2/pages/page-123', () => {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      expect(async () => {
        await client.updatePage({
          id: 'page-123',
          status: 'current',
          title: 'Test',
          body: { representation: 'storage', value: '<p>Test</p>' },
          version: { number: 2 },
        });
      }).toThrow();
    });

    test('handles 403 permission error', async () => {
      server.use(
        http.put('*/wiki/api/v2/pages/page-123', () => {
          return HttpResponse.json({ error: 'Forbidden' }, { status: 403 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      expect(async () => {
        await client.updatePage({
          id: 'page-123',
          status: 'current',
          title: 'Test',
          body: { representation: 'storage', value: '<p>Test</p>' },
          version: { number: 2 },
        });
      }).toThrow();
    });
  });

  describe('Parent validation', () => {
    test('validates parent exists before creating page', async () => {
      // First call: check parent exists
      server.use(
        http.get('*/wiki/api/v2/pages/parent-123', () => {
          return HttpResponse.json(createValidPage({ id: 'parent-123', title: 'Parent Page' }));
        }),
      );

      const client = new ConfluenceClient(testConfig);
      const parent = await client.getPage('parent-123', false);
      expect(parent.id).toBe('parent-123');
    });

    test('throws ApiError when parent does not exist', async () => {
      server.use(
        http.get('*/wiki/api/v2/pages/missing-parent', () => {
          return HttpResponse.json({ error: 'Not Found' }, { status: 404 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      try {
        await client.getPage('missing-parent', false);
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        // getPage throws ApiError for 404, not PageNotFoundError
        expect(error.message).toContain('404');
      }
    });
  });

  describe('Content Properties', () => {
    test('sets content property on a page', async () => {
      server.use(
        http.post('*/wiki/api/v2/pages/page-123/properties', async ({ request }) => {
          const body = (await request.json()) as any;
          expect(body).toHaveProperty('key', 'editor');
          expect(body).toHaveProperty('value', 'v2');
          return HttpResponse.json({ key: 'editor', value: 'v2' }, { status: 200 });
        }),
      );

      const client = new ConfluenceClient(testConfig);
      await client.setContentProperty('page-123', 'editor', 'v2');
      // No error means success
    });

    test('setEditorV2 sets editor property to v2', async () => {
      server.use(
        http.post('*/wiki/api/v2/pages/page-456/properties', async ({ request }) => {
          const body = (await request.json()) as any;
          expect(body).toHaveProperty('key', 'editor');
          expect(body).toHaveProperty('value', 'v2');
          return HttpResponse.json({ key: 'editor', value: 'v2' }, { status: 200 });
        }),
      );

      const client = new ConfluenceClient(testConfig);
      await client.setEditorV2('page-456');
      // No error means success
    });

    test('handles 401 authentication error for content property', async () => {
      server.use(
        http.post('*/wiki/api/v2/pages/page-123/properties', () => {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      expect(async () => {
        await client.setContentProperty('page-123', 'editor', 'v2');
      }).toThrow();
    });

    test('handles 403 permission error for content property', async () => {
      server.use(
        http.post('*/wiki/api/v2/pages/page-123/properties', () => {
          return HttpResponse.json({ error: 'Forbidden' }, { status: 403 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      expect(async () => {
        await client.setContentProperty('page-123', 'editor', 'v2');
      }).toThrow();
    });
  });

  describe('movePage', () => {
    test('moves a page to a folder successfully', async () => {
      server.use(
        http.put('*/wiki/rest/api/content/page-123/move/append/folder-456', () => {
          // Response body varies and is not validated - just need 200 OK
          return HttpResponse.json({});
        }),
      );

      const client = new ConfluenceClient(testConfig);
      // movePage returns void - just verify it doesn't throw
      await client.movePage('page-123', 'folder-456', 'append');
    });

    test('throws on 404 when page not found', async () => {
      server.use(
        http.put('*/wiki/rest/api/content/missing-page/move/append/folder-456', () => {
          return HttpResponse.json({ error: 'Not found' }, { status: 404 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      await expect(client.movePage('missing-page', 'folder-456')).rejects.toThrow();
    });

    test('throws on 404 when target folder not found', async () => {
      server.use(
        http.put('*/wiki/rest/api/content/page-123/move/append/missing-folder', () => {
          return HttpResponse.json({ error: 'Not found' }, { status: 404 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      await expect(client.movePage('page-123', 'missing-folder')).rejects.toThrow();
    });

    test('throws on 403 permission denied', async () => {
      server.use(
        http.put('*/wiki/rest/api/content/page-123/move/append/folder-456', () => {
          return HttpResponse.json({ error: 'Forbidden' }, { status: 403 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      try {
        await client.movePage('page-123', 'folder-456');
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(String(error)).toContain('Access denied');
      }
    });

    test('handles 401 authentication error', async () => {
      server.use(
        http.put('*/wiki/rest/api/content/page-123/move/append/folder-456', () => {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      try {
        await client.movePage('page-123', 'folder-456');
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(String(error)).toContain('Invalid credentials');
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

    test('creates a nested folder with parent', async () => {
      server.use(
        http.post('*/wiki/api/v2/folders', async ({ request }) => {
          const body = (await request.json()) as { spaceId: string; title: string; parentId?: string };
          const folder = createValidFolder({
            id: 'child-folder-456',
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

      expect(folder.id).toBe('child-folder-456');
      expect(folder.parentId).toBe('parent-folder-123');
    });

    test('handles 400 duplicate folder error', async () => {
      server.use(
        http.post('*/wiki/api/v2/folders', () => {
          return HttpResponse.json({ message: 'A folder with this name already exists' }, { status: 400 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      await expect(client.createFolder({ spaceId: 'space-123', title: 'Existing Folder' })).rejects.toThrow();
    });

    test('handles 409 conflict error', async () => {
      server.use(
        http.post('*/wiki/api/v2/folders', () => {
          return HttpResponse.json({ message: 'Folder already exists' }, { status: 409 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      await expect(client.createFolder({ spaceId: 'space-123', title: 'Existing Folder' })).rejects.toThrow();
    });
  });

  describe('getFolder with retry', () => {
    test('retries on 429 rate limit', async () => {
      let requestCount = 0;

      server.use(
        http.get('*/wiki/api/v2/folders/folder-123', () => {
          requestCount++;
          if (requestCount < 2) {
            return HttpResponse.json({ error: 'Rate limited' }, { status: 429, headers: { 'Retry-After': '1' } });
          }
          return HttpResponse.json(createValidFolder({ id: 'folder-123', title: 'Test Folder' }));
        }),
      );

      const client = new ConfluenceClient(testConfig);
      const folder = await client.getFolder('folder-123');

      expect(folder.id).toBe('folder-123');
      expect(requestCount).toBe(2);
    });

    test('throws FolderNotFoundError on 404', async () => {
      server.use(
        http.get('*/wiki/api/v2/folders/nonexistent', () => {
          return HttpResponse.json({ error: 'Not found' }, { status: 404 });
        }),
      );

      const client = new ConfluenceClient(testConfig);

      try {
        await client.getFolder('nonexistent');
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(String(error)).toContain('Folder not found: nonexistent');
      }
    });
  });
});
