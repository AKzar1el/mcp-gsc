import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkIndexingEligibility,
  INDEXING_ELIGIBILITY_MAX_RESPONSE_BYTES,
  INDEXING_ELIGIBILITY_TIMEOUT_MS,
} from '../src/google';

async function withMockFetch<T>(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  callback: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function jobPostingHtml(prefix = ''): string {
  return `${prefix}<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting"}</script>`;
}

test('eligibility fetch accepts eligible HTML within the configured byte ceiling', async () => {
  assert.equal(INDEXING_ELIGIBILITY_MAX_RESPONSE_BYTES, 1024 * 1024);
  const result = await withMockFetch(
    async () => htmlResponse(jobPostingHtml(' '.repeat(4096))),
    () => checkIndexingEligibility('https://example.com/jobs/engineer'),
  );
  assert.deepEqual(result, { eligible: true });
});

test('eligibility fetch rejects oversized streamed HTML', async () => {
  let cancelled = false;
  const oversizedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(INDEXING_ELIGIBILITY_MAX_RESPONSE_BYTES + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  const result = await withMockFetch(
    async () =>
      new Response(oversizedBody, {
        headers: { 'content-type': 'text/html' },
      }),
    () => checkIndexingEligibility('https://example.com/jobs/engineer'),
  );
  assert.equal(result.eligible, false);
  assert.match(result.reason ?? '', /1048576-byte eligibility limit/);
  assert.equal(cancelled, true);
});

test('eligibility fetch times out and returns an ineligible result', async () => {
  const result = await withMockFetch(
    async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted.', 'AbortError')),
          { once: true },
        );
      }),
    () => checkIndexingEligibility('https://example.com/jobs/engineer', { timeoutMs: 1 }),
  );
  assert.equal(result.eligible, false);
  assert.match(result.reason ?? '', /timed out after 1ms/);
  assert.equal(INDEXING_ELIGIBILITY_TIMEOUT_MS, 10_000);
});

test('eligibility fetch rejects non-HTML content before reading it', async () => {
  const result = await withMockFetch(
    async () =>
      new Response('{"@type":"JobPosting"}', {
        headers: { 'content-type': 'application/json' },
      }),
    () => checkIndexingEligibility('https://example.com/jobs/engineer'),
  );
  assert.equal(result.eligible, false);
  assert.match(result.reason ?? '', /expected HTML, received application\/json/);
});

test('eligibility fetch rejects HTTP errors', async () => {
  const result = await withMockFetch(
    async () => new Response('unavailable', { status: 503 }),
    () => checkIndexingEligibility('https://example.com/jobs/engineer'),
  );
  assert.equal(result.eligible, false);
  assert.match(result.reason ?? '', /HTTP 503/);
});

test('eligibility fetch rejects manual redirects', async () => {
  let redirectMode: RequestRedirect | undefined;
  const result = await withMockFetch(
    async (_input, init) => {
      redirectMode = init?.redirect;
      return new Response('', {
        status: 302,
        headers: { location: 'https://other.example/' },
      });
    },
    () => checkIndexingEligibility('https://example.com/jobs/engineer'),
  );
  assert.equal(redirectMode, 'manual');
  assert.equal(result.eligible, false);
  assert.match(result.reason ?? '', /HTTP 302/);
});

test('eligibility fetch ignores malformed JSON-LD and accepts a later valid block', async () => {
  const html = [
    '<script type="application/ld+json">{"@type":</script>',
    jobPostingHtml(' '.repeat(8192)),
  ].join('');
  const result = await withMockFetch(
    async () => htmlResponse(html),
    () => checkIndexingEligibility('https://example.com/jobs/engineer'),
  );
  assert.deepEqual(result, { eligible: true });
});

test('eligibility fetch rejects malformed and non-HTTP URLs without fetching', async () => {
  let calls = 0;
  const result = await withMockFetch(
    async () => {
      calls += 1;
      return htmlResponse(jobPostingHtml());
    },
    () => checkIndexingEligibility('ftp://example.com/jobs/engineer'),
  );
  assert.equal(result.eligible, false);
  assert.match(result.reason ?? '', /valid HTTP or HTTPS URL/);
  assert.equal(calls, 0);
});
