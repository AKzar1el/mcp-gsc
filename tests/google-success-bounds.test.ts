// Offline bounded-response regressions for successful Google Search Console reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getIndexingNotificationMetadata,
  getSite,
  getSitemap,
  inspectUrl,
  inspectUrlsSequentially,
  listSites,
  listSitemaps,
  querySearchAnalytics,
  requestIndexing,
  type SearchAnalyticsQuery,
} from '../src/google';

const LIMIT = 2 * 1024 * 1024;
const SITE = 'sc-domain:example.org';
const URL = 'https://example.org/page';
const TOO_LARGE = 'x'.repeat(LIMIT + 1024);
const ANALYTICS_LIMIT = 16 * 1024 * 1024;
const ANALYTICS_QUERY: SearchAnalyticsQuery = {
  startDate: '2026-10-01',
  endDate: '2026-10-07',
  dimensions: ['query'],
  rowLimit: 10,
};

async function withMockFetch<T>(
  respond: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
  work: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => Promise.resolve(respond(input, init));
  try {
    return await work();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(payload: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers });
}

function withEligibleIndexingPublish<T>(
  respond: () => Response,
  work: () => Promise<T>,
): Promise<T> {
  return withMockFetch((input, init) => {
    if (String(input) === URL) {
      return new Response('<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting"}</script>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    assert.equal(String(input), 'https://indexing.googleapis.com/v3/urlNotifications:publish');
    assert.equal(init?.method, 'POST');
    return respond();
  }, work);
}

function inspectionPayload(paddingLength = 0): string {
  return JSON.stringify({
    inspectionResult: {
      indexStatusResult: { verdict: 'PASS' },
      padding: 'x'.repeat(paddingLength),
    },
  });
}

test('ordinary successful site metadata preserves the returned properties', async () => {
  const value = [{ siteUrl: SITE, permissionLevel: 'siteOwner' }];
  const result = await withMockFetch(
    () => jsonResponse({ siteEntry: value }),
    () => listSites('offline-token'),
  );
  assert.deepEqual(result, value);
});

test('sites.list rejects malformed property collections instead of returning non-arrays', async () => {
  await assert.rejects(
    withMockFetch(
      () => jsonResponse({ siteEntry: { siteUrl: SITE, permissionLevel: 'siteOwner' } }),
      () => listSites('offline-token'),
    ),
    /Google Search Console sites.list response contains invalid siteEntry data/,
  );
});

test('sites.list rejects entries without a valid property identifier and permission', async () => {
  await assert.rejects(
    withMockFetch(
      () => jsonResponse({ siteEntry: [{ siteUrl: SITE, permissionLevel: null }] }),
      () => listSites('offline-token'),
    ),
    /Google Search Console sites.list response contains invalid siteEntry data/,
  );
});

test('sites.get rejects malformed permission metadata instead of returning it as a property', async () => {
  await assert.rejects(
    withMockFetch(
      () => jsonResponse({ siteUrl: SITE, permissionLevel: 4 }),
      () => getSite('offline-token', SITE),
    ),
    /Google Search Console sites.get response contains invalid property data/,
  );
});

test('ordinary successful sitemap metadata preserves normalized entries', async () => {
  const result = await withMockFetch(
    () => jsonResponse({ sitemap: [{ path: 'https://example.org/sitemap.xml' }] }),
    () => listSitemaps('offline-token', SITE),
  );
  assert.equal(result[0]?.path, 'https://example.org/sitemap.xml');
});

test('sitemaps.list rejects a non-array successful sitemap collection', async () => {
  await assert.rejects(
    withMockFetch(
      () => jsonResponse({ sitemap: { path: 'https://example.org/sitemap.xml' } }),
      () => listSitemaps('offline-token', SITE),
    ),
    /sitemaps\.list response contains invalid sitemap data/,
  );
});

test('sitemaps.list rejects entries missing a valid path', async () => {
  await assert.rejects(
    withMockFetch(
      () => jsonResponse({ sitemap: [{}] }),
      () => listSitemaps('offline-token', SITE),
    ),
    /sitemaps\.list response contains invalid sitemap data/,
  );
});

test('sitemaps.list rejects malformed nested content metadata', async () => {
  await assert.rejects(
    withMockFetch(
      () => jsonResponse({ sitemap: [{ path: 'https://example.org/sitemap.xml', contents: [{ type: 'web', submitted: 12 }] }] }),
      () => listSitemaps('offline-token', SITE),
    ),
    /sitemaps\.list response contains invalid sitemap data/,
  );
});

test('sitemaps.get rejects malformed successful entries', async () => {
  for (const invalid of [
    { contents: [{ type: 'web', submitted: '1' }] },
    { path: 'https://example.org/sitemap.xml', contents: [{ type: 'web', submitted: 12 }] },
  ]) {
    await assert.rejects(
      withMockFetch(
        () => jsonResponse(invalid),
        () => getSitemap('offline-token', SITE, 'https://example.org/sitemap.xml'),
      ),
      /sitemaps\.get response contains invalid sitemap data/,
    );
  }
});

test('sitemaps.get preserves valid optional data while omitting deprecated indexed counts', async () => {
  const path = 'https://example.org/sitemap.xml';
  const entry = await withMockFetch(
    () => jsonResponse({
      path,
      isPending: null,
      lastSubmitted: '2026-11-08T09:00:00Z',
      contents: [{ type: 'web', submitted: '12', indexed: '9' }],
    }),
    () => getSitemap('offline-token', SITE, path),
  );
  assert.equal(entry.path, path);
  assert.equal(entry.isPending, null);
  assert.deepEqual(entry.contents, [{ type: 'web', submitted: '12' }]);
});

test('oversized sites.list success is rejected before unbounded JSON parsing', async () => {
  await assert.rejects(
    withMockFetch(
      () => jsonResponse({ siteEntry: [], padding: TOO_LARGE }),
      () => listSites('offline-token'),
    ),
    /2 MiB byte limit/,
  );
});

test('oversized sites.get success is rejected', async () => {
  await assert.rejects(
    withMockFetch(
      () => jsonResponse({ siteUrl: SITE, padding: TOO_LARGE }),
      () => getSite('offline-token', SITE),
    ),
    /2 MiB byte limit/,
  );
});

test('oversized sitemaps.list success is rejected', async () => {
  await assert.rejects(
    withMockFetch(
      () => jsonResponse({ sitemap: [], padding: TOO_LARGE }),
      () => listSitemaps('offline-token', SITE),
    ),
    /2 MiB byte limit/,
  );
});

test('oversized sitemaps.get success is rejected', async () => {
  await assert.rejects(
    withMockFetch(
      () => jsonResponse({ path: 'https://example.org/sitemap.xml', padding: TOO_LARGE }),
      () => getSitemap('offline-token', SITE, 'https://example.org/sitemap.xml'),
    ),
    /2 MiB byte limit/,
  );
});

test('advertised oversized success is rejected even when actual body is short', async () => {
  await assert.rejects(
    withMockFetch(
      () => new Response('{"siteEntry":[]}', {
        status: 200,
        headers: { 'content-length': String(LIMIT + 1) },
      }),
      () => listSites('offline-token'),
    ),
    /2 MiB byte limit/,
  );
});

test('oversized streamed sites.list response is cancelled early', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ siteEntry: [], padding: 'x'.repeat(3 * LIMIT) }));
  let cursor = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cursor >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(cursor + 65536, bytes.length);
      controller.enqueue(bytes.subarray(cursor, end));
      cursor = end;
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    withMockFetch(() => new Response(stream, { status: 200 }), () => listSites('offline-token')),
    /2 MiB byte limit/,
  );
  assert.equal(cancelled, true);
  assert.ok(cursor < bytes.length, 'upstream body should not be fully consumed');
});

test('advertised oversized Indexing notification metadata is rejected', async () => {
  await assert.rejects(
    withMockFetch(
      () => new Response(JSON.stringify({ url: URL }), {
        status: 200,
        headers: { 'content-length': String(LIMIT + 1) },
      }),
      () => getIndexingNotificationMetadata('offline-token', URL),
    ),
    /2 MiB byte limit/,
  );
});

test('oversized streamed Indexing notification metadata is cancelled early', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ url: URL, padding: 'x'.repeat(3 * LIMIT) }));
  let cursor = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cursor >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(cursor + 65536, bytes.length);
      controller.enqueue(bytes.subarray(cursor, end));
      cursor = end;
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    withMockFetch(() => new Response(stream, { status: 200 }),
      () => getIndexingNotificationMetadata('offline-token', URL)),
    /2 MiB byte limit/,
  );
  assert.equal(cancelled, true);
  assert.ok(cursor < bytes.length, 'upstream body should not be fully consumed');
});

test('Indexing metadata rejects malformed successful root and notification shapes', async () => {
  for (const payload of [
    null, [], 'bad', 123,
    { url: 42 },
    { latestUpdate: [] },
    { latestRemove: 'bad' },
    { latestUpdate: { url: false } },
    { latestRemove: { type: 7 } },
    { latestUpdate: { notifyTime: [] } },
  ]) {
    await assert.rejects(
      withMockFetch(() => jsonResponse(payload), () => getIndexingNotificationMetadata('offline-token', URL)),
      /Google Indexing metadata response contains invalid notification data/,
    );
  }
});

test('Indexing metadata preserves absent and nullable notifications with future fields', async () => {
  const values = [
    {},
    { url: URL, latestUpdate: null, latestRemove: null },
    {
      url: URL,
      latestUpdate: { url: URL, type: 'URL_UPDATED', notifyTime: '2026-11-09T00:00:00Z', future: 1 },
      latestRemove: { type: 'FUTURE_TYPE' },
      futureField: ['other', 2],
    },
  ];
  for (const payload of values) {
    assert.deepEqual(
      await withMockFetch(() => jsonResponse(payload), () => getIndexingNotificationMetadata('offline-token', URL)),
      payload,
    );
  }
});

test('ordinary successful Indexing publish preserves its notification receipt', async () => {
  const receipt = { url: URL, type: 'URL_UPDATED' };
  const result = await withEligibleIndexingPublish(
    () => jsonResponse(receipt),
    () => requestIndexing('offline-token', URL),
  );
  assert.deepEqual(result, receipt);
});

test('Indexing publish preserves valid wrapped metadata and future fields', async () => {
  const receipt = { urlNotificationMetadata: { url: URL, latestUpdate: null, futureField: true } };
  assert.deepEqual(await withEligibleIndexingPublish(
    () => jsonResponse(receipt),
    () => requestIndexing('offline-token', URL),
  ), receipt);
});

test('malformed successful Indexing publish receipts explicitly remain unverified', async () => {
  const expected = {
    receipt_status: 'unverified',
    provider_http_status: 200,
    note: 'Google returned HTTP success but the Indexing notification receipt was malformed or unreadable. Verify notification metadata before considering a new submission.',
  };
  for (const payload of [[], { urlNotificationMetadata: 'invalid' }, { urlNotificationMetadata: { latestUpdate: [] } }]) {
    const result = await withEligibleIndexingPublish(
      () => jsonResponse(payload),
      () => requestIndexing('offline-token', URL),
    );
    assert.deepEqual(result, expected);
  }
  for (const body of ['{invalid json', '']) {
    const result = await withEligibleIndexingPublish(
      () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
      () => requestIndexing('offline-token', URL),
    );
    assert.deepEqual(result, expected);
  }
});

test('advertised oversized successful Indexing publish response is rejected', async () => {
  await assert.rejects(
    withEligibleIndexingPublish(
      () => new Response(JSON.stringify({ url: URL }), {
        status: 200,
        headers: { 'content-length': String(LIMIT + 1) },
      }),
      () => requestIndexing('offline-token', URL),
    ),
    /2 MiB byte limit/,
  );
});

test('streamed oversized successful Indexing publish response is cancelled early', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ url: URL, padding: 'x'.repeat(3 * LIMIT) }));
  let cursor = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cursor >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(cursor + 65536, bytes.length);
      controller.enqueue(bytes.subarray(cursor, end));
      cursor = end;
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    withEligibleIndexingPublish(
      () => new Response(stream, { status: 200 }),
      () => requestIndexing('offline-token', URL),
    ),
    /2 MiB byte limit/,
  );
  assert.equal(cancelled, true);
  assert.ok(cursor < bytes.length, 'upstream body should not be fully consumed');
});

test('oversized advertised URL Inspection success is rejected', async () => {
  await assert.rejects(
    withMockFetch(
      () => new Response(inspectionPayload(), {
        status: 200,
        headers: { 'content-length': String(LIMIT + 1) },
      }),
      () => inspectUrl('offline-token', SITE, URL),
    ),
    /2 MiB byte limit/,
  );
});

test('oversized streamed URL Inspection success is cancelled early', async () => {
  const bytes = new TextEncoder().encode(inspectionPayload(3 * LIMIT));
  let cursor = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cursor >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(cursor + 65536, bytes.length);
      controller.enqueue(bytes.subarray(cursor, end));
      cursor = end;
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    withMockFetch(() => new Response(stream, { status: 200 }), () => inspectUrl('offline-token', SITE, URL)),
    /2 MiB byte limit/,
  );
  assert.equal(cancelled, true);
  assert.ok(cursor < bytes.length, 'upstream body should not be fully consumed');
});

test('URL Inspection accepts an exact 2 MiB valid JSON response', async () => {
  const padding = LIMIT - Buffer.byteLength(inspectionPayload());
  const exact = inspectionPayload(padding);
  assert.equal(Buffer.byteLength(exact), LIMIT);
  const result = await withMockFetch(
    () => new Response(exact, { status: 200 }),
    () => inspectUrl('offline-token', SITE, URL),
  );
  assert.equal((result as { indexStatusResult: { verdict: string } }).indexStatusResult.verdict, 'PASS');
});

test('URL Inspection rejects malformed successful response and inspectionResult shapes', async () => {
  for (const payload of [null, [], 'bad', 123, { inspectionResult: 'bad' }, { inspectionResult: [] }, { inspectionResult: true }, { inspectionResult: 123 }]) {
    await assert.rejects(
      withMockFetch(() => jsonResponse(payload), () => inspectUrl('offline-token', SITE, URL)),
      /URL Inspection response contains invalid inspection data/,
    );
  }
});

test('URL Inspection preserves absent, null, and extensible valid inspection results', async () => {
  for (const payload of [{}, { inspectionResult: null }]) {
    assert.equal(await withMockFetch(() => jsonResponse(payload), () => inspectUrl('offline-token', SITE, URL)), null);
  }
  const result = { indexStatusResult: { verdict: 'PASS' }, futureGoogleField: 'extended' };
  assert.deepEqual(
    await withMockFetch(() => jsonResponse({ inspectionResult: result }), () => inspectUrl('offline-token', SITE, URL)),
    result,
  );
});

test('URL Inspection rejects malformed known nested result objects and links', async () => {
  for (const inspectionResult of [
    { indexStatusResult: [] },
    { indexStatusResult: 'PASS' },
    { ampResult: true },
    { mobileUsabilityResult: 123 },
    { richResultsResult: [] },
    { inspectionResultLink: 42 },
  ]) {
    await assert.rejects(
      withMockFetch(() => jsonResponse({ inspectionResult }), () => inspectUrl('offline-token', SITE, URL)),
      /URL Inspection response contains invalid inspection data/,
    );
  }
});

test('URL Inspection preserves optional nested results, null fields, and future metadata', async () => {
  const inspectionResult = {
    inspectionResultLink: 'https://search.google.com/search-console/inspect',
    indexStatusResult: { verdict: 'NEUTRAL' },
    ampResult: null,
    richResultsResult: { detectedItems: [] },
    futureGoogleField: [1, 'two'],
  };
  assert.deepEqual(
    await withMockFetch(() => jsonResponse({ inspectionResult }), () => inspectUrl('offline-token', SITE, URL)),
    inspectionResult,
  );
});

test('sequential URL Inspection isolates malformed-success errors without skipping later URLs', async () => {
  let calls = 0;
  const results = await withMockFetch(
    (_input, init) => {
      calls += 1;
      const requested = (JSON.parse(String(init?.body)) as { inspectionUrl: string }).inspectionUrl;
      return jsonResponse(requested.endsWith('/bad')
        ? { inspectionResult: 123 }
        : { inspectionResult: { indexStatusResult: { verdict: 'PASS' } } });
    },
    () => inspectUrlsSequentially('offline-token', SITE, [
      'https://example.org/bad',
      'https://example.org/good',
    ]),
  );
  assert.equal(calls, 2);
  assert.match(results[0]?.error ?? '', /URL Inspection response contains invalid inspection data/);
  assert.deepEqual(results[1]?.inspectionResult, { indexStatusResult: { verdict: 'PASS' } });
});

test('cleanup errors never hide the response-size error', async () => {
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"siteEntry":[]}'));
    },
    cancel() {
      throw new Error('upstream cleanup failed');
    },
  }), {
    status: 200,
    headers: { 'content-length': String(LIMIT + 1) },
  });
  await assert.rejects(
    withMockFetch(() => response, () => listSites('offline-token')),
    /2 MiB byte limit/,
  );
});

test('sequential inspections isolate an oversized result and continue to the next URL', async () => {
  let calls = 0;
  const result = await withMockFetch(
    (_input, init) => {
      calls += 1;
      const requested = (JSON.parse(String(init?.body)) as { inspectionUrl: string }).inspectionUrl;
      return new Response(requested.endsWith('/large') ? inspectionPayload(LIMIT) : inspectionPayload(), { status: 200 });
    },
    () => inspectUrlsSequentially('offline-token', SITE, [
      'https://example.org/large',
      'https://example.org/small',
    ]),
  );
  assert.equal(calls, 2);
  assert.match(result[0]?.error ?? '', /2 MiB byte limit/);
  assert.equal((result[1]?.inspectionResult as { indexStatusResult: { verdict: string } }).indexStatusResult.verdict, 'PASS');
});

test('Search Analytics rejects an advertised oversized success without parsing it', async () => {
  await assert.rejects(
    withMockFetch(
      () => new Response('{"rows":[]}', {
        status: 200,
        headers: { 'content-length': String(ANALYTICS_LIMIT + 1) },
      }),
      () => querySearchAnalytics('offline-token', SITE, ANALYTICS_QUERY),
    ),
    /Search Analytics response exceeds the 16 MiB byte limit/,
  );
});

test('Search Analytics cancels oversized success streams before exhausting them', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ rows: [], padding: 'x'.repeat(ANALYTICS_LIMIT + 1024 * 1024) }));
  let cursor = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cursor >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(cursor + 65536, bytes.length);
      controller.enqueue(bytes.subarray(cursor, end));
      cursor = end;
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    withMockFetch(
      () => new Response(stream, { status: 200 }),
      () => querySearchAnalytics('offline-token', SITE, ANALYTICS_QUERY),
    ),
    /Search Analytics response exceeds the 16 MiB byte limit/,
  );
  assert.equal(cancelled, true);
  assert.ok(cursor < bytes.length, 'large upstream body should not be fully consumed');
});

test('Search Analytics accepts responses larger than the metadata limit', async () => {
  const result = await withMockFetch(
    () => jsonResponse({ rows: [{ keys: ['example'], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }], padding: 'x'.repeat(LIMIT + 256) }),
    () => querySearchAnalytics('offline-token', SITE, ANALYTICS_QUERY),
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].keys?.[0], 'example');
});

test('Search Analytics accepts an exactly 16 MiB valid JSON response', async () => {
  const empty = JSON.stringify({ rows: [], padding: '' });
  const exact = JSON.stringify({ rows: [], padding: 'x'.repeat(ANALYTICS_LIMIT - Buffer.byteLength(empty)) });
  assert.equal(Buffer.byteLength(exact), ANALYTICS_LIMIT);
  const result = await withMockFetch(
    () => new Response(exact, { status: 200 }),
    () => querySearchAnalytics('offline-token', SITE, ANALYTICS_QUERY),
  );
  assert.deepEqual(result.rows, []);
});

test('Search Analytics rejects a successful response with non-array rows', async () => {
  await assert.rejects(
    withMockFetch(
      () => jsonResponse({ rows: { clicks: 1, impressions: 2 } }),
      () => querySearchAnalytics('offline-token', SITE, ANALYTICS_QUERY),
    ),
    /Search Analytics response contains invalid rows/,
  );
});

test('Search Analytics rejects successful pages that exceed the requested row limit', async () => {
  const row = { keys: ['example'], clicks: 1, impressions: 2, ctr: 0.5, position: 3 };
  const exactlyFull = await withMockFetch(
    () => jsonResponse({ rows: Array.from({ length: ANALYTICS_QUERY.rowLimit }, () => row) }),
    () => querySearchAnalytics('offline-token', SITE, ANALYTICS_QUERY),
  );
  assert.equal(exactlyFull.rows.length, ANALYTICS_QUERY.rowLimit);

  await assert.rejects(
    withMockFetch(
      () => jsonResponse({ rows: Array.from({ length: ANALYTICS_QUERY.rowLimit + 1 }, () => row) }),
      () => querySearchAnalytics('offline-token', SITE, ANALYTICS_QUERY),
    ),
    /Search Analytics response contains invalid rows/,
  );
});

test('Search Analytics rejects non-finite and missing row metrics', async () => {
  for (const invalidRow of [
    { keys: ['example'], clicks: '1', impressions: 2, ctr: 0.5 },
    { keys: ['example'], clicks: 1, impressions: 2, ctr: null },
    { keys: [null], clicks: 1, impressions: 2, ctr: 0.5 },
    { keys: ['example'], clicks: 1, impressions: 2, ctr: 0.5, position: '3' },
  ]) {
    await assert.rejects(
      withMockFetch(
        () => jsonResponse({ rows: [invalidRow] }),
        () => querySearchAnalytics('offline-token', SITE, ANALYTICS_QUERY),
      ),
      /Search Analytics response contains invalid rows/,
    );
  }
});

test('Search Analytics rejects malformed successful metadata', async () => {
  for (const payload of [
    { rows: [], metadata: null },
    { rows: [], metadata: { firstIncompleteDate: 20261108 } },
    { rows: [], responseAggregationType: 3 },
  ]) {
    await assert.rejects(
      withMockFetch(
        () => jsonResponse(payload),
        () => querySearchAnalytics('offline-token', SITE, ANALYTICS_QUERY),
      ),
      /Search Analytics response contains invalid metadata/,
    );
  }
});

test('Search Analytics preserves omitted rows and optional position for Discover results', async () => {
  const empty = await withMockFetch(
    () => jsonResponse({}),
    () => querySearchAnalytics('offline-token', SITE, ANALYTICS_QUERY),
  );
  assert.deepEqual(empty.rows, []);
  const row = { keys: ['example'], clicks: 2, impressions: 5, ctr: 0.4 };
  const result = await withMockFetch(
    () => jsonResponse({ rows: [row], metadata: { firstIncompleteDate: '2026-11-08' } }),
    () => querySearchAnalytics('offline-token', SITE, ANALYTICS_QUERY),
  );
  assert.deepEqual(result.rows, [row]);
  assert.deepEqual(result.metadata, { first_incomplete_date: '2026-11-08' });
});
