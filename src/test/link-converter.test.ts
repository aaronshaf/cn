import { describe, expect, test } from 'bun:test';
import {
  buildPageLookupMap,
  confluenceLinkToRelativePath,
  extractPageTitleFromLink,
  relativePathToConfluenceLink,
  type PageLookupMap,
} from '../lib/markdown/link-converter.js';
import type { SpaceConfigWithState } from '../lib/space-config.js';

describe('buildPageLookupMap', () => {
  test('builds lookup maps from sync state', () => {
    const syncState: SpaceConfigWithState = {
      spaceKey: 'TEST',
      spaceId: 'space-123',
      spaceName: 'Test Space',
      pages: {
        'page-1': {
          pageId: 'page-1',
          version: 1,
          localPath: 'getting-started.md',
          title: 'Getting Started',
        },
        'page-2': {
          pageId: 'page-2',
          version: 1,
          localPath: 'architecture/overview.md',
          title: 'Architecture Overview',
        },
      },
    };

    const lookupMap = buildPageLookupMap(syncState);

    expect(lookupMap.idToPage.get('page-1')?.localPath).toBe('getting-started.md');
    expect(lookupMap.idToPage.get('page-2')?.localPath).toBe('architecture/overview.md');
    expect(lookupMap.titleToPage.get('Getting Started')?.pageId).toBe('page-1');
    expect(lookupMap.titleToPage.get('Architecture Overview')?.pageId).toBe('page-2');
    expect(lookupMap.pathToPage.get('getting-started.md')?.pageId).toBe('page-1');
    expect(lookupMap.pathToPage.get('architecture/overview.md')?.pageId).toBe('page-2');
  });

  test('handles duplicate titles (deterministic ordering)', () => {
    const syncState: SpaceConfigWithState = {
      spaceKey: 'TEST',
      spaceId: 'space-123',
      spaceName: 'Test Space',
      pages: {
        'page-2': {
          pageId: 'page-2',
          version: 1,
          localPath: 'architecture/overview.md',
          title: 'Overview',
        },
        'page-1': {
          pageId: 'page-1',
          version: 1,
          localPath: 'overview.md',
          title: 'Overview',
        },
      },
    };

    const lookupMap = buildPageLookupMap(syncState);

    // Page with lexicographically smallest pageId should win (page-1 < page-2)
    expect(lookupMap.titleToPage.get('Overview')?.pageId).toBe('page-1');
  });

  test('warns about duplicate titles when enabled', () => {
    const syncState: SpaceConfigWithState = {
      spaceKey: 'TEST',
      spaceId: 'space-123',
      spaceName: 'Test Space',
      pages: {
        'page-2': {
          pageId: 'page-2',
          version: 1,
          localPath: 'architecture/overview.md',
          title: 'Overview',
        },
        'page-1': {
          pageId: 'page-1',
          version: 1,
          localPath: 'overview.md',
          title: 'Overview',
        },
      },
    };

    // Capture console.warn calls
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => warnings.push(msg);

    try {
      buildPageLookupMap(syncState, true);

      // Should have warned about duplicate
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('Duplicate page title "Overview"');
      expect(warnings[0]).toContain('overview.md');
      expect(warnings[0]).toContain('architecture/overview.md');
      // Verify it indicates page-1 will be used (lexicographically smallest)
      expect(warnings[0]).toContain('overview.md');
    } finally {
      console.warn = originalWarn;
    }
  });

  test('handles empty sync state', () => {
    const syncState: SpaceConfigWithState = {
      spaceKey: 'TEST',
      spaceId: 'space-123',
      spaceName: 'Test Space',
      pages: {},
    };

    const lookupMap = buildPageLookupMap(syncState);

    expect(lookupMap.idToPage.size).toBe(0);
    expect(lookupMap.titleToPage.size).toBe(0);
    expect(lookupMap.pathToPage.size).toBe(0);
  });
});

describe('confluenceLinkToRelativePath', () => {
  let lookupMap: PageLookupMap;

  const syncState: SpaceConfigWithState = {
    spaceKey: 'TEST',
    spaceId: 'space-123',
    spaceName: 'Test Space',
    pages: {
      'page-1': {
        pageId: 'page-1',
        version: 1,
        localPath: 'getting-started.md',
        title: 'Getting Started',
      },
      'page-2': {
        pageId: 'page-2',
        version: 1,
        localPath: 'architecture/overview.md',
        title: 'Architecture Overview',
      },
      'page-3': {
        pageId: 'page-3',
        version: 1,
        localPath: 'architecture/database.md',
        title: 'Database Design',
      },
    },
  };

  test('converts Confluence link to relative path (same directory)', () => {
    lookupMap = buildPageLookupMap(syncState);
    const result = confluenceLinkToRelativePath('Architecture Overview', 'architecture/database.md', lookupMap);

    expect(result).toBe('./overview.md');
  });

  test('converts Confluence link to relative path (parent directory)', () => {
    lookupMap = buildPageLookupMap(syncState);
    const result = confluenceLinkToRelativePath('Getting Started', 'architecture/database.md', lookupMap);

    expect(result).toBe('../getting-started.md');
  });

  test('converts Confluence link to relative path (child directory)', () => {
    lookupMap = buildPageLookupMap(syncState);
    const result = confluenceLinkToRelativePath('Architecture Overview', 'getting-started.md', lookupMap);

    expect(result).toBe('./architecture/overview.md');
  });

  test('returns null for non-existent page', () => {
    lookupMap = buildPageLookupMap(syncState);
    const result = confluenceLinkToRelativePath('Non Existent Page', 'getting-started.md', lookupMap);

    expect(result).toBeNull();
  });

  test('handles paths that need ./ prefix', () => {
    lookupMap = buildPageLookupMap(syncState);
    const result = confluenceLinkToRelativePath('Database Design', 'architecture/overview.md', lookupMap);

    expect(result).toBe('./database.md');
  });
});

describe('extractPageTitleFromLink', () => {
  test('extracts title from ri:page element', () => {
    const html = '<ri:page ri:content-title="Getting Started" />';
    const title = extractPageTitleFromLink(html);

    expect(title).toBe('Getting Started');
  });

  test('extracts title from ac:link element', () => {
    const html = '<ac:link><ri:page ri:content-title="Architecture Overview" /></ac:link>';
    const title = extractPageTitleFromLink(html);

    expect(title).toBe('Architecture Overview');
  });

  test('handles double quotes', () => {
    const html = '<ri:page ri:content-title="Test Page" />';
    const title = extractPageTitleFromLink(html);

    expect(title).toBe('Test Page');
  });

  test('handles single quotes', () => {
    const html = "<ri:page ri:content-title='Test Page' />";
    const title = extractPageTitleFromLink(html);

    expect(title).toBe('Test Page');
  });

  test('returns null if no title found', () => {
    const html = '<ac:link></ac:link>';
    const title = extractPageTitleFromLink(html);

    expect(title).toBeNull();
  });

  test('decodes HTML entities in titles', () => {
    const html = '<ri:page ri:content-title="Page with &amp; ampersand" />';
    const title = extractPageTitleFromLink(html);

    // HTML entities should be decoded
    expect(title).toBe('Page with & ampersand');
  });

  test('decodes angle brackets in titles', () => {
    const html = '<ri:page ri:content-title="Page &lt;with&gt; brackets" />';
    const title = extractPageTitleFromLink(html);

    expect(title).toBe('Page <with> brackets');
  });

  test('decodes quotes in titles', () => {
    const html = '<ri:page ri:content-title="Page with &quot;quotes&quot;" />';
    const title = extractPageTitleFromLink(html);

    expect(title).toBe('Page with "quotes"');
  });
});

describe('relativePathToConfluenceLink', () => {
  let lookupMap: PageLookupMap;

  const syncState: SpaceConfigWithState = {
    spaceKey: 'TEST',
    spaceId: 'space-123',
    spaceName: 'Test Space',
    pages: {
      'page-1': {
        pageId: 'page-1',
        version: 1,
        localPath: 'getting-started.md',
        title: 'Getting Started',
      },
      'page-2': {
        pageId: 'page-2',
        version: 1,
        localPath: 'architecture/overview.md',
        title: 'Architecture Overview',
      },
      'page-3': {
        pageId: 'page-3',
        version: 1,
        localPath: 'architecture/database.md',
        title: 'Database Design',
      },
    },
  };

  test('converts relative path to Confluence link (same directory)', () => {
    lookupMap = buildPageLookupMap(syncState);
    const result = relativePathToConfluenceLink('./overview.md', 'architecture/database.md', '/test/space', lookupMap);

    expect(result).not.toBeNull();
    expect(result?.title).toBe('Architecture Overview');
    expect(result?.pageId).toBe('page-2');
  });

  test('converts relative path to Confluence link (parent directory)', () => {
    lookupMap = buildPageLookupMap(syncState);
    const result = relativePathToConfluenceLink(
      '../getting-started.md',
      'architecture/database.md',
      '/test/space',
      lookupMap,
    );

    expect(result).not.toBeNull();
    expect(result?.title).toBe('Getting Started');
    expect(result?.pageId).toBe('page-1');
  });

  test('converts relative path to Confluence link (child directory)', () => {
    lookupMap = buildPageLookupMap(syncState);
    const result = relativePathToConfluenceLink(
      './architecture/overview.md',
      'getting-started.md',
      '/test/space',
      lookupMap,
    );

    expect(result).not.toBeNull();
    expect(result?.title).toBe('Architecture Overview');
    expect(result?.pageId).toBe('page-2');
  });

  test('returns null for non-existent file', () => {
    lookupMap = buildPageLookupMap(syncState);
    const result = relativePathToConfluenceLink('./non-existent.md', 'getting-started.md', '/test/space', lookupMap);

    expect(result).toBeNull();
  });

  test('handles paths without ./ prefix', () => {
    lookupMap = buildPageLookupMap(syncState);
    const result = relativePathToConfluenceLink('database.md', 'architecture/overview.md', '/test/space', lookupMap);

    expect(result).not.toBeNull();
    expect(result?.title).toBe('Database Design');
    expect(result?.pageId).toBe('page-3');
  });

  test('handles deeply nested paths', () => {
    const deepSyncState: SpaceConfigWithState = {
      spaceKey: 'TEST',
      spaceId: 'space-123',
      spaceName: 'Test Space',
      pages: {
        'page-deep': {
          pageId: 'page-deep',
          version: 1,
          localPath: 'a/b/c/d/e/f/g/h/page.md',
          title: 'Deep Page',
        },
      },
    };

    lookupMap = buildPageLookupMap(deepSyncState);
    const result = relativePathToConfluenceLink('./a/b/c/d/e/f/g/h/page.md', 'home.md', '/test/space', lookupMap);

    expect(result).not.toBeNull();
    expect(result?.title).toBe('Deep Page');
    expect(result?.pageId).toBe('page-deep');
  });
});
