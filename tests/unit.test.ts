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
  assertDateNotInFuture,
  assertDateRange,
  getSearchConsoleCalendarDate,
  SEARCH_CONSOLE_DATE_SCHEMA,
  SEARCH_CONSOLE_TIME_ZONE,
  searchConsoleDateDescription,
} from '../src/date-validation';
import { CONTENT_DECAY_COMPARE_DAYS_SCHEMA } from '../src/content-decay-schema';
import { resolveWeeklyDigestEndDate } from '../src/digest';
import { resolveIndexedPagesDateRange } from '../src/indexed-pages-range';
import { createQuickWinsInputSchema } from '../src/quick-wins-schema';
import { SITEMAP_URL_SCHEMA } from '../src/sitemap-url-schema';
import { URL_INSPECTION_LANGUAGE_CODE_SCHEMA } from '../src/url-inspection-language-schema';
import {
  classifySearchConsolePropertyIdentifier,
  SEARCH_CONSOLE_PROPERTY_SCHEMA,
} from '../src/search-console-property-schema';
import {
  CANNIBALIZATION_MIN_IMPRESSIONS_SCHEMA,
  CANNIBALIZATION_MIN_PAGE_PERCENTAGE_SCHEMA,
} from '../src/cannibalization-schema';
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  listSites,
  getSite,
  listSitemaps,
  inspectUrlsBoundedConcurrently,
  summarizeUrlInspectionIndexStatus,
  URL_INSPECTION_BATCH_CONCURRENCY,
  assertSearchAnalyticsQueryCompatible,
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
  requestIndexingRemoval,
  getIndexingNotificationMetadata,
  checkIndexingEligibility,
  processPerformanceComparison,
} from '../src/google';

// ---------------------------------------------------------------------------
// Helpers

test('Search Console date schema accepts valid calendar dates including leap day', () => {
  assert.equal(SEARCH_CONSOLE_DATE_SCHEMA.safeParse('2026-08-18').success, true);
  assert.equal(SEARCH_CONSOLE_DATE_SCHEMA.safeParse('2024-02-29').success, true);
});

test('Search Console date schema rejects malformed and impossible dates', () => {
  const invalidDates = ['2026-02-30', '2026-13-01', '2026-00-10', '2025-02-29', '2026-2-3'];
  for (const date of invalidDates) {
    assert.equal(SEARCH_CONSOLE_DATE_SCHEMA.safeParse(date).success, false, date);
  }
});

test('URL Inspection language schema accepts useful BCP-47 tags and defaults to en-US', () => {
  assert.equal(URL_INSPECTION_LANGUAGE_CODE_SCHEMA.parse(undefined), 'en-US');
  assert.equal(URL_INSPECTION_LANGUAGE_CODE_SCHEMA.safeParse('de-CH').success, true);
  assert.equal(URL_INSPECTION_LANGUAGE_CODE_SCHEMA.safeParse('zh-Hant-TW').success, true);
});

test('URL Inspection language schema rejects malformed language tags', () => {
  for (const languageCode of ['', 'en_US', 'not a tag', '123']) {
    assert.equal(
      URL_INSPECTION_LANGUAGE_CODE_SCHEMA.safeParse(languageCode).success,
      false,
      languageCode,
    );
  }
});

test('Search Console date ranges allow same-day queries and reject reversed ranges', () => {
  assert.doesNotThrow(() => assertDateRange('2026-08-18', '2026-08-18'));
  assert.throws(
    () => assertDateRange('2026-08-19', '2026-08-18'),
    /start_date must be on or before end_date/,
  );
});

test('sitemap URL schema accepts absolute HTTP and HTTPS URLs', () => {
  for (const url of [
    'http://example.com/sitemap.xml',
    'https://example.com/sitemaps/news.xml?part=1',
  ]) {
    assert.equal(SITEMAP_URL_SCHEMA.safeParse(url).success, true, url);
  }
});

test('sitemap URL schema rejects malformed, relative, and non-web URLs', () => {
  for (const url of [
    'sitemap.xml',
    'not a url',
    'ftp://example.com/sitemap.xml',
    'sc-domain:example.com',
  ]) {
    assert.equal(SITEMAP_URL_SCHEMA.safeParse(url).success, false, url);
  }
});

test('Search Console property schema accepts documented Domain and URL-prefix forms', () => {
  for (const property of [
    'sc-domain:example.com',
    'sc-domain:sub.example.co.uk',
    'https://www.example.com/',
    'http://example.com/blog/',
    'https://example.com',
  ]) {
    assert.equal(SEARCH_CONSOLE_PROPERTY_SCHEMA.safeParse(property).success, true, property);
  }
});

test('Search Console property schema rejects malformed and unsupported identifiers', () => {
  for (const property of [
    '',
    'example.com',
    '/relative/path/',
    'ftp://example.com/',
    'https://user:pass@example.com/',
    ' sc-domain:example.com',
    'sc-domain:',
    'sc-domain:https://example.com',
    'sc-domain:example.com/path',
    'sc-domain:example.com:443',
  ]) {
    assert.equal(SEARCH_CONSOLE_PROPERTY_SCHEMA.safeParse(property).success, false, property);
  }
});

test('Search Console property classifier distinguishes documented API forms without guessing platform-property identifiers', () => {
  assert.equal(classifySearchConsolePropertyIdentifier('sc-domain:example.com'), 'domain');
  assert.equal(
    classifySearchConsolePropertyIdentifier('https://www.example.com/blog/'),
    'url_prefix',
  );
  assert.equal(
    classifySearchConsolePropertyIdentifier('instagram.com/example_creator'),
    'undocumented',
  );
  assert.equal(
    SEARCH_CONSOLE_PROPERTY_SCHEMA.safeParse('instagram.com/example_creator').success,
    false,
  );
});

test('Search Console calendar dates use Pacific Time instead of UTC', () => {
  assert.equal(SEARCH_CONSOLE_TIME_ZONE, 'America/Los_Angeles');
  assert.match(
    searchConsoleDateDescription('Start date (inclusive) in YYYY-MM-DD format.'),
    /Pacific Time \(America\/Los_Angeles; UTC-8\/UTC-7 depending on daylight saving time\)/,
  );
  assert.equal(
    getSearchConsoleCalendarDate(new Date('2026-09-20T06:59:59Z')),
    '2026-09-19',
  );
  assert.equal(
    getSearchConsoleCalendarDate(new Date('2026-09-20T07:00:00Z')),
    '2026-09-20',
  );
});

test('weekly digest end dates reject invalid dates and future dates', () => {
  assert.equal(SEARCH_CONSOLE_DATE_SCHEMA.safeParse('2026-02-30').success, false);
  assert.throws(
    () => assertDateNotInFuture('2026-08-19', '2026-08-18'),
    /End date must be today or earlier/,
  );
});

test('weekly digest defaults to the latest usually-complete Search Console date', () => {
  assert.equal(resolveWeeklyDigestEndDate(undefined, '2026-09-20'), '2026-09-17');
  assert.equal(resolveWeeklyDigestEndDate(undefined, '2026-03-02'), '2026-02-27');
  assert.equal(resolveWeeklyDigestEndDate('2026-09-19', '2026-09-20'), '2026-09-19');
});

test('content decay comparison days must be positive and default to 30', () => {
  assert.deepEqual(CONTENT_DECAY_COMPARE_DAYS_SCHEMA.safeParse(1), {
    success: true,
    data: 1,
  });
  assert.equal(CONTENT_DECAY_COMPARE_DAYS_SCHEMA.safeParse(0).success, false);
  assert.equal(CONTENT_DECAY_COMPARE_DAYS_SCHEMA.safeParse(-1).success, false);
  assert.deepEqual(CONTENT_DECAY_COMPARE_DAYS_SCHEMA.safeParse(undefined), {
    success: true,
    data: 30,
  });
});

test('indexed page ranges default to the existing 30-day window ending three days ago', () => {
  assert.deepEqual(
    resolveIndexedPagesDateRange(undefined, undefined, '2026-01-15'),
    { startDate: '2025-12-14', endDate: '2026-01-12' },
  );
});

test('indexed page ranges anchor a missing start date to the supplied end date', () => {
  assert.deepEqual(
    resolveIndexedPagesDateRange(undefined, '2026-01-05', '2026-01-15'),
    { startDate: '2025-12-07', endDate: '2026-01-05' },
  );
});

test('indexed page ranges anchor a missing end date to the supplied start date and cap it', () => {
  assert.deepEqual(
    resolveIndexedPagesDateRange('2025-12-20', undefined, '2026-01-31'),
    { startDate: '2025-12-20', endDate: '2026-01-18' },
  );
  assert.deepEqual(
    resolveIndexedPagesDateRange('2026-01-10', undefined, '2026-01-20'),
    { startDate: '2026-01-10', endDate: '2026-01-17' },
  );
  assert.throws(
    () => resolveIndexedPagesDateRange('2026-01-18', undefined, '2026-01-20'),
    /generated end_date cannot be later than the latest complete date/,
  );
});

test('indexed page ranges preserve both supplied boundaries', () => {
  assert.deepEqual(
    resolveIndexedPagesDateRange('2025-12-31', '2026-01-02', '2026-01-15'),
    { startDate: '2025-12-31', endDate: '2026-01-02' },
  );
});

test('cannibalization percentage is constrained to 0 through 100', () => {
  for (const percentage of [0, 10, 100]) {
    assert.equal(CANNIBALIZATION_MIN_PAGE_PERCENTAGE_SCHEMA.safeParse(percentage).success, true);
  }
  assert.equal(CANNIBALIZATION_MIN_PAGE_PERCENTAGE_SCHEMA.safeParse(-0.1).success, false);
  assert.equal(CANNIBALIZATION_MIN_PAGE_PERCENTAGE_SCHEMA.safeParse(100.1).success, false);
  assert.deepEqual(CANNIBALIZATION_MIN_PAGE_PERCENTAGE_SCHEMA.safeParse(undefined), {
    success: true,
    data: 10,
  });
});

test('cannibalization minimum impressions cannot be negative', () => {
  assert.equal(CANNIBALIZATION_MIN_IMPRESSIONS_SCHEMA.safeParse(0).success, true);
  assert.equal(CANNIBALIZATION_MIN_IMPRESSIONS_SCHEMA.safeParse(-1).success, false);
  assert.deepEqual(CANNIBALIZATION_MIN_IMPRESSIONS_SCHEMA.safeParse(undefined), {
    success: true,
    data: 50,
  });
});

test('quick win thresholds require valid impressions and position ranges', () => {
  const schema = createQuickWinsInputSchema();
  const baseInput = {
    site_url: 'sc-domain:example.com',
    start_date: '2026-01-01',
    end_date: '2026-01-31',
  };

  assert.equal(
    schema.safeParse({
      ...baseInput,
      min_impressions: 0,
      min_position: 0.5,
      max_position: 0.5,
    }).success,
    true,
  );
  assert.equal(schema.safeParse({ ...baseInput, min_impressions: -1 }).success, false);
  assert.equal(schema.safeParse({ ...baseInput, min_position: 0 }).success, false);
  assert.equal(schema.safeParse({ ...baseInput, max_position: -0.1 }).success, false);
  assert.equal(
    schema.safeParse({ ...baseInput, min_position: 20, max_position: 8 }).success,
    false,
  );

  const defaulted = schema.parse(baseInput);
  assert.equal(defaulted.min_impressions, 100);
  assert.equal(defaulted.min_position, 8);
  assert.equal(defaulted.max_position, 20);
});

function makeKey(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
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

function html(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

function jobPostingPageHtml(): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Senior Engineer',
  })}</script></head><body></body></html>`;
}

function broadcastVideoPageHtml(): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: 'Live event',
    publication: {
      '@type': 'BroadcastEvent',
      isLiveBroadcast: true,
    },
  })}</script></head><body></body></html>`;
}

function ordinaryPageHtml(): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: 'Just a blog post',
  })}</script></head><body></body></html>`;
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

test('crypto: rejects AES keys that are not exactly 256 bits', async () => {
  for (const byteLength of [16, 24, 31, 33]) {
    await assert.rejects(
      () => encryptToken('secret', makeKey(byteLength)),
      /Invalid TOKEN_ENCRYPTION_KEY configuration: expected a valid base64-encoded 32-byte \(256-bit\) AES key\./,
    );
  }
});

test('crypto: rejects malformed TOKEN_ENCRYPTION_KEY base64 without exposing it', async () => {
  const malformedKey = 'not valid base64!';
  await assert.rejects(
    () => encryptToken('secret', malformedKey),
    (error: Error) => {
      assert.equal(
        error.message,
        'Invalid TOKEN_ENCRYPTION_KEY configuration: expected a valid base64-encoded 32-byte (256-bit) AES key.',
      );
      assert.equal(error.message.includes(malformedKey), false);
      return true;
    },
  );
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
  const original = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response('', { status: 401 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      listSites('expired-token'),
      new RegExp(GSC_ACCESS_REVOKED_MESSAGE.slice(0, 22)),
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls.length, 1);
});

test('listSites: retries transient Google read failures and then succeeds', async () => {
  let attempts = 0;
  const { result, calls } = await withMockFetch(
    () => {
      attempts += 1;
      if (attempts < 3) {
        return new Response('temporarily unavailable', {
          status: 503,
          headers: { 'retry-after': '0' },
        });
      }
      return json(200, { siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] });
    },
    () => listSites('at'),
  );

  assert.equal(calls.length, 3);
  assert.deepEqual(result, [
    { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
  ]);
});

test('listSites: retries documented transient Search Console 403 rate limits', async () => {
  let attempts = 0;
  const { result, calls } = await withMockFetch(
    () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: 403,
              message: 'User Rate Limit Exceeded',
              errors: [
                {
                  domain: 'usageLimits',
                  reason: 'userRateLimitExceeded',
                  message: 'User Rate Limit Exceeded',
                },
              ],
            },
          }),
          {
            status: 403,
            headers: {
              'content-type': 'application/json',
              'retry-after': '0',
            },
          },
        );
      }
      return json(200, {
        siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }],
      });
    },
    () => listSites('at'),
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(result, [
    { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
  ]);
});

test('listSites: does not retry non-transient Google 403 permission errors', async () => {
  const original = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(
      JSON.stringify({
        error: {
          code: 403,
          message: 'Insufficient Permission',
          errors: [
            {
              domain: 'global',
              reason: 'insufficientPermissions',
              message: 'Insufficient Permission',
            },
          ],
        },
      }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    await assert.rejects(
      listSites('at'),
      /List sites failed: 403/,
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls.length, 1);
});

test('listSites: does not retry when Retry-After exceeds the MCP retry budget', async () => {
  const original = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response('quota wait', {
      status: 429,
      headers: { 'retry-after': '60' },
    });
  }) as typeof fetch;
  try {
    await assert.rejects(
      listSites('at'),
      /List sites failed: 429 quota wait/,
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls.length, 1);
});

test('addSite: transient write failures are not retried automatically', async () => {
  const original = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response('temporary failure', { status: 503 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      addSite('at', 'https://example.com/'),
      /Add site failed: 503 temporary failure/,
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls.length, 1);
});

test('listSites: empty account returns [] (not undefined)', async () => {
  const { result } = await withMockFetch(
    () => json(200, {}),
    () => listSites('at'),
  );
  assert.deepEqual(result, []);
});

test('getSite: percent-encodes the exact property and returns its permission level', async () => {
  const site = {
    siteUrl: 'sc-domain:example.com',
    permissionLevel: 'siteOwner',
  };
  const { result, calls } = await withMockFetch(
    () => json(200, site),
    () => getSite('at', 'sc-domain:example.com'),
  );
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].url.endsWith('/sites/sc-domain%3Aexample.com'),
    `URL not encoded: ${calls[0].url}`,
  );
  assert.deepEqual(result, site);
});

test('inspectUrlsBoundedConcurrently: preserves input order and returns per-URL failures', async () => {
  const { result, calls } = await withMockFetch(
    (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.inspectionUrl.endsWith('/bad')) {
        return new Response('invalid request', { status: 400 });
      }
      return json(200, {
        inspectionResult: { indexStatusResult: { verdict: 'PASS' } },
      });
    },
    () =>
      inspectUrlsBoundedConcurrently(
        'at',
        'https://example.com/',
        ['https://example.com/good', 'https://example.com/bad'],
        'en-US',
      ),
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(result, [
    {
      inspectionUrl: 'https://example.com/good',
      inspectionResult: { indexStatusResult: { verdict: 'PASS' } },
    },
    {
      inspectionUrl: 'https://example.com/bad',
      error: 'URL inspection failed: 400 invalid request',
    },
  ]);
});

test('summarizeUrlInspectionIndexStatus: exposes provider index-state evidence without changing the raw result', () => {
  const inspectionResult = {
    indexStatusResult: {
      verdict: 'PASS',
      coverageState: 'Submitted and indexed',
      robotsTxtState: 'ALLOWED',
      indexingState: 'INDEXING_ALLOWED',
      lastCrawlTime: '2026-09-23T20:15:30Z',
      pageFetchState: 'SUCCESSFUL',
      googleCanonical: 'https://example.com/page',
      userCanonical: 'https://example.com/page',
      crawledAs: 'MOBILE',
    },
  };

  assert.deepEqual(summarizeUrlInspectionIndexStatus(inspectionResult), {
    indexed_state: 'indexed',
    verdict: 'PASS',
    coverage_state: 'Submitted and indexed',
    robots_txt_state: 'ALLOWED',
    indexing_state: 'INDEXING_ALLOWED',
    last_crawl_time: '2026-09-23T20:15:30Z',
    page_fetch_state: 'SUCCESSFUL',
    google_canonical: 'https://example.com/page',
    user_canonical: 'https://example.com/page',
    crawled_as: 'MOBILE',
  });
  assert.equal(inspectionResult.indexStatusResult.verdict, 'PASS');
});

test('summarizeUrlInspectionIndexStatus: treats excluded/error verdicts as not indexed and unknown provider states conservatively', () => {
  assert.deepEqual(
    summarizeUrlInspectionIndexStatus({ indexStatusResult: { verdict: 'NEUTRAL' } }),
    { indexed_state: 'not_indexed', verdict: 'NEUTRAL' },
  );
  assert.deepEqual(
    summarizeUrlInspectionIndexStatus({ indexStatusResult: { verdict: 'FAIL' } }),
    { indexed_state: 'not_indexed', verdict: 'FAIL' },
  );
  assert.deepEqual(
    summarizeUrlInspectionIndexStatus({ indexStatusResult: { verdict: 'PARTIAL' } }),
    { indexed_state: 'unknown', verdict: 'PARTIAL' },
  );
  assert.deepEqual(summarizeUrlInspectionIndexStatus(null), { indexed_state: 'unknown' });
});

test('inspectUrlsBoundedConcurrently: caps in-flight inspections at three', async () => {
  let active = 0;
  let maxActive = 0;
  const urls = Array.from({ length: 7 }, (_, index) => `https://example.com/${index + 1}`);

  const { result, calls } = await withMockFetch(
    async (_url, init) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      const body = JSON.parse(String(init?.body));
      return json(200, { inspectionResult: { inspected: body.inspectionUrl } });
    },
    () => inspectUrlsBoundedConcurrently('at', 'https://example.com/', urls, 'en-US'),
  );

  assert.equal(URL_INSPECTION_BATCH_CONCURRENCY, 3);
  assert.equal(calls.length, urls.length);
  assert.equal(maxActive, URL_INSPECTION_BATCH_CONCURRENCY);
  assert.deepEqual(
    result.map((entry) => entry.inspectionUrl),
    urls,
  );
});

test('querySearchAnalytics: retries a transient 429 and preserves the POST body', async () => {
  let attempts = 0;
  const { result, calls } = await withMockFetch(
    (_url, init) => {
      attempts += 1;
      if (attempts === 1) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': '0' },
        });
      }
      return json(200, {
        rows: [{ keys: ['retry-safe'], clicks: 1, impressions: 10, ctr: 0.1, position: 3 }],
      });
    },
    () =>
      querySearchAnalytics('at', 'https://example.com/', {
        startDate: '2026-09-01',
        endDate: '2026-09-07',
        dimensions: ['query'],
        rowLimit: 100,
      }),
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[1].init?.body, calls[0].init?.body);
  assert.deepEqual(result.rows[0]?.keys, ['retry-safe']);
});

test('inspectUrlsBoundedConcurrently: access revocation prevents later chunks from starting', async () => {
  const urls = [
    'https://example.com/a',
    'https://example.com/b',
    'https://example.com/c',
    'https://example.com/d',
    'https://example.com/e',
  ];
  const original = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const body = JSON.parse(String(init?.body));
    return body.inspectionUrl.endsWith('/a')
      ? new Response('', { status: 401 })
      : json(200, { inspectionResult: { inspected: body.inspectionUrl } });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => inspectUrlsBoundedConcurrently('expired-token', 'https://example.com/', urls),
      new RegExp(GSC_ACCESS_REVOKED_MESSAGE.slice(0, 22)),
    );
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(calls.length, URL_INSPECTION_BATCH_CONCURRENCY);
  assert.deepEqual(
    calls.map((call) => JSON.parse(String(call.init?.body)).inspectionUrl),
    urls.slice(0, URL_INSPECTION_BATCH_CONCURRENCY),
  );
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

test('listSitemaps: forwards an optional sitemap index filter', async () => {
  const { calls } = await withMockFetch(
    () => json(200, { sitemap: [] }),
    () =>
      listSitemaps(
        'at',
        'https://example.com/',
        'https://example.com/sitemap-index.xml',
      ),
  );
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(
    url.searchParams.get('sitemapIndex'),
    'https://example.com/sitemap-index.xml',
  );
});

test('listSitemaps: omits Google\'s deprecated indexed count', async () => {
  const { result } = await withMockFetch(
    () =>
      json(200, {
        sitemap: [
          {
            path: 'https://example.com/sitemap.xml',
            contents: [{ type: 'web', submitted: '121', indexed: '0' }],
          },
        ],
      }),
    () => listSitemaps('at', 'https://example.com/'),
  );
  assert.deepEqual(result, [
    {
      path: 'https://example.com/sitemap.xml',
      contents: [{ type: 'web', submitted: '121' }],
    },
  ]);
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
  assert.deepEqual(result, { rows });
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

test('querySearchAnalytics: forwards hourly Search Analytics parameters', async () => {
  const { calls } = await withMockFetch(
    () => json(200, { rows: [] }),
    () =>
      querySearchAnalytics('at', 'https://example.com/', {
        startDate: '2026-05-31',
        endDate: '2026-05-31',
        dimensions: ['hour'],
        rowLimit: 100,
        dataState: 'hourly_all',
      }),
  );

  const body = JSON.parse(String(calls[0].init?.body));
  assert.deepEqual(body.dimensions, ['hour']);
  assert.equal(body.dataState, 'hourly_all');
});

test('querySearchAnalytics: forwards News Showcase panel aggregation parameters', async () => {
  const { calls } = await withMockFetch(
    () => json(200, { rows: [] }),
    () =>
      querySearchAnalytics('at', 'https://example.com/', {
        startDate: '2026-05-01',
        endDate: '2026-05-31',
        dimensions: ['country'],
        rowLimit: 100,
        type: 'googleNews',
        aggregationType: 'byNewsShowcasePanel',
        dimensionFilterGroups: [
          {
            groupType: 'and',
            filters: [
              {
                dimension: 'searchAppearance',
                operator: 'equals',
                expression: 'NEWS_SHOWCASE',
              },
            ],
          },
        ],
      }),
  );

  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.type, 'googleNews');
  assert.equal(body.aggregationType, 'byNewsShowcasePanel');
  assert.deepEqual(body.dimensionFilterGroups, [
    {
      groupType: 'and',
      filters: [
        {
          dimension: 'searchAppearance',
          operator: 'equals',
          expression: 'NEWS_SHOWCASE',
        },
      ],
    },
  ]);
});

test('querySearchAnalytics: rejects byPage page grouping before calling Google', async () => {
  const { calls } = await withMockFetch(
    () => json(200, { rows: [] }),
    async () => {
      await assert.rejects(
        () =>
          querySearchAnalytics('at', 'https://example.com/', {
            startDate: '2026-05-01',
            endDate: '2026-05-31',
            dimensions: ['page'],
            rowLimit: 100,
            type: 'web',
            aggregationType: 'byPage',
          }),
        /byPage cannot be combined with page grouping or filtering; use auto instead/,
      );
    },
  );

  assert.equal(calls.length, 0);
});

test('Search Analytics request validation rejects documented invalid cross-field combinations', () => {
  const base = {
    startDate: '2026-05-01',
    endDate: '2026-05-31',
    dimensions: ['query'] as const,
    rowLimit: 100,
    type: 'web' as const,
    aggregationType: 'auto' as const,
  };

  assert.throws(
    () => assertSearchAnalyticsQueryCompatible({ ...base, dimensions: ['query', 'query'] }),
    /dimensions must not contain duplicates/,
  );
  assert.throws(
    () =>
      assertSearchAnalyticsQueryCompatible({
        ...base,
        dimensions: ['searchAppearance', 'page'],
      }),
    /searchAppearance must be the only grouping dimension/,
  );
  assert.throws(
    () =>
      assertSearchAnalyticsQueryCompatible({
        ...base,
        dimensions: ['page'],
        aggregationType: 'byProperty',
      }),
    /byProperty cannot be combined with page grouping or filtering/,
  );
  assert.throws(
    () =>
      assertSearchAnalyticsQueryCompatible({
        ...base,
        dimensions: ['page'],
        aggregationType: 'byPage',
      }),
    /byPage cannot be combined with page grouping or filtering; use auto instead/,
  );
  assert.throws(
    () =>
      assertSearchAnalyticsQueryCompatible({
        ...base,
        dimensions: ['country'],
        aggregationType: 'byPage',
        dimensionFilterGroups: [
          {
            groupType: 'and',
            filters: [
              {
                dimension: 'page',
                operator: 'equals',
                expression: 'https://example.com/a',
              },
            ],
          },
        ],
      }),
    /byPage cannot be combined with page grouping or filtering; use auto instead/,
  );
  assert.doesNotThrow(() =>
    assertSearchAnalyticsQueryCompatible({
      ...base,
      dimensions: ['country'],
      aggregationType: 'byPage',
    }),
  );
  assert.throws(
    () =>
      assertSearchAnalyticsQueryCompatible({
        ...base,
        type: 'discover',
        aggregationType: 'byProperty',
      }),
    /byProperty is not supported for discover or googleNews/,
  );
  assert.throws(
    () =>
      assertSearchAnalyticsQueryCompatible({
        ...base,
        type: 'discover',
      }),
    /Discover does not support the query dimension or query filters/,
  );
  assert.throws(
    () =>
      assertSearchAnalyticsQueryCompatible({
        ...base,
        type: 'googleNews',
      }),
    /Google News does not support the query dimension or query filters/,
  );
  assert.throws(
    () =>
      assertSearchAnalyticsQueryCompatible({
        ...base,
        dimensions: ['page'],
        type: 'googleNews',
        dimensionFilterGroups: [
          {
            groupType: 'and',
            filters: [
              {
                dimension: 'query',
                operator: 'contains',
                expression: 'seo',
              },
            ],
          },
        ],
      }),
    /Google News does not support the query dimension or query filters/,
  );
  assert.throws(
    () =>
      assertSearchAnalyticsQueryCompatible({
        ...base,
        dimensions: ['page'],
        type: 'discover',
        dimensionFilterGroups: [
          {
            groupType: 'and',
            filters: [
              {
                dimension: 'query',
                operator: 'contains',
                expression: 'seo',
              },
            ],
          },
        ],
      }),
    /Discover does not support the query dimension or query filters/,
  );
  assert.throws(
    () =>
      assertSearchAnalyticsQueryCompatible({
        ...base,
        type: 'web',
        aggregationType: 'byNewsShowcasePanel',
      }),
    /byNewsShowcasePanel requires type discover or googleNews/,
  );
  assert.throws(
    () =>
      assertSearchAnalyticsQueryCompatible({
        ...base,
        dimensions: ['country'],
        type: 'googleNews',
        aggregationType: 'byNewsShowcasePanel',
        dimensionFilterGroups: [
          {
            groupType: 'and',
            filters: [
              {
                dimension: 'searchAppearance',
                operator: 'equals',
                expression: 'OTHER_FEATURE',
              },
            ],
          },
        ],
      }),
    /requires exactly the NEWS_SHOWCASE searchAppearance filter/,
  );
  assert.throws(
    () =>
      assertSearchAnalyticsQueryCompatible({
        ...base,
        dimensionFilterGroups: [
          {
            groupType: 'and',
            filters: [
              {
                dimension: 'query',
                operator: 'equals',
                expression: 'x'.repeat(4097),
              },
            ],
          },
        ],
      }),
    /filter expressions must be at most 4096 characters/,
  );
  assert.throws(
    () =>
      assertSearchAnalyticsQueryCompatible({
        ...base,
        dimensionFilterGroups: [
          {
            groupType: 'and',
            filters: [
              {
                dimension: 'country',
                operator: 'equals',
                expression: 'us',
              },
            ],
          },
        ],
      }),
    /exact country filters must use a three-letter ISO 3166-1 alpha-3 code/,
  );
  assert.throws(
    () =>
      assertSearchAnalyticsQueryCompatible({
        ...base,
        dimensionFilterGroups: [
          {
            groupType: 'and',
            filters: [
              {
                dimension: 'device',
                operator: 'notEquals',
                expression: 'PHONE',
              },
            ],
          },
        ],
      }),
    /exact device filters must use DESKTOP, MOBILE, or TABLET/,
  );
  assert.doesNotThrow(() =>
    assertSearchAnalyticsQueryCompatible({
      ...base,
      dimensionFilterGroups: [
        {
          groupType: 'and',
          filters: [
            { dimension: 'country', operator: 'equals', expression: 'usa' },
            { dimension: 'device', operator: 'equals', expression: 'mobile' },
            {
              dimension: 'device',
              operator: 'includingRegex',
              expression: 'MOB.*',
            },
          ],
        },
      ],
    }),
  );
  assert.throws(
    () =>
      assertSearchAnalyticsQueryCompatible({
        ...base,
        dimensions: ['hour'],
        dataState: 'all',
      }),
    /hour dimension requires dataState hourly_all/,
  );
  assert.throws(
    () =>
      assertSearchAnalyticsQueryCompatible({
        ...base,
        startDate: '2026-05-01',
        endDate: '2026-05-11',
        dimensions: ['hour'],
        dataState: 'hourly_all',
      }),
    /hourly queries support at most 10 inclusive calendar days/,
  );
});

test('Search Analytics request validation leaves hourly_all usable without hour grouping', () => {
  assert.doesNotThrow(() =>
    assertSearchAnalyticsQueryCompatible({
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      dimensions: ['page'],
      rowLimit: 100,
      dataState: 'hourly_all',
      type: 'web',
      aggregationType: 'auto',
    }),
  );
});

test('Search Analytics request validation accepts a ten-day hourly window', () => {
  assert.doesNotThrow(() =>
    assertSearchAnalyticsQueryCompatible({
      startDate: '2026-05-01',
      endDate: '2026-05-10',
      dimensions: ['hour', 'page'],
      rowLimit: 100,
      dataState: 'hourly_all',
      type: 'web',
      aggregationType: 'auto',
    }),
  );
});

test('Search Analytics request validation permits non-query Discover dimensions', () => {
  assert.doesNotThrow(() =>
    assertSearchAnalyticsQueryCompatible({
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      dimensions: ['page', 'country'],
      rowLimit: 100,
      type: 'discover',
      aggregationType: 'auto',
    }),
  );
});

test('Search Analytics request validation permits supported Google News dimensions', () => {
  assert.doesNotThrow(() =>
    assertSearchAnalyticsQueryCompatible({
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      dimensions: ['page', 'country', 'device'],
      rowLimit: 100,
      type: 'googleNews',
      aggregationType: 'auto',
    }),
  );
});

test('Search Analytics request validation accepts searchAppearance discovery and filtered breakdowns', () => {
  assert.doesNotThrow(() =>
    assertSearchAnalyticsQueryCompatible({
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      dimensions: ['searchAppearance'],
      rowLimit: 100,
      type: 'web',
      aggregationType: 'auto',
    }),
  );

  assert.doesNotThrow(() =>
    assertSearchAnalyticsQueryCompatible({
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      dimensions: ['page'],
      rowLimit: 100,
      type: 'web',
      aggregationType: 'auto',
      dimensionFilterGroups: [
        {
          groupType: 'and',
          filters: [
            {
              dimension: 'searchAppearance',
              operator: 'equals',
              expression: 'AMP_BLUE_LINK',
            },
          ],
        },
      ],
    }),
  );
});

test('Search Analytics request validation accepts a valid News Showcase panel request', () => {
  assert.doesNotThrow(() =>
    assertSearchAnalyticsQueryCompatible({
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      dimensions: ['country'],
      rowLimit: 100,
      type: 'googleNews',
      aggregationType: 'byNewsShowcasePanel',
      dimensionFilterGroups: [
        {
          groupType: 'and',
          filters: [
            {
              dimension: 'searchAppearance',
              operator: 'equals',
              expression: 'NEWS_SHOWCASE',
            },
          ],
        },
      ],
    }),
  );
});

test('querySearchAnalytics: gives actionable guidance for non-retryable Search Analytics load quota exhaustion', async () => {
  const { calls } = await withMockFetch(
    () =>
      json(403, {
        error: {
          code: 403,
          message: 'Quota exceeded for quota metric SearchAnalyticsLoad',
          errors: [
            {
              domain: 'usageLimits',
              reason: 'quotaExceeded',
              message: 'Quota exceeded',
            },
          ],
        },
      }),
    async () => {
      await assert.rejects(
        querySearchAnalytics('at', 'sc-domain:example.com', {
          startDate: '2026-05-01',
          endDate: '2026-05-31',
          dimensions: ['query', 'page'],
          rowLimit: 100,
        }),
        (error: Error) => {
          assert.match(error.message, /load quota exceeded/i);
          assert.match(error.message, /15 minutes/i);
          assert.match(error.message, /page\/query grouping or filtering/i);
          assert.match(error.message, /shorten the date range/i);
          return true;
        },
      );
    },
  );

  assert.equal(calls.length, 1, 'quotaExceeded should not use the short transient retry loop');
});

test('querySearchAnalytics: missing rows field returns an empty rows array (no data, not an error)', async () => {
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
  assert.deepEqual(result, { rows: [] });
});

test('querySearchAnalytics: aggregate rows may omit dimension keys', async () => {
  const aggregateRow = {
    clicks: 73,
    impressions: 121404,
    ctr: 0.000601,
    position: 58.36,
  };
  const { result } = await withMockFetch(
    () => json(200, { rows: [aggregateRow] }),
    () =>
      querySearchAnalytics('at', 'sc-domain:example.com', {
        startDate: '2026-08-22',
        endDate: '2026-09-18',
        dimensions: [],
        rowLimit: 1,
      }),
  );
  assert.deepEqual(result, { rows: [aggregateRow] });
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

test('getSitemap: omits Google\'s deprecated indexed count', async () => {
  const { result } = await withMockFetch(
    () =>
      json(200, {
        path: 'https://example.com/sitemap.xml',
        contents: [{ type: 'web', submitted: '121', indexed: '0' }],
      }),
    () => getSitemap('at', 'https://example.com/', 'https://example.com/sitemap.xml'),
  );
  assert.deepEqual(result, {
    path: 'https://example.com/sitemap.xml',
    contents: [{ type: 'web', submitted: '121' }],
  });
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
  assert.equal(candidates[0].aggregation_scope, 'observed_query_page_rows');
  assert.equal(candidates[0].total_clicks, 15);
  assert.equal(candidates[0].total_impressions, 200);
  assert.equal(candidates[0].pages[0].impression_share, 50);
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
  assert.equal(decay[0].classification, 'likely_decay');
  assert.equal(decay[0].click_difference, -50);
  assert.equal(decay[0].click_decay_percentage, 50); // (50 drop / 100 prev) * 100
  
  assert.equal(decay[1].page, 'page3');
  assert.equal(decay[1].classification, 'weak_insufficient_evidence');
  assert.equal(decay[1].click_difference, -10);
  assert.equal(decay[1].click_decay_percentage, 11.1); // (10 drop / 90 prev) * 100
});

test('processContentDecay: improving visibility prevents a tiny low-volume click drop from becoming decay', () => {
  const recentRows = [
    {
      keys: ['https://digestseo.com/top-websites/'],
      clicks: 1,
      impressions: 52339,
      ctr: 0.000019106211429335678,
      position: 56.00534973920021,
    },
  ];
  const previousRows = [
    {
      keys: ['https://digestseo.com/top-websites/'],
      clicks: 3,
      impressions: 44978,
      ctr: 0.00006669927520120948,
      position: 64.86513406554315,
    },
  ];

  const [assessment] = processContentDecay(recentRows, previousRows);
  assert.equal(
    assessment.classification,
    'improving_visibility_with_click_volatility',
  );
  assert.equal(assessment.click_difference, -2);
  assert.equal(assessment.impression_difference, 7361);
  assert.equal(assessment.impression_change_percentage, 16.4);
  assert.equal(assessment.position_change, -8.9);
  assert.match(assessment.evidence, /small in absolute terms/i);
});

test('processContentDecay: ignores pages missing from one Search Analytics period instead of fabricating zero traffic', () => {
  const decay = processContentDecay(
    [],
    [
      {
        keys: ['https://example.com/previous-only/'],
        clicks: 100,
        impressions: 2000,
        ctr: 0.05,
        position: 5,
      },
    ],
  );

  assert.deepEqual(decay, []);
});

test('requestIndexing: sends POST request to the correct indexing endpoint for an eligible JobPosting URL', async () => {
  const mockResult = {
    urlNotificationMetadata: {
      latestNotification: {
        url: 'https://example.com/careers/senior-engineer',
        type: 'URL_UPDATED',
        notifyTime: '2026-07-01T12:00:00Z',
      },
    },
  };
  const { result, calls } = await withMockFetch(
    (url) =>
      url === 'https://indexing.googleapis.com/v3/urlNotifications:publish'
        ? json(200, mockResult)
        : html(200, jobPostingPageHtml()),
    () => requestIndexing('at', 'https://example.com/careers/senior-engineer'),
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init?.method, 'POST');
  assert.equal(calls[1].url, 'https://indexing.googleapis.com/v3/urlNotifications:publish');
  assert.deepEqual(JSON.parse(calls[1].init?.body as string), {
    url: 'https://example.com/careers/senior-engineer',
    type: 'URL_UPDATED',
  });
  assert.deepEqual(result, mockResult);
});

test('getIndexingNotificationMetadata: reads provider notification receipt metadata without fetching the page', async () => {
  const targetUrl = 'https://example.com/careers/senior-engineer?role=platform&level=senior';
  const mockResult = {
    url: targetUrl,
    latestUpdate: {
      url: targetUrl,
      type: 'URL_UPDATED',
      notifyTime: '2026-09-22T07:30:00Z',
    },
  };
  const { result, calls } = await withMockFetch(
    () => json(200, mockResult),
    () => getIndexingNotificationMetadata('at', targetUrl),
  );

  assert.equal(calls.length, 1);
  const requestUrl = new URL(calls[0].url);
  assert.equal(
    `${requestUrl.origin}${requestUrl.pathname}`,
    'https://indexing.googleapis.com/v3/urlNotifications/metadata',
  );
  assert.equal(requestUrl.searchParams.get('url'), targetUrl);
  assert.equal(calls[0].init?.method, undefined);
  assert.deepEqual(result, mockResult);
});

test('requestIndexingRemoval: verifies removal readiness then publishes URL_DELETED', async () => {
  const targetUrl = 'https://example.com/careers/old-role';
  const mockResult = {
    urlNotificationMetadata: {
      latestRemove: {
        url: targetUrl,
        type: 'URL_DELETED',
        notifyTime: '2026-09-23T00:30:00Z',
      },
    },
  };
  const { result, calls } = await withMockFetch(
    (url) =>
      url === 'https://indexing.googleapis.com/v3/urlNotifications:publish'
        ? json(200, mockResult)
        : Promise.resolve(new Response('gone', { status: 410 })),
    () => requestIndexingRemoval('at', targetUrl),
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, targetUrl);
  assert.equal(calls[0].init?.redirect, 'manual');
  assert.equal(calls[1].url, 'https://indexing.googleapis.com/v3/urlNotifications:publish');
  assert.equal(calls[1].init?.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].init?.body as string), {
    url: targetUrl,
    type: 'URL_DELETED',
  });
  assert.deepEqual(result, mockResult);
});

test('requestIndexing: rejects an ineligible URL without calling the Indexing API', async () => {
  const { calls } = await withMockFetch(
    () => html(200, ordinaryPageHtml()),
    async () => {
      await assert.rejects(
        requestIndexing('at', 'https://example.com/blog/post'),
        /JobPosting|BroadcastEvent/,
      );
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.com/blog/post');
});

test('checkIndexingEligibility: JobPosting structured data is eligible', async () => {
  const { result } = await withMockFetch(
    () => html(200, jobPostingPageHtml()),
    () => checkIndexingEligibility('https://example.com/careers/senior-engineer'),
  );
  assert.deepEqual(result, { eligible: true });
});

test('checkIndexingEligibility: BroadcastEvent nested in VideoObject is eligible', async () => {
  const { result } = await withMockFetch(
    () => html(200, broadcastVideoPageHtml()),
    () => checkIndexingEligibility('https://example.com/live/event'),
  );
  assert.deepEqual(result, { eligible: true });
});

test('checkIndexingEligibility: an ordinary Article page is ineligible with an explanatory reason', async () => {
  const { result } = await withMockFetch(
    () => html(200, ordinaryPageHtml()),
    () => checkIndexingEligibility('https://example.com/blog/post'),
  );
  assert.equal(result.eligible, false);
  assert.match(result.reason ?? '', /JobPosting/);
  assert.match(result.reason ?? '', /BroadcastEvent/);
  assert.match(result.reason ?? '', /not available for general webpage submission/);
});

test('checkIndexingEligibility: an unreachable URL is ineligible rather than assumed eligible', async () => {
  const { result } = await withMockFetch(
    () => new Response('not found', { status: 404 }),
    () => checkIndexingEligibility('https://example.com/missing'),
  );
  assert.equal(result.eligible, false);
  assert.match(result.reason ?? '', /404/);
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
  assert.equal(comparison.length, 1);
  assert.deepEqual(comparison.map((row) => row.key), ['query1']);
  const byKey = new Map(comparison.map((row) => [row.key, row]));

  // query1: clicks A=120, B=100. diff = +20 (+20%)
  assert.equal(byKey.get('query1')!.period_a.clicks, 120);
  assert.equal(byKey.get('query1')!.period_b.clicks, 100);
  assert.equal(byKey.get('query1')!.diff.clicks, 20);
  assert.equal(byKey.get('query1')!.diff.clicks_percentage, 20);
  assert.equal(byKey.get('query1')!.diff.position, -1); // (2 - 3)
  assert.equal(byKey.has('query2'), false);
  assert.equal(byKey.has('query3'), false);
});



