import { describe, expect, test } from 'bun:test';
import { http, HttpResponse } from 'msw';
import { Effect } from 'effect';
import { ConfluenceClient } from '../lib/confluence-client/client.js';
import { AuthError, RateLimitError, SpaceNotFoundError } from '../lib/errors.js';
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
