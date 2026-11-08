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

test('ordinary successful sitemap metadata preserves normalized entries', async () => {
  const result = await withMockFetch(
    () => jsonResponse({ sitemap: [{ path: 'https://example.org/sitemap.xml' }] }),
    () => listSitemaps('offline-token', SITE),
  );
  assert.equal(result[0]?.path, 'https://example.org/sitemap.xml');
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

test('ordinary successful Indexing publish preserves its notification receipt', async () => {
  const receipt = { url: URL, type: 'URL_UPDATED' };
  const result = await withEligibleIndexingPublish(
    () => jsonResponse(receipt),
    () => requestIndexing('offline-token', URL),
  );
  assert.deepEqual(result, receipt);
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
