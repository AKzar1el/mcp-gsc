// Offline bounded-response regressions for successful Google Search Console reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSite,
  getSitemap,
  inspectUrl,
  inspectUrlsSequentially,
  listSites,
  listSitemaps,
} from '../src/google';

const LIMIT = 2 * 1024 * 1024;
const SITE = 'sc-domain:example.org';
const URL = 'https://example.org/page';
const TOO_LARGE = 'x'.repeat(LIMIT + 1024);

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
