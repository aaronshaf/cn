import { HttpResponse, http } from 'msw';
import {
  FolderSchema,
  SpaceSchema,
  SpacesResponseSchema,
  PagesResponseSchema,
  PageSchema,
  UserSchema,
} from '../../lib/confluence-client/types.js';
import { createValidFolder, createValidPage, createValidSpace, validateAndReturn } from '../msw-schema-validation.js';

/**
 * Shared MSW handlers with schema validation
 * These handlers ensure all mock responses conform to our Effect schemas
 *
 * IMPORTANT: These are DEFAULT/FALLBACK handlers that prevent unhandled requests.
 * Individual tests should override these with server.use() for specific test scenarios.
 */
export const handlers = [
  // Confluence spaces mock
  http.get('*/wiki/api/v2/spaces', ({ request }) => {
    const url = new URL(request.url);
    const keys = url.searchParams.get('keys');

    if (keys) {
      // Return specific space
      const space = createValidSpace({ key: keys });
      const response = { results: [space] };
      return HttpResponse.json(validateAndReturn(SpacesResponseSchema, response, 'Spaces by key'));
    }

    // Return default spaces list
    const spaces = [
      createValidSpace({ id: 'space-1', key: 'TEST', name: 'Test Space' }),
      createValidSpace({ id: 'space-2', key: 'DOCS', name: 'Documentation' }),
    ];

    return HttpResponse.json(validateAndReturn(SpacesResponseSchema, { results: spaces }, 'Spaces List'));
  }),

  // Confluence single space mock
  http.get('*/wiki/api/v2/spaces/:spaceId', ({ params }) => {
    const space = createValidSpace({ id: params.spaceId as string });
    return HttpResponse.json(validateAndReturn(SpaceSchema, space, 'Single Space'));
  }),

  // Confluence pages in space mock
  http.get('*/wiki/api/v2/spaces/:spaceId/pages', ({ params }) => {
    const pages = [
      createValidPage({ id: 'page-1', title: 'Home', spaceId: params.spaceId as string }),
      createValidPage({
        id: 'page-2',
        title: 'Getting Started',
        spaceId: params.spaceId as string,
        parentId: 'page-1',
      }),
    ];

    return HttpResponse.json(validateAndReturn(PagesResponseSchema, { results: pages }, 'Pages in Space'));
  }),

  // Confluence single page mock
  http.get('*/wiki/api/v2/pages/:pageId', ({ params }) => {
    const page = createValidPage({
      id: params.pageId as string,
      title: 'Test Page',
      body: '<p>Test content</p>',
    });

    return HttpResponse.json(validateAndReturn(PageSchema, page, 'Single Page'));
  }),

  // Confluence child pages mock
  http.get('*/wiki/api/v2/pages/:pageId/children', () => {
    return HttpResponse.json(validateAndReturn(PagesResponseSchema, { results: [] }, 'Child Pages'));
  }),

  // Confluence labels mock
  http.get('*/wiki/api/v2/pages/:pageId/labels', () => {
    return HttpResponse.json({ results: [] });
  }),

  // Confluence folder mock
  http.get('*/wiki/api/v2/folders/:folderId', ({ params }) => {
    const folder = createValidFolder({
      id: params.folderId as string,
      title: 'Test Folder',
      parentId: 'page-1',
      parentType: 'page',
    });
    return HttpResponse.json(validateAndReturn(FolderSchema, folder, 'Single Folder'));
  }),

  // Confluence create folder mock
  http.post('*/wiki/api/v2/folders', async ({ request }) => {
    const body = (await request.json()) as { spaceId: string; title: string; parentId?: string };
    const folder = createValidFolder({
      id: `folder-${Date.now()}`,
      title: body.title,
      parentId: body.parentId || null,
    });
    return HttpResponse.json(validateAndReturn(FolderSchema, folder, 'Created Folder'));
  }),

  // Confluence move page mock (v1 API)
  // Response body varies and is not validated by the client
  http.put('*/wiki/rest/api/content/:pageId/move/:position/:targetId', () => {
    return HttpResponse.json({});
  }),

  // Confluence user mock (v1 API - v2 doesn't have user endpoint)
  http.get('*/wiki/rest/api/user', ({ request }) => {
    const url = new URL(request.url);
    const accountId = url.searchParams.get('accountId') || 'unknown';
    // Generate unique user data based on accountId for realistic test coverage
    const shortId = accountId.slice(0, 8);
    const user = {
      accountId,
      displayName: `User ${shortId}`,
      email: `user-${shortId}@example.com`,
    };
    return HttpResponse.json(validateAndReturn(UserSchema, user, 'User'));
  }),

  // CATCH-ALL: Return 404 for any unhandled requests
  http.get('*', ({ request }) => {
    console.warn(`[MSW] Unhandled GET request: ${request.url}`);
    return HttpResponse.json(
      { errorMessages: ['Unhandled request - add a handler for this endpoint'] },
      { status: 404 },
    );
  }),

  http.post('*', ({ request }) => {
    console.warn(`[MSW] Unhandled POST request: ${request.url}`);
    return HttpResponse.json(
      { errorMessages: ['Unhandled request - add a handler for this endpoint'] },
      { status: 404 },
    );
  }),

  http.put('*', ({ request }) => {
    console.warn(`[MSW] Unhandled PUT request: ${request.url}`);
    return HttpResponse.json(
      { errorMessages: ['Unhandled request - add a handler for this endpoint'] },
      { status: 404 },
    );
  }),
];
