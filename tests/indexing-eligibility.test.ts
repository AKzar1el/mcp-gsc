import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkIndexingEligibility,
  checkIndexingRemovalEligibility,
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

test('eligibility fetch accepts schema.org URL types and flexible JSON-LD script attributes', async () => {
  const html =
    '<script type = "application/ld+json">' +
    '{"@context":"https://schema.org","@type":"https://schema.org/JobPosting"}' +
    '</script>';
  const result = await withMockFetch(
    async () => htmlResponse(html),
    () => checkIndexingEligibility('https://example.com/jobs/engineer'),
  );
  assert.deepEqual(result, { eligible: true });
});

test('eligibility fetch accepts JobPosting Microdata and RDFa', async () => {
  for (const html of [
    '<main itemscope itemtype="https://schema.org/JobPosting"><h1>Engineer</h1></main>',
    '<main vocab="https://schema.org/" typeof="JobPosting"><h1>Engineer</h1></main>',
  ]) {
    const result = await withMockFetch(
      async () => htmlResponse(html),
      () => checkIndexingEligibility('https://example.com/jobs/engineer'),
    );
    assert.deepEqual(result, { eligible: true });
  }
});

test('eligibility fetch accepts nested livestream Microdata and RDFa', async () => {
  for (const html of [
    '<div itemscope itemtype="https://schema.org/VideoObject"><div itemprop="publication" itemscope itemtype="https://schema.org/BroadcastEvent"></div></div>',
    '<div vocab="https://schema.org/" typeof="VideoObject"><div property="publication" typeof="BroadcastEvent"></div></div>',
  ]) {
    const result = await withMockFetch(
      async () => htmlResponse(html),
      () => checkIndexingEligibility('https://example.com/live/event'),
    );
    assert.deepEqual(result, { eligible: true });
  }
});

test('eligibility fetch keeps BroadcastEvent nesting fail-closed for HTML attribute markup', async () => {
  const html = [
    '<div itemscope itemtype="https://schema.org/VideoObject"></div>',
    '<div itemscope itemtype="https://schema.org/BroadcastEvent"></div>',
  ].join('');
  const result = await withMockFetch(
    async () => htmlResponse(html),
    () => checkIndexingEligibility('https://example.com/live/event'),
  );
  assert.equal(result.eligible, false);
  assert.match(result.reason ?? '', /BroadcastEvent inside VideoObject/);
});

test('eligibility fetch ignores structured-data-looking markup inside inert text containers', async () => {
  const html = [
    '<!-- <div itemscope itemtype="https://schema.org/JobPosting"></div> -->',
    '<script>const example = `<div itemscope itemtype="https://schema.org/JobPosting"></div>`;</script>',
    '<template><div itemscope itemtype="https://schema.org/JobPosting"></div></template>',
  ].join('');
  const result = await withMockFetch(
    async () => htmlResponse(html),
    () => checkIndexingEligibility('https://example.com/docs/example'),
  );
  assert.equal(result.eligible, false);
});

test('eligibility ignores structured-data examples in HTML raw-text containers', async () => {
  const samples = [
    '<textarea>' + jobPostingHtml() + '</textarea>',
    '<xmp><main itemscope itemtype="https://schema.org/JobPosting"></main></xmp>',
    '<title><main itemscope itemtype="https://schema.org/JobPosting"></main></title>',
    '<iframe>' + jobPostingHtml() + '</iframe>',
    '<template><textarea>literal </template><main itemscope itemtype="https://schema.org/JobPosting"></main></textarea></template>',
  ];
  for (const html of samples) {
    const result = await withMockFetch(
      async () => htmlResponse(html),
      () => checkIndexingEligibility('https://example.com/jobs/raw-text-sample'),
    );
    assert.equal(result.eligible, false, html);
  }
  const activeAfterSample = await withMockFetch(
    async () => htmlResponse('<textarea>' + jobPostingHtml() + '</textarea>' + jobPostingHtml()),
    () => checkIndexingEligibility('https://example.com/jobs/active-after-sample'),
  );
  assert.deepEqual(activeAfterSample, { eligible: true });
});

test('eligibility rejects structured data hidden after an inner template closes', async () => {
  const hiddenJsonLd = '<template><template></template>' +
    '<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting"}</script>' +
    '</template>';
  const hiddenMicrodata = '<template><template></template>' +
    '<main itemscope itemtype="https://schema.org/JobPosting">Not active</main>' +
    '</template>';
  for (const html of [hiddenJsonLd, hiddenMicrodata]) {
    const result = await withMockFetch(
      async () => htmlResponse(html),
      () => checkIndexingEligibility('https://example.com/jobs/hidden'),
    );
    assert.equal(result.eligible, false, html);
  }
});

test('eligibility still accepts active JSON-LD after nested templates', async () => {
  const html = '<template><template></template><p>Inactive</p></template>' +
    '<script>const example = "<template>";</script>' +
    jobPostingHtml();
  const result = await withMockFetch(
    async () => htmlResponse(html),
    () => checkIndexingEligibility('https://example.com/jobs/active'),
  );
  assert.deepEqual(result, { eligible: true });
});

test('eligibility ignores commented and inert JSON-LD and prefixed schema attributes', async () => {
  for (const html of [
    '<!-- <script type="application/ld+json">{"@type":"JobPosting"}</script> -->',
    '<template><script type="application/ld+json">{"@type":"JobPosting"}</script></template>',
    '<script data-type="application/ld+json">{"@type":"JobPosting"}</script>',
    '<script data-note="type=application/ld+json">{"@type":"JobPosting"}</script>',
    '<main data-itemtype="https://schema.org/JobPosting">Not a job posting</main>',
    '<main data-vocab="https://schema.org/" typeof="JobPosting">Not a job posting</main>',
  ]) {
    const result = await withMockFetch(
      async () => htmlResponse(html),
      () => checkIndexingEligibility('https://example.com/docs/example'),
    );
    assert.equal(result.eligible, false, html);
  }
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

test('removal eligibility accepts HTTP 404 and 410 without reading a body', async () => {
  for (const status of [404, 410]) {
    const result = await withMockFetch(
      async () => new Response('gone', { status }),
      () => checkIndexingRemovalEligibility('https://example.com/jobs/old-role'),
    );
    assert.deepEqual(result, { eligible: true });
  }
});

test('removal eligibility accepts a robots noindex meta directive in the document head', async () => {
  for (const html of [
    '<html><head><meta name="robots" content="nofollow, noindex"></head><body>Retired job</body></html>',
    '<html><head><meta content="noindex" name="robots"><body>Retired job</body></html>',
  ]) {
    const result = await withMockFetch(
      async () => htmlResponse(html),
      () => checkIndexingRemovalEligibility('https://example.com/jobs/old-role'),
    );
    assert.deepEqual(result, { eligible: true });
  }
});

test('removal eligibility rejects an ordinary live page and noindex outside the document head', async () => {
  for (const html of [
    '<html><head><title>Live</title></head><body>Still live</body></html>',
    '<html><head><title>Live</title></head><body><meta name="robots" content="noindex"></body></html>',
  ]) {
    const result = await withMockFetch(
      async () => htmlResponse(html),
      () => checkIndexingRemovalEligibility('https://example.com/jobs/old-role'),
    );
    assert.equal(result.eligible, false);
    assert.match(result.reason ?? '', /404\/410|robots noindex/);
  }
});

test('removal eligibility ignores inert and prefixed robots meta attributes', async () => {
  for (const html of [
    '<html><head><!-- <meta name="robots" content="noindex"> --></head><body>Live</body></html>',
    '<html><head><meta data-name="robots" data-content="noindex"></head><body>Live</body></html>',
    '<html><head><meta name="robots" data-content="noindex"></head><body>Live</body></html>',
    '<html><head><meta data-name="robots" content="noindex"></head><body>Live</body></html>',
    '<html><head><script>const sample = \'<meta name="robots" content="noindex">\';</script></head><body>Live</body></html>',
    '<html><head><title><meta name="robots" content="noindex"></title></head><body>Live</body></html>',
    '<html><head><template><meta name="robots" content="noindex"></template></head><body>Live</body></html>',
    '<html><head><template><template></template><meta name="robots" content="noindex"></template></head><body>Live</body></html>',
  ]) {
    const result = await withMockFetch(
      async () => htmlResponse(html),
      () => checkIndexingRemovalEligibility('https://example.com/jobs/old-role'),
    );
    assert.equal(result.eligible, false, html);
  }
});
