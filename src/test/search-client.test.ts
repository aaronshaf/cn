/**
 * Tests for SearchClient - Meilisearch integration
 */

import { describe, expect, test } from 'bun:test';
import { http, HttpResponse } from 'msw';
import { SearchClient, type SearchDocument } from '../lib/search/index.js';
import { MeilisearchConnectionError, MeilisearchIndexError } from '../lib/errors.js';
import { server } from './setup-msw.js';

const MEILI_URL = 'http://localhost:7700';

describe('SearchClient', () => {
  describe('isAvailable', () => {
    test('returns true when Meilisearch is healthy', async () => {
      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
      );

      const client = new SearchClient(MEILI_URL);
      const available = await client.isAvailable();
      expect(available).toBe(true);
    });

    test('returns false when Meilisearch is not available', async () => {
      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.error();
        }),
      );

      const client = new SearchClient(MEILI_URL);
      const available = await client.isAvailable();
      expect(available).toBe(false);
    });
  });

  describe('ensureAvailable', () => {
    test('throws MeilisearchConnectionError when not available', async () => {
      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.error();
        }),
      );

      const client = new SearchClient(MEILI_URL);

      try {
        await client.ensureAvailable();
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(MeilisearchConnectionError);
      }
    });
  });

  describe('getIndexStatus', () => {
    test('returns connected status with index info', async () => {
      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.get(`${MEILI_URL}/indexes/cn-test/stats`, () => {
          return HttpResponse.json({ numberOfDocuments: 42 });
        }),
      );

      const client = new SearchClient(MEILI_URL);
      const status = await client.getIndexStatus('cn-test');

      expect(status.connected).toBe(true);
      expect(status.indexName).toBe('cn-test');
      expect(status.documentCount).toBe(42);
    });

    test('returns error when index not found', async () => {
      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.get(`${MEILI_URL}/indexes/cn-missing/stats`, () => {
          return HttpResponse.json({ message: 'Index not found' }, { status: 404 });
        }),
      );

      const client = new SearchClient(MEILI_URL);
      const status = await client.getIndexStatus('cn-missing');

      expect(status.connected).toBe(true);
      expect(status.indexName).toBe('cn-missing');
      expect(status.error).toBe('Index not found');
    });

    test('returns not connected when health check fails', async () => {
      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.error();
        }),
      );

      const client = new SearchClient(MEILI_URL);
      const status = await client.getIndexStatus('cn-test');

      expect(status.connected).toBe(false);
      expect(status.error).toContain('Cannot connect');
    });
  });

  describe('search', () => {
    test('returns search results', async () => {
      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.post(`${MEILI_URL}/indexes/cn-test/search`, () => {
          return HttpResponse.json({
            hits: [
              {
                id: '1',
                title: 'Test Page',
                content: 'This is the test content with authentication info.',
                space_key: 'TEST',
                labels: ['documentation'],
                author_email: 'author@example.com',
                last_modifier_email: 'modifier@example.com',
                created_at: 1705312200,
                updated_at: 1705398600,
                local_path: 'test/page.md',
                url: 'https://example.atlassian.net/wiki/spaces/TEST/pages/1',
                parent_title: 'Parent',
                _formatted: {
                  content: 'This is the test content with **authentication** info.',
                },
              },
            ],
            estimatedTotalHits: 1,
            processingTimeMs: 5,
          });
        }),
      );

      const client = new SearchClient(MEILI_URL);
      const response = await client.search('cn-test', 'authentication');

      expect(response.query).toBe('authentication');
      expect(response.totalHits).toBe(1);
      expect(response.processingTimeMs).toBe(5);
      expect(response.results).toHaveLength(1);
      expect(response.results[0].document.title).toBe('Test Page');
      expect(response.results[0].rank).toBe(1);
      expect(response.results[0].snippet).toContain('authentication');
    });

    test('normalizes whitespace in snippets', async () => {
      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.post(`${MEILI_URL}/indexes/cn-test/search`, () => {
          return HttpResponse.json({
            hits: [
              {
                id: '1',
                title: 'Test Page',
                content: 'Some content',
                space_key: 'TEST',
                labels: [],
                author_email: null,
                last_modifier_email: null,
                created_at: null,
                updated_at: null,
                local_path: 'test/page.md',
                url: null,
                parent_title: null,
                _formatted: {
                  content: 'Multiple\n\n\nlines\t\twith   spaces',
                },
              },
            ],
            estimatedTotalHits: 1,
            processingTimeMs: 1,
          });
        }),
      );

      const client = new SearchClient(MEILI_URL);
      const response = await client.search('cn-test', 'test');

      expect(response.results[0].snippet).toBe('Multiple lines with spaces');
    });

    test('builds filter string for labels', async () => {
      let capturedFilter: string | undefined;

      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.post(`${MEILI_URL}/indexes/cn-test/search`, async ({ request }) => {
          const body = (await request.json()) as { filter?: string };
          capturedFilter = body.filter;
          return HttpResponse.json({
            hits: [],
            estimatedTotalHits: 0,
            processingTimeMs: 1,
          });
        }),
      );

      const client = new SearchClient(MEILI_URL);
      await client.search('cn-test', 'query', { labels: ['doc', 'api'] });

      expect(capturedFilter).toContain('labels = "doc"');
      expect(capturedFilter).toContain('labels = "api"');
      expect(capturedFilter).toContain(' OR ');
    });

    test('escapes filter values to prevent injection', async () => {
      let capturedFilter: string | undefined;

      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.post(`${MEILI_URL}/indexes/cn-test/search`, async ({ request }) => {
          const body = (await request.json()) as { filter?: string };
          capturedFilter = body.filter;
          return HttpResponse.json({
            hits: [],
            estimatedTotalHits: 0,
            processingTimeMs: 1,
          });
        }),
      );

      const client = new SearchClient(MEILI_URL);
      await client.search('cn-test', 'query', { author: 'test"injection' });

      // The quote should be escaped
      expect(capturedFilter).toContain('\\"');
    });

    test('throws MeilisearchIndexError when index not found', async () => {
      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.post(`${MEILI_URL}/indexes/cn-missing/search`, () => {
          return HttpResponse.json({ message: 'Index `cn-missing` not found' }, { status: 404 });
        }),
      );

      const client = new SearchClient(MEILI_URL);

      try {
        await client.search('cn-missing', 'query');
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(MeilisearchIndexError);
      }
    });

    test('builds date filters for absolute dates', async () => {
      let capturedFilter: string | undefined;

      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.post(`${MEILI_URL}/indexes/cn-test/search`, async ({ request }) => {
          const body = (await request.json()) as { filter?: string };
          capturedFilter = body.filter;
          return HttpResponse.json({
            hits: [],
            estimatedTotalHits: 0,
            processingTimeMs: 1,
          });
        }),
      );

      const client = new SearchClient(MEILI_URL);
      await client.search('cn-test', 'query', {
        createdAfter: '2024-01-01',
        updatedBefore: '2024-12-31',
      });

      expect(capturedFilter).toContain('created_at >=');
      expect(capturedFilter).toContain('updated_at <=');
      expect(capturedFilter).toContain(' AND ');
    });

    test('builds date filters for relative dates', async () => {
      let capturedFilter: string | undefined;

      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.post(`${MEILI_URL}/indexes/cn-test/search`, async ({ request }) => {
          const body = (await request.json()) as { filter?: string };
          capturedFilter = body.filter;
          return HttpResponse.json({
            hits: [],
            estimatedTotalHits: 0,
            processingTimeMs: 1,
          });
        }),
      );

      const client = new SearchClient(MEILI_URL);
      await client.search('cn-test', 'query', {
        updatedWithin: '7d',
      });

      expect(capturedFilter).toContain('updated_at >=');
    });

    test('builds stale filter', async () => {
      let capturedFilter: string | undefined;

      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.post(`${MEILI_URL}/indexes/cn-test/search`, async ({ request }) => {
          const body = (await request.json()) as { filter?: string };
          capturedFilter = body.filter;
          return HttpResponse.json({
            hits: [],
            estimatedTotalHits: 0,
            processingTimeMs: 1,
          });
        }),
      );

      const client = new SearchClient(MEILI_URL);
      await client.search('cn-test', 'query', {
        stale: '90d',
      });

      expect(capturedFilter).toContain('updated_at <=');
    });

    test('includes sort parameter', async () => {
      let capturedSort: string[] | undefined;

      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.post(`${MEILI_URL}/indexes/cn-test/search`, async ({ request }) => {
          const body = (await request.json()) as { sort?: string[] };
          capturedSort = body.sort;
          return HttpResponse.json({
            hits: [],
            estimatedTotalHits: 0,
            processingTimeMs: 1,
          });
        }),
      );

      const client = new SearchClient(MEILI_URL);
      await client.search('cn-test', 'query', {
        sort: '-updated_at',
      });

      expect(capturedSort).toEqual(['updated_at:desc']);
    });

    test('includes filters metadata in response', async () => {
      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.post(`${MEILI_URL}/indexes/cn-test/search`, () => {
          return HttpResponse.json({
            hits: [],
            estimatedTotalHits: 0,
            processingTimeMs: 1,
          });
        }),
      );

      const client = new SearchClient(MEILI_URL);
      const response = await client.search('cn-test', 'query', {
        labels: ['api'],
        updatedWithin: '7d',
        sort: '-updated_at',
      });

      expect(response.filters).toBeDefined();
      expect(response.filters?.labels).toEqual(['api']);
      expect(response.filters?.updatedWithin).toBe('7d');
      expect(response.filters?.sort).toBe('-updated_at');
    });

    test('throws on conflicting filters', async () => {
      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
      );

      const client = new SearchClient(MEILI_URL);

      try {
        await client.search('cn-test', 'query', {
          updatedWithin: '7d',
          stale: '90d',
        });
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect((error as Error).message).toContain('Conflicting filters');
      }
    });

    test('throws on invalid sort field', async () => {
      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
      );

      const client = new SearchClient(MEILI_URL);

      try {
        await client.search('cn-test', 'query', {
          sort: 'invalid_field',
        });
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect((error as Error).message).toContain('Invalid sort field');
      }
    });
  });

  describe('indexDocuments', () => {
    test('indexes documents successfully', async () => {
      let taskUid: number | undefined;

      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.get(`${MEILI_URL}/indexes/cn-test/stats`, () => {
          return HttpResponse.json({ numberOfDocuments: 0 });
        }),
        http.patch(`${MEILI_URL}/indexes/cn-test/settings`, () => {
          return HttpResponse.json({ taskUid: 1 });
        }),
        http.get(`${MEILI_URL}/tasks/1`, () => {
          return HttpResponse.json({ status: 'succeeded' });
        }),
        http.post(`${MEILI_URL}/indexes/cn-test/documents`, () => {
          taskUid = 2;
          return HttpResponse.json({ taskUid: 2 });
        }),
        http.get(`${MEILI_URL}/tasks/2`, () => {
          return HttpResponse.json({ status: 'succeeded' });
        }),
      );

      const client = new SearchClient(MEILI_URL);
      const documents: SearchDocument[] = [
        {
          id: '1',
          title: 'Test Doc',
          content: 'Test content',
          space_key: 'TEST',
          labels: [],
          author_email: null,
          last_modifier_email: null,
          created_at: null,
          updated_at: null,
          local_path: 'test.md',
          url: null,
          parent_title: null,
        },
      ];

      await client.indexDocuments('cn-test', documents);
      expect(taskUid).toBe(2);
    });

    test('throws MeilisearchIndexError on failure', async () => {
      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.get(`${MEILI_URL}/indexes/cn-test/stats`, () => {
          return HttpResponse.json({ numberOfDocuments: 0 });
        }),
        http.patch(`${MEILI_URL}/indexes/cn-test/settings`, () => {
          return HttpResponse.json({ taskUid: 1 });
        }),
        http.get(`${MEILI_URL}/tasks/1`, () => {
          return HttpResponse.json({ status: 'succeeded' });
        }),
        http.post(`${MEILI_URL}/indexes/cn-test/documents`, () => {
          return HttpResponse.json({ message: 'Failed to index' }, { status: 500 });
        }),
      );

      const client = new SearchClient(MEILI_URL);
      const documents: SearchDocument[] = [
        {
          id: '1',
          title: 'Test',
          content: 'Test',
          space_key: 'TEST',
          labels: [],
          author_email: null,
          last_modifier_email: null,
          created_at: null,
          updated_at: null,
          local_path: 'test.md',
          url: null,
          parent_title: null,
        },
      ];

      try {
        await client.indexDocuments('cn-test', documents);
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(MeilisearchIndexError);
      }
    });
  });

  describe('clearIndex', () => {
    test('clears all documents from index', async () => {
      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.delete(`${MEILI_URL}/indexes/cn-test/documents`, () => {
          return HttpResponse.json({ taskUid: 1 });
        }),
        http.get(`${MEILI_URL}/tasks/1`, () => {
          return HttpResponse.json({ status: 'succeeded' });
        }),
      );

      const client = new SearchClient(MEILI_URL);
      await client.clearIndex('cn-test');
    });

    test('throws MeilisearchIndexError on failure', async () => {
      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.delete(`${MEILI_URL}/indexes/cn-test/documents`, () => {
          return HttpResponse.json({ message: 'Failed' }, { status: 500 });
        }),
      );

      const client = new SearchClient(MEILI_URL);

      try {
        await client.clearIndex('cn-test');
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(MeilisearchIndexError);
      }
    });
  });

  describe('deleteIndex', () => {
    test('deletes index successfully', async () => {
      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.delete(`${MEILI_URL}/indexes/cn-test`, () => {
          return HttpResponse.json({ taskUid: 1 });
        }),
        http.get(`${MEILI_URL}/tasks/1`, () => {
          return HttpResponse.json({ status: 'succeeded' });
        }),
      );

      const client = new SearchClient(MEILI_URL);
      await client.deleteIndex('cn-test');
    });

    test('ignores errors when index does not exist', async () => {
      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.delete(`${MEILI_URL}/indexes/cn-test`, () => {
          return HttpResponse.json({ message: 'Not found' }, { status: 404 });
        }),
      );

      const client = new SearchClient(MEILI_URL);
      await client.deleteIndex('cn-test');
    });
  });

  describe('getOrCreateIndex', () => {
    test('creates index when it does not exist', async () => {
      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.get(`${MEILI_URL}/indexes/cn-new/stats`, () => {
          return HttpResponse.json({ message: 'Index not found' }, { status: 404 });
        }),
        http.post(`${MEILI_URL}/indexes`, () => {
          return HttpResponse.json({ taskUid: 1 });
        }),
        http.get(`${MEILI_URL}/tasks/1`, () => {
          return HttpResponse.json({ status: 'succeeded' });
        }),
        http.patch(`${MEILI_URL}/indexes/cn-new/settings`, () => {
          return HttpResponse.json({ taskUid: 2 });
        }),
        http.get(`${MEILI_URL}/tasks/2`, () => {
          return HttpResponse.json({ status: 'succeeded' });
        }),
      );

      const client = new SearchClient(MEILI_URL);
      const index = await client.getOrCreateIndex('cn-new');
      expect(index).toBeDefined();
    });

    test('returns existing index when it exists', async () => {
      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.get(`${MEILI_URL}/indexes/cn-test/stats`, () => {
          return HttpResponse.json({ numberOfDocuments: 10 });
        }),
      );

      const client = new SearchClient(MEILI_URL);
      const index = await client.getOrCreateIndex('cn-test');
      expect(index).toBeDefined();
    });

    test('updates settings when updateSettings is true', async () => {
      let settingsUpdated = false;

      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.get(`${MEILI_URL}/indexes/cn-test/stats`, () => {
          return HttpResponse.json({ numberOfDocuments: 10 });
        }),
        http.patch(`${MEILI_URL}/indexes/cn-test/settings`, () => {
          settingsUpdated = true;
          return HttpResponse.json({ taskUid: 1 });
        }),
        http.get(`${MEILI_URL}/tasks/1`, () => {
          return HttpResponse.json({ status: 'succeeded' });
        }),
      );

      const client = new SearchClient(MEILI_URL);
      await client.getOrCreateIndex('cn-test', true);
      expect(settingsUpdated).toBe(true);
    });

    test('throws MeilisearchIndexError on failure', async () => {
      server.use(
        http.get(`${MEILI_URL}/health`, () => {
          return HttpResponse.json({ status: 'available' });
        }),
        http.get(`${MEILI_URL}/indexes/cn-test/stats`, () => {
          return HttpResponse.json({ message: 'Server error' }, { status: 500 });
        }),
        http.post(`${MEILI_URL}/indexes`, () => {
          return HttpResponse.json({ message: 'Failed' }, { status: 500 });
        }),
      );

      const client = new SearchClient(MEILI_URL);

      try {
        await client.getOrCreateIndex('cn-test');
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(MeilisearchIndexError);
      }
    });
  });
});
