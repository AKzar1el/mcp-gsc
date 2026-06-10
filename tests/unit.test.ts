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
  assert.ok(scope.includes('https://www.googleapis.com/auth/webmasters.readonly'));
  assert.ok(!scope.includes('webmasters '), 'must request the readonly scope only');
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
