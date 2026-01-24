import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveLinksSecondPass } from '../lib/sync/link-resolution-pass.js';
import type { SpaceConfigWithState } from '../lib/space-config.js';

describe('Link Resolution Second Pass', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `cn-link-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  test('resolves unresolved links in second pass', () => {
    // Create markdown files with unresolved links
    const pageAPath = join(testDir, 'page-a.md');
    const pageBPath = join(testDir, 'page-b.md');

    // Page A has an unresolved link to Page B (as Confluence HTML)
    const pageAContent = `---
page_id: page-a-id
title: Page A
version: 1
---

# Page A

This is a link to <ac:link><ri:page ri:content-title="Page B" ri:space-key="TEST"/><ac:plain-text-link-body><![CDATA[Page B]]></ac:plain-text-link-body></ac:link>.
`;

    // Page B exists
    const pageBContent = `---
page_id: page-b-id
title: Page B
version: 1
---

# Page B

Content of page B.
`;

    writeFileSync(pageAPath, pageAContent, 'utf-8');
    writeFileSync(pageBPath, pageBContent, 'utf-8');

    const config: SpaceConfigWithState = {
      spaceKey: 'TEST',
      spaceId: 'test-space-id',
      spaceName: 'Test Space',
      pages: {
        'page-a-id': 'page-a.md',
        'page-b-id': 'page-b.md',
      },
      folders: {},
      lastSync: new Date().toISOString(),
    };

    // Run second pass
    const result = resolveLinksSecondPass(testDir, config);

    // Check results
    expect(result.filesUpdated).toBe(1); // Only page-a.md should be updated
    expect(result.linksResolved).toBe(1);
    expect(result.warnings).toHaveLength(0);

    // Verify the link was converted
    const updatedPageA = readFileSync(pageAPath, 'utf-8');
    expect(updatedPageA).toContain('[Page B](./page-b.md)');
    expect(updatedPageA).not.toContain('<ac:link>');
  });

  test('handles multiple unresolved links in one file', () => {
    const pageAPath = join(testDir, 'page-a.md');
    const pageBPath = join(testDir, 'page-b.md');
    const pageCPath = join(testDir, 'page-c.md');

    const pageAContent = `---
page_id: page-a-id
title: Page A
version: 1
---

# Page A

Link to <ac:link><ri:page ri:content-title="Page B"/><ac:plain-text-link-body><![CDATA[Page B]]></ac:plain-text-link-body></ac:link>.
Link to <ac:link><ri:page ri:content-title="Page C"/><ac:plain-text-link-body><![CDATA[Page C]]></ac:plain-text-link-body></ac:link>.
`;

    const pageBContent = `---
page_id: page-b-id
title: Page B
version: 1
---

# Page B
`;

    const pageCContent = `---
page_id: page-c-id
title: Page C
version: 1
---

# Page C
`;

    writeFileSync(pageAPath, pageAContent, 'utf-8');
    writeFileSync(pageBPath, pageBContent, 'utf-8');
    writeFileSync(pageCPath, pageCContent, 'utf-8');

    const config: SpaceConfigWithState = {
      spaceKey: 'TEST',
      spaceId: 'test-space-id',
      spaceName: 'Test Space',
      pages: {
        'page-a-id': 'page-a.md',
        'page-b-id': 'page-b.md',
        'page-c-id': 'page-c.md',
      },
      folders: {},
      lastSync: new Date().toISOString(),
    };

    const result = resolveLinksSecondPass(testDir, config);

    expect(result.filesUpdated).toBe(1);
    expect(result.linksResolved).toBe(2);

    const updatedPageA = readFileSync(pageAPath, 'utf-8');
    expect(updatedPageA).toContain('[Page B](./page-b.md)');
    expect(updatedPageA).toContain('[Page C](./page-c.md)');
  });

  test('skips files with no unresolved links', () => {
    const pageAPath = join(testDir, 'page-a.md');

    const pageAContent = `---
page_id: page-a-id
title: Page A
version: 1
---

# Page A

Normal content with no links.
`;

    writeFileSync(pageAPath, pageAContent, 'utf-8');

    const config: SpaceConfigWithState = {
      spaceKey: 'TEST',
      spaceId: 'test-space-id',
      spaceName: 'Test Space',
      pages: {
        'page-a-id': 'page-a.md',
      },
      folders: {},
      lastSync: new Date().toISOString(),
    };

    const result = resolveLinksSecondPass(testDir, config);

    expect(result.filesUpdated).toBe(0);
    expect(result.linksResolved).toBe(0);
  });

  test('leaves unresolvable links as-is', () => {
    const pageAPath = join(testDir, 'page-a.md');

    // Link to a page that doesn't exist
    const pageAContent = `---
page_id: page-a-id
title: Page A
version: 1
---

# Page A

Link to <ac:link><ri:page ri:content-title="Nonexistent Page"/><ac:plain-text-link-body><![CDATA[Missing]]></ac:plain-text-link-body></ac:link>.
`;

    writeFileSync(pageAPath, pageAContent, 'utf-8');

    const config: SpaceConfigWithState = {
      spaceKey: 'TEST',
      spaceId: 'test-space-id',
      spaceName: 'Test Space',
      pages: {
        'page-a-id': 'page-a.md',
      },
      folders: {},
      lastSync: new Date().toISOString(),
    };

    const result = resolveLinksSecondPass(testDir, config);

    // No changes should be made
    expect(result.filesUpdated).toBe(0);
    expect(result.linksResolved).toBe(0);

    // Link should still be unresolved
    const updatedPageA = readFileSync(pageAPath, 'utf-8');
    expect(updatedPageA).toContain('<ac:link>');
    expect(updatedPageA).toContain('Nonexistent Page');
  });

  test('resolves links in nested directories', () => {
    const subDir = join(testDir, 'subdir');
    mkdirSync(subDir, { recursive: true });

    const pageAPath = join(subDir, 'page-a.md');
    const pageBPath = join(testDir, 'page-b.md');

    const pageAContent = `---
page_id: page-a-id
title: Page A
version: 1
---

# Page A

Link to <ac:link><ri:page ri:content-title="Page B"/><ac:plain-text-link-body><![CDATA[Page B]]></ac:plain-text-link-body></ac:link>.
`;

    const pageBContent = `---
page_id: page-b-id
title: Page B
version: 1
---

# Page B
`;

    writeFileSync(pageAPath, pageAContent, 'utf-8');
    writeFileSync(pageBPath, pageBContent, 'utf-8');

    const config: SpaceConfigWithState = {
      spaceKey: 'TEST',
      spaceId: 'test-space-id',
      spaceName: 'Test Space',
      pages: {
        'page-a-id': 'subdir/page-a.md',
        'page-b-id': 'page-b.md',
      },
      folders: {},
      lastSync: new Date().toISOString(),
    };

    const result = resolveLinksSecondPass(testDir, config);

    expect(result.filesUpdated).toBe(1);
    expect(result.linksResolved).toBe(1);

    const updatedPageA = readFileSync(pageAPath, 'utf-8');
    // Link should be relative from subdir/ to root
    expect(updatedPageA).toContain('[Page B](../page-b.md)');
  });

  test('decodes HTML entities in page titles', () => {
    const pageAPath = join(testDir, 'page-a.md');
    const pageBPath = join(testDir, 'page-b.md');

    // Page A has a link with HTML entities in the title
    const pageAContent = `---
page_id: page-a-id
title: Page A
version: 1
---

# Page A

Link to <ac:link><ri:page ri:content-title="Page &amp; Info"/><ac:plain-text-link-body><![CDATA[API &amp; Docs]]></ac:plain-text-link-body></ac:link>.
`;

    // Page B has a title with ampersand
    const pageBContent = `---
page_id: page-b-id
title: Page & Info
version: 1
---

# Page & Info
`;

    writeFileSync(pageAPath, pageAContent, 'utf-8');
    writeFileSync(pageBPath, pageBContent, 'utf-8');

    const config: SpaceConfigWithState = {
      spaceKey: 'TEST',
      spaceId: 'test-space-id',
      spaceName: 'Test Space',
      pages: {
        'page-a-id': 'page-a.md',
        'page-b-id': 'page-b.md',
      },
      folders: {},
      lastSync: new Date().toISOString(),
    };

    const result = resolveLinksSecondPass(testDir, config);

    expect(result.filesUpdated).toBe(1);
    expect(result.linksResolved).toBe(1);

    const updatedPageA = readFileSync(pageAPath, 'utf-8');
    // Link text should also be decoded
    expect(updatedPageA).toContain('[API & Docs](./page-b.md)');
    expect(updatedPageA).not.toContain('&amp;');
  });

  test('handles links without CDATA link text', () => {
    const pageAPath = join(testDir, 'page-a.md');
    const pageBPath = join(testDir, 'page-b.md');

    // Link without ac:plain-text-link-body section
    const pageAContent = `---
page_id: page-a-id
title: Page A
version: 1
---

# Page A

Link to <ac:link><ri:page ri:content-title="Page B"/></ac:link>.
`;

    const pageBContent = `---
page_id: page-b-id
title: Page B
version: 1
---

# Page B
`;

    writeFileSync(pageAPath, pageAContent, 'utf-8');
    writeFileSync(pageBPath, pageBContent, 'utf-8');

    const config: SpaceConfigWithState = {
      spaceKey: 'TEST',
      spaceId: 'test-space-id',
      spaceName: 'Test Space',
      pages: {
        'page-a-id': 'page-a.md',
        'page-b-id': 'page-b.md',
      },
      folders: {},
      lastSync: new Date().toISOString(),
    };

    const result = resolveLinksSecondPass(testDir, config);

    expect(result.filesUpdated).toBe(1);
    expect(result.linksResolved).toBe(1);

    const updatedPageA = readFileSync(pageAPath, 'utf-8');
    // Should use title as link text when CDATA is missing
    expect(updatedPageA).toContain('[Page B](./page-b.md)');
  });
});
