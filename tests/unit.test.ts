// Offline unit tests for the pure logic in src/ — no network, no Cloudflare,
// no deployed Worker required. These run in CI on every push.
//
// Run with:
//   npm run test:unit
//
// Google's HTTP API is mocked by swapping globalThis.fetch, so these tests
// assert our request construction and error mapping, never live GSC data.
// (Deployment-level checks live in tests/smoke.test.mjs.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptToken, decryptToken } from '../src/crypto';
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  listSites,
  listSitemaps,
  querySearchAnalytics,
  GoogleRefreshTokenRevokedError,
  GSC_ACCESS_REVOKED_MESSAGE,
  addSite,
  deleteSite,
  submitSitemap,
  deleteSitemap,
  getSitemap,
  processQuickWins,
  processCannibalization,
  processContentDecay,
  requestIndexing,
  processPerformanceComparison,
} from '../src/google';

// ---------------------------------------------------------------------------
// Helpers

function makeKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString('base64');
}

interface CapturedRequest {
  url: string;
  init?: RequestInit;
}

/**
 * Replace globalThis.fetch for the duration of `fn`. The handler receives the
 * stringified URL and the RequestInit; captured calls are returned for
 * assertions on URLs and bodies.
 */
async function withMockFetch<T>(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<T>,
): Promise<{ result: T; calls: CapturedRequest[] }> {
  const original = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    globalThis.fetch = original;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// crypto.ts — AES-GCM refresh-token encryption

test('crypto: encrypt → decrypt roundtrips the plaintext', async () => {
  const key = makeKey();
  const plaintext = '1//refresh-token-with-unicode-✓-and-symbols-%&';
  const { ciphertext, iv } = await encryptToken(plaintext, key);
  const decrypted = await decryptToken(ciphertext, iv, key);
  assert.equal(decrypted, plaintext);
});

test('crypto: each encryption uses a fresh IV and ciphertext', async () => {
  const key = makeKey();
  const a = await encryptToken('same-plaintext', key);
  const b = await encryptToken('same-plaintext', key);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test('crypto: tampered ciphertext fails to decrypt', async () => {
  const key = makeKey();
  const { ciphertext, iv } = await encryptToken('secret', key);
  const bytes = Buffer.from(ciphertext, 'base64');
  bytes[0] ^= 0xff;
  const tampered = bytes.toString('base64');
  await assert.rejects(() => decryptToken(tampered, iv, key));
});

test('crypto: decryption with the wrong key fails', async () => {
  const { ciphertext, iv } = await encryptToken('secret', makeKey());
  await assert.rejects(() => decryptToken(ciphertext, iv, makeKey()));
});

// ---------------------------------------------------------------------------
// google.ts — OAuth URL construction

test('buildAuthUrl: includes offline access, consent prompt, scope, and state', () => {
  const url = new URL(
    buildAuthUrl('client-123', 'https://worker.example/google/callback', 'nonce-abc'),
  );
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'client-123');
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'https://worker.example/google/callback',
  );
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('state'), 'nonce-abc');
  const scope = url.searchParams.get('scope') ?? '';
  assert.ok(scope.includes('https://www.googleapis.com/auth/webmasters'));
});

// ---------------------------------------------------------------------------
// google.ts — token exchange and refresh error mapping

test('exchangeCodeForTokens: rejects when Google omits refresh_token', async () => {
  await assert.rejects(
    withMockFetch(
      () => json(200, { access_token: 'at', expires_in: 3599, token_type: 'Bearer', scope: '' }),
      () => exchangeCodeForTokens('code', 'id', 'secret', 'https://x/cb'),
    ),
    /refresh_token/,
  );
});

test('refreshAccessToken: invalid_grant maps to GoogleRefreshTokenRevokedError', async () => {
  await assert.rejects(
    withMockFetch(
      () => json(400, { error: 'invalid_grant', error_description: 'Token has been revoked.' }),
      () => refreshAccessToken('rt', 'id', 'secret'),
    ),
    (err: unknown) => err instanceof GoogleRefreshTokenRevokedError,
  );
});

test('refreshAccessToken: transient 5xx is NOT treated as revocation', async () => {
  await assert.rejects(
    withMockFetch(
      () => new Response('Internal error', { status: 500 }),
      () => refreshAccessToken('rt', 'id', 'secret'),
    ),
    (err: unknown) =>
      err instanceof Error &&
      !(err instanceof GoogleRefreshTokenRevokedError) &&
      /500/.test(err.message),
  );
});

test('refreshAccessToken: non-JSON 400 is NOT treated as revocation', async () => {
  await assert.rejects(
    withMockFetch(
      () => new Response('Bad Request', { status: 400 }),
      () => refreshAccessToken('rt', 'id', 'secret'),
    ),
    (err: unknown) =>
      err instanceof Error && !(err instanceof GoogleRefreshTokenRevokedError),
  );
});

test('refreshAccessToken: success returns the new access token', async () => {
  const { result } = await withMockFetch(
    () => json(200, { access_token: 'new-at', expires_in: 3599 }),
    () => refreshAccessToken('rt', 'id', 'secret'),
  );
  assert.equal(result.access_token, 'new-at');
  assert.equal(result.expires_in, 3599);
});

// ---------------------------------------------------------------------------
// google.ts — Search Console API calls

test('listSites: 401 maps to the access-revoked message', async () => {
  await assert.rejects(
    withMockFetch(
      () => new Response('', { status: 401 }),
      () => listSites('expired-token'),
    ),
    new RegExp(GSC_ACCESS_REVOKED_MESSAGE.slice(0, 22)),
  );
});

test('listSites: empty account returns [] (not undefined)', async () => {
  const { result } = await withMockFetch(
    () => json(200, {}),
    () => listSites('at'),
  );
  assert.deepEqual(result, []);
});

test('listSitemaps: percent-encodes the property URL in the path', async () => {
  const { calls } = await withMockFetch(
    () => json(200, { sitemap: [] }),
    () => listSitemaps('at', 'sc-domain:example.com'),
  );
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].url.includes('/sites/sc-domain%3Aexample.com/sitemaps'),
    `URL not encoded: ${calls[0].url}`,
  );
});

test('querySearchAnalytics: sends the query body including startRow and returns rows', async () => {
  const rows = [
    { keys: ['cheap flights'], clicks: 10, impressions: 200, ctr: 0.05, position: 4.2 },
  ];
  const { result, calls } = await withMockFetch(
    () => json(200, { rows }),
    () =>
      querySearchAnalytics('at', 'https://example.com/', {
        startDate: '2026-05-01',
        endDate: '2026-05-31',
        dimensions: ['query'],
        rowLimit: 100,
        startRow: 200,
        dataState: 'all',
        type: 'web',
        aggregationType: 'auto',
      }),
  );
  assert.deepEqual(result, rows);
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].url.includes('/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query'),
    `URL not encoded: ${calls[0].url}`,
  );
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.startRow, 200);
  assert.equal(body.rowLimit, 100);
  assert.equal(body.startDate, '2026-05-01');
});

test('querySearchAnalytics: missing rows field returns [] (no data, not an error)', async () => {
  const { result } = await withMockFetch(
    () => json(200, {}),
    () =>
      querySearchAnalytics('at', 'sc-domain:example.com', {
        startDate: '2026-05-01',
        endDate: '2026-05-31',
        dimensions: [],
        rowLimit: 100,
      }),
  );
  assert.deepEqual(result, []);
});

// ---------------------------------------------------------------------------
// New GSC Suite API methods

test('addSite: sends PUT request to the correct site URL', async () => {
  const { calls } = await withMockFetch(
    () => new Response(null, { status: 204 }),
    () => addSite('at', 'https://example.com/'),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, 'PUT');
  assert.ok(calls[0].url.includes('/sites/https%3A%2F%2Fexample.com%2F'));
});

test('deleteSite: sends DELETE request to the correct site URL', async () => {
  const { calls } = await withMockFetch(
    () => new Response(null, { status: 204 }),
    () => deleteSite('at', 'https://example.com/'),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, 'DELETE');
  assert.ok(calls[0].url.includes('/sites/https%3A%2F%2Fexample.com%2F'));
});

test('submitSitemap: sends PUT request with encoded sitemap URL', async () => {
  const { calls } = await withMockFetch(
    () => new Response(null, { status: 204 }),
    () => submitSitemap('at', 'https://example.com/', 'https://example.com/sitemap.xml'),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, 'PUT');
  assert.ok(
    calls[0].url.includes('/sites/https%3A%2F%2Fexample.com%2F/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml')
  );
});

test('deleteSitemap: sends DELETE request with encoded sitemap URL', async () => {
  const { calls } = await withMockFetch(
    () => new Response(null, { status: 204 }),
    () => deleteSitemap('at', 'https://example.com/', 'https://example.com/sitemap.xml'),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, 'DELETE');
  assert.ok(
    calls[0].url.includes('/sites/https%3A%2F%2Fexample.com%2F/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml')
  );
});

test('getSitemap: sends GET request and returns sitemap details', async () => {
  const mockSitemap = {
    path: 'https://example.com/sitemap.xml',
    lastSubmitted: '2026-07-01T12:00:00Z',
    isPending: false,
    warnings: '0',
    errors: '0',
  };
  const { result, calls } = await withMockFetch(
    () => json(200, mockSitemap),
    () => getSitemap('at', 'https://example.com/', 'https://example.com/sitemap.xml'),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method ?? 'GET', 'GET');
  assert.ok(
    calls[0].url.includes('/sites/https%3A%2F%2Fexample.com%2F/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml')
  );
  assert.deepEqual(result, mockSitemap);
});

// ---------------------------------------------------------------------------
// Advanced SEO opportunity analysis methods

test('processQuickWins: filters queries ranking 8-20 with min impressions and sorts by impressions', () => {
  const rows = [
    { keys: ['query1', 'page1'], clicks: 5, impressions: 50, ctr: 0.1, position: 10 }, // low impressions
    { keys: ['query2', 'page2'], clicks: 10, impressions: 200, ctr: 0.05, position: 12 }, // matches
    { keys: ['query3', 'page3'], clicks: 2, impressions: 300, ctr: 0.006, position: 15 }, // matches (highest impressions)
    { keys: ['query4', 'page4'], clicks: 20, impressions: 500, ctr: 0.04, position: 5 }, // rank too high (< 8)
    { keys: ['query5', 'page5'], clicks: 1, impressions: 600, ctr: 0.001, position: 22 }, // rank too low (> 20)
  ];
  
  const wins = processQuickWins(rows, 100, 8, 20);
  assert.equal(wins.length, 2);
  // Highest impressions first (query3 has 300, query2 has 200)
  assert.equal(wins[0].query, 'query3');
  assert.equal(wins[1].query, 'query2');
});

test('processCannibalization: groups by query and finds multiple pages with min impressions and share percentage', () => {
  const rows = [
    // Cannibalized query: query1 is split across page1 and page2
    { keys: ['query1', 'page1'], clicks: 10, impressions: 100, ctr: 0.1, position: 5 },
    { keys: ['query1', 'page2'], clicks: 5, impressions: 100, ctr: 0.05, position: 12 },
    // Not cannibalized query: query2 has page3 (95%) and page4 (5%, below min_page_percentage 10)
    { keys: ['query2', 'page3'], clicks: 95, impressions: 950, ctr: 0.1, position: 2 },
    { keys: ['query2', 'page4'], clicks: 5, impressions: 50, ctr: 0.1, position: 15 },
  ];

  const candidates = processCannibalization(rows, 50, 10);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].query, 'query1');
  assert.equal(candidates[0].pages.length, 2);
});

test('processContentDecay: identifies page traffic drop and calculates click drop metrics', () => {
  const recentRows = [
    { keys: ['page1'], clicks: 50, impressions: 1000, ctr: 0.05, position: 5 }, // decay (from 100 to 50)
    { keys: ['page2'], clicks: 150, impressions: 1500, ctr: 0.1, position: 2 }, // growth (from 100 to 150)
    { keys: ['page3'], clicks: 80, impressions: 800, ctr: 0.1, position: 4 }, // decay (from 90 to 80)
  ];
  const previousRows = [
    { keys: ['page1'], clicks: 100, impressions: 2000, ctr: 0.05, position: 5 },
    { keys: ['page2'], clicks: 100, impressions: 1000, ctr: 0.1, position: 3 },
    { keys: ['page3'], clicks: 90, impressions: 900, ctr: 0.1, position: 4 },
  ];

  const decay = processContentDecay(recentRows, previousRows);
  assert.equal(decay.length, 2);
  // Sorted by click drop descending (most negative: page1 has -50, page3 has -10)
  assert.equal(decay[0].page, 'page1');
  assert.equal(decay[0].click_difference, -50);
  assert.equal(decay[0].click_decay_percentage, 50); // (50 drop / 100 prev) * 100
  
  assert.equal(decay[1].page, 'page3');
  assert.equal(decay[1].click_difference, -10);
  assert.equal(decay[1].click_decay_percentage, 11.1); // (10 drop / 90 prev) * 100
});

test('requestIndexing: sends POST request to the correct indexing endpoint', async () => {
  const mockResult = {
    urlNotificationMetadata: {
      latestNotification: {
        url: 'https://example.com/page',
        type: 'URL_UPDATED',
        notifyTime: '2026-07-01T12:00:00Z',
      },
    },
  };
  const { result, calls } = await withMockFetch(
    () => json(200, mockResult),
    () => requestIndexing('at', 'https://example.com/page'),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[0].url, 'https://indexing.googleapis.com/v3/urlNotifications:publish');
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), {
    url: 'https://example.com/page',
    type: 'URL_UPDATED',
  });
  assert.deepEqual(result, mockResult);
});

test('processPerformanceComparison: correctly aligns period A and period B metrics and computes differences', () => {
  const rowsA = [
    { keys: ['query1'], clicks: 120, impressions: 1200, ctr: 0.1, position: 2 },
    { keys: ['query2'], clicks: 50, impressions: 500, ctr: 0.1, position: 5 },
  ];
  const rowsB = [
    { keys: ['query1'], clicks: 100, impressions: 1000, ctr: 0.1, position: 3 },
    { keys: ['query3'], clicks: 80, impressions: 800, ctr: 0.1, position: 4 },
  ];

  const comparison = processPerformanceComparison(rowsA, rowsB);
  
  // Sorted by Period A clicks descending (query1 has 120, query2 has 50, query3 has 0)
  assert.equal(comparison.length, 3);
  
  // query1: clicks A=120, B=100. diff = +20 (+20%)
  assert.equal(comparison[0].key, 'query1');
  assert.equal(comparison[0].period_a.clicks, 120);
  assert.equal(comparison[0].period_b.clicks, 100);
  assert.equal(comparison[0].diff.clicks, 20);
  assert.equal(comparison[0].diff.clicks_percentage, 20);
  assert.equal(comparison[0].diff.position, -1); // (2 - 3)

  // query2: clicks A=50, B=0 (not in B). diff = +50
  assert.equal(comparison[1].key, 'query2');
  assert.equal(comparison[1].period_a.clicks, 50);
  assert.equal(comparison[1].period_b.clicks, 0);
  assert.equal(comparison[1].diff.clicks, 50);
  assert.equal(comparison[1].diff.clicks_percentage, 0);

  // query3: clicks A=0, B=80 (only in B). diff = -80 (-100%)
  assert.equal(comparison[2].key, 'query3');
  assert.equal(comparison[2].period_a.clicks, 0);
  assert.equal(comparison[2].period_b.clicks, 80);
  assert.equal(comparison[2].diff.clicks, -80);
  assert.equal(comparison[2].diff.clicks_percentage, -100);
});



