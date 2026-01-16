import { describe, expect, test } from 'bun:test';
import { HttpResponse, http } from 'msw';
import { ConfluenceClient } from '../lib/confluence-client/client.js';
import { ApiError, PageNotFoundError, VersionConflictError } from '../lib/errors.js';
import { server } from './setup-msw.js';
import { createValidPage } from './msw-schema-validation.js';

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
});
