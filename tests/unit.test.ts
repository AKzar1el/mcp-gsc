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
import { resolveWeeklyDigestEndDate, weeklyDigestAnalyticsRequestCount } from '../src/digest';
import { INDEXED_PAGES_START_ROW_SCHEMA, resolveIndexedPagesDateRange } from '../src/indexed-pages-range';
import { SEARCH_ANALYTICS_START_ROW_SCHEMA } from '../src/result-bounds';
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
  fetchGoogleUserInfo,
  refreshAccessToken,
  listSites,
  getSite,
  listSitemaps,
  inspectUrl,
  inspectUrlsSequentially,
  inspectUrlsBoundedConcurrently,
  summarizeUrlInspectionIndexStatus,
  URL_INSPECTION_BATCH_CONCURRENCY,
  assertSearchAnalyticsQueryCompatible,
  querySearchAnalytics,
  querySearchAnalyticsPaginated,
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
    'https://example.com/sitemaps/news%23part.xml',
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
    'https://user:password@example.com/sitemap.xml',
    'https://user@example.com/sitemap.xml',
    'https://example.com/sitemap.xml#section',
    'https://example.com/sitemap.xml#',
    'https://example.com/sitemap.xml?part=1#section',
  ]) {
    assert.equal(SITEMAP_URL_SCHEMA.safeParse(url).success, false, url);
  }
});

test('Search Console property schema accepts documented Domain and URL-prefix forms', () => {
  for (const property of [
    'sc-domain:example.com',
    'sc-domain:sub.example.co.uk',
    'sc-domain:xn--bcher-kva.example',
    'sc-domain:bücher.example',
    'sc-domain:example.com.',
    'https://www.example.com/',
    'http://example.com/blog/',
    'https://example.com',
    'https://example.com/blog%3Fsection/',
    'https://example.com/path%5Cencoded/',
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
    'sc-domain:.example.com',
    'sc-domain:example..com',
    'sc-domain:example.com..',
    'sc-domain:-example.com',
    'sc-domain:example-.com',
    'sc-domain:example.-com',
    'sc-domain:exa_mple.com',
    'sc-domain:exa%mple.com',
    `sc-domain:${'a'.repeat(64)}.example`,
    `sc-domain:${Array(5).fill('a'.repeat(51)).join('.')}`,
    'https://example.com/?utm_source=test',
    'https://example.com/blog/?page=2',
    'https://example.com/#section',
    'https://example.com/blog/#section',
    'https://example.com/?',
    'https://example.com/#',
    'https://example.com\\unsafe/path/',
    'https://example.com\\@other.test/',
  ]) {
    assert.equal(SEARCH_CONSOLE_PROPERTY_SCHEMA.safeParse(property).success, false, property);
  }
});

test('Search Console property classifier distinguishes documented API forms without guessing platform-property identifiers', () => {
  assert.equal(classifySearchConsolePropertyIdentifier('sc-domain:example.com'), 'domain');
  assert.equal(classifySearchConsolePropertyIdentifier('sc-domain:example..com'), 'undocumented');
  assert.equal(
    classifySearchConsolePropertyIdentifier('https://www.example.com/blog/'),
    'url_prefix',
  );
  assert.equal(
    classifySearchConsolePropertyIdentifier('https://example.com\\unsafe/path/'),
    'undocumented',
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
  assert.throws(
    () => assertDateNotInFuture('2026-08-19', '2026-08-18', 'end_date_a'),
    /end_date_a must be today or earlier.*2026-08-18/,
  );
});

test('weekly digest defaults to the latest usually-complete Search Console date', () => {
  assert.equal(resolveWeeklyDigestEndDate(undefined, '2026-09-20'), '2026-09-17');
  assert.equal(resolveWeeklyDigestEndDate(undefined, '2026-03-02'), '2026-02-27');
  assert.equal(resolveWeeklyDigestEndDate('2026-09-19', '2026-09-20'), '2026-09-19');
});

test('weekly digest reserves three preliminary or five finalized upstream requests', () => {
  const today = '2026-09-20';
  assert.equal(weeklyDigestAnalyticsRequestCount('2026-09-17', today), 5);
  assert.equal(weeklyDigestAnalyticsRequestCount('2026-09-18', today), 3);
  assert.equal(weeklyDigestAnalyticsRequestCount('2026-09-20', today), 3);
});

test('weekly digest ranks impression-only queries by net growth, not current impressions', async () => {
  const { generateWeeklyDigest } = await import('../src/digest');
  const queryRow = (query: string, impressions: number) => ({
    keys: [query],
    clicks: 0,
    impressions,
    ctr: 0,
    position: 12,
  });

  const { result: report } = await withMockFetch(
    (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        startDate: string;
        dimensions: string[];
      };
      const previousWeek = body.startDate === '2026-09-07';
      if (body.dimensions.length === 0) {
        return json(200, {
          rows: [{ clicks: 0, impressions: previousWeek ? 4 : 198, ctr: 0, position: 12 }],
        });
      }
      if (body.dimensions[0] === 'query') {
        return json(200, {
          rows: previousWeek
            ? [queryRow('gain-96', 4), queryRow('gain-98', 0)]
            : [queryRow('gain-96', 100), queryRow('gain-98', 98)],
        });
      }
      return json(200, { rows: [] });
    },
    () => generateWeeklyDigest(
      { getAccessToken: async () => 'mock-access-token' },
      'mock-user',
      'sc-domain:example.com',
      '2026-09-20',
    ),
  );

  const moversSection = report.split('### Queries gaining impressions without clicks')[1] ?? '';
  const higherGrowth = moversSection.indexOf('**"gain\\-98"**');
  const lowerGrowth = moversSection.indexOf('**"gain\\-96"**');
  assert.ok(higherGrowth >= 0 && lowerGrowth >= 0, 'both impression movers are reported');
  assert.ok(higherGrowth < lowerGrowth, '98 new impressions must rank ahead of 96');
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
  assert.throws(
    () => resolveIndexedPagesDateRange(undefined, '2026-01-16', '2026-01-15'),
    /end_date must be today or earlier/,
  );
  assert.throws(
    () => resolveIndexedPagesDateRange('2026-01-14', '2026-01-16', '2026-01-15'),
    /end_date must be today or earlier/,
  );
});

test('indexing.list_pages rejects out-of-range offsets at the input boundary before quota is reserved', () => {
  assert.equal(INDEXED_PAGES_START_ROW_SCHEMA, SEARCH_ANALYTICS_START_ROW_SCHEMA);
  for (const value of [0, 1, 2_147_483_647]) {
    assert.equal(INDEXED_PAGES_START_ROW_SCHEMA.safeParse(value).success, true);
  }
  for (const value of [-1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER, Infinity]) {
    assert.equal(INDEXED_PAGES_START_ROW_SCHEMA.safeParse(value).success, false);
  }
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

test('Google userinfo accepts a complete identity used for OAuth tenant binding', async () => {
  const profile = { id: 'google-account-123', email: 'user@example.com', verified_email: true };
  const { result } = await withMockFetch(
    () => json(200, profile),
    () => fetchGoogleUserInfo('access-token'),
  );
  assert.deepEqual(result, profile);
});

test('Google userinfo rejects missing or invalid account identity before KV binding', async () => {
  for (const profile of [
    {},
    { email: 'user@example.com' },
    { id: '', email: 'user@example.com' },
    { id: '   ', email: 'user@example.com' },
    { id: 123, email: 'user@example.com' },
    { id: 'google-account-123' },
    { id: 'google-account-123', email: ' ' },
    { id: 'google-account-123', email: 123 },
    null,
  ]) {
    await assert.rejects(
      withMockFetch(() => json(200, profile), () => fetchGoogleUserInfo('access-token')),
      /Google userinfo response missing a valid account ID or email/,
      JSON.stringify(profile),
    );
  }
});

test('exchangeCodeForTokens: rejects when Google omits refresh_token', async () => {
  await assert.rejects(
    withMockFetch(
      () => json(200, { access_token: 'at', expires_in: 3599, token_type: 'Bearer', scope: '' }),
      () => exchangeCodeForTokens('code', 'id', 'secret', 'https://x/cb'),
    ),
    /refresh_token/,
  );
});

test('exchangeCodeForTokens: preserves valid token exchange responses', async () => {
  const tokens = {
    access_token: 'valid-access', refresh_token: 'valid-refresh',
    expires_in: 3600, token_type: 'Bearer', scope: 'openid email',
  };
  const { result } = await withMockFetch(
    () => json(200, tokens),
    () => exchangeCodeForTokens('code', 'id', 'secret', 'https://x/cb'),
  );
  assert.deepEqual(result, tokens);
});

test('exchangeCodeForTokens: rejects non-string or blank refresh tokens', async () => {
  for (const refreshToken of [123, {}, '  ']) {
    await assert.rejects(
      withMockFetch(
        () => json(200, { access_token: 'at', expires_in: 3600, refresh_token: refreshToken }),
        () => exchangeCodeForTokens('code', 'id', 'secret', 'https://x/cb'),
      ),
      /refresh_token/,
    );
  }
});

test('exchangeCodeForTokens: rejects malformed successful token responses before OAuth account binding', async () => {
  for (const payload of [
    { refresh_token: 'rt', expires_in: 3600 },
    { refresh_token: 'rt', access_token: '  ', expires_in: 3600 },
    { refresh_token: 'rt', access_token: 123, expires_in: 3600 },
    { refresh_token: 'rt', access_token: 'at', expires_in: 0 },
    { refresh_token: 'rt', access_token: 'at', expires_in: '3600' },
    { refresh_token: 'rt', access_token: 'at' },
  ]) {
    await assert.rejects(
      withMockFetch(() => json(200, payload), () => exchangeCodeForTokens('code', 'id', 'secret', 'https://x/cb')),
      /valid access_token|expires_in/,
      JSON.stringify(payload),
    );
  }
});

test('refreshAccessToken: rejects malformed successful token responses instead of caching unusable tokens', async () => {
  for (const payload of [
    { expires_in: 3600 },
    { access_token: '', expires_in: 3600 },
    { access_token: {}, expires_in: 3600 },
    { access_token: 'at', expires_in: -1 },
    { access_token: 'at', expires_in: null },
    { access_token: 'at', expires_in: '3600' },
  ]) {
    await assert.rejects(
      withMockFetch(() => json(200, payload), () => refreshAccessToken('rt', 'id', 'secret')),
      /valid access_token|expires_in/,
      JSON.stringify(payload),
    );
  }
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

test('listSites: bounds oversized 403 bodies before retry classification', async () => {
  let chunksProduced = 0;
  let cancelled = false;
  const chunk = new TextEncoder().encode('x'.repeat(4096));
  const { calls } = await withMockFetch(
    () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksProduced === 300) {
          controller.close();
          return;
        }
        chunksProduced += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 403 }),
    () => assert.rejects(
      listSites('at'),
      (error: Error) => {
        assert.match(error.message, /List sites failed: 403/);
        assert.match(error.message, /truncated/);
        assert.ok(error.message.length < 20_000);
        return true;
      },
    ),
  );
  assert.equal(calls.length, 1, 'unknown 403 bodies must not trigger a retry');
  assert.ok(chunksProduced < 30, '403 classification must not drain the provider stream');
  assert.equal(cancelled, true);
});

test('listSites: retains retry of small transient 403 quota reasons', async () => {
  let attempts = 0;
  let reservations = 0;
  const { calls, result } = await withMockFetch(
    () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({
          error: { errors: [{ reason: 'rateLimitExceeded' }] },
        }), { status: 403, headers: { 'retry-after': '0' } });
      }
      return json(200, { siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] });
    },
    () => listSites('at', async () => { reservations += 1; }),
  );
  assert.equal(calls.length, 2);
  assert.equal(reservations, 1);
  assert.equal(result[0]?.siteUrl, 'sc-domain:example.com');
});

test('getSite: limits oversized non-403 Google error diagnostics', async () => {
  let chunksProduced = 0;
  let cancelled = false;
  const chunk = new TextEncoder().encode('e'.repeat(4096));
  const { calls } = await withMockFetch(
    () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksProduced === 300) {
          controller.close();
          return;
        }
        chunksProduced += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 400 }),
    () => assert.rejects(
      getSite('at', 'sc-domain:example.com'),
      (error: Error) => {
        assert.match(error.message, /Get site failed: 400/);
        assert.match(error.message, /truncated/);
        assert.ok(error.message.length < 20_000);
        return true;
      },
    ),
  );
  assert.equal(calls.length, 1);
  assert.ok(chunksProduced < 30);
  assert.equal(cancelled, true);
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

test('listSites: malformed Retry-After seconds never bypass retry backoff', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    delays.push(delay ?? 0);
    queueMicrotask(callback);
    return {} as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    for (const invalidRetryAfter of ['-1', '0.5', '1e-3']) {
      delays.length = 0;
      let attempts = 0;
      const { calls } = await withMockFetch(
        () => {
          attempts += 1;
          return attempts === 1
            ? new Response('temporary', {
              status: 429,
              headers: { 'retry-after': invalidRetryAfter },
            })
            : json(200, { siteEntry: [] });
        },
        () => listSites('at'),
      );
      assert.equal(calls.length, 2);
      assert.ok(
        delays[0] >= 1_000 && delays[0] < 1_250,
        `invalid Retry-After ${invalidRetryAfter} must use bounded backoff`,
      );
    }
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('listSites: Retry-After honors all three RFC 9110 HTTP-date formats', async () => {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  Date.now = () => Date.UTC(1994, 10, 6, 8, 49, 34);
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    delays.push(delay ?? 0);
    queueMicrotask(callback);
    return {} as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    for (const retryAfter of [
      'Sun, 06 Nov 1994 08:49:37 GMT',
      'Sunday, 06-Nov-94 08:49:37 GMT',
      'Sun Nov  6 08:49:37 1994',
    ]) {
      delays.length = 0;
      let attempts = 0;
      const { calls } = await withMockFetch(
        () => ++attempts === 1
          ? new Response('temporary', { status: 429, headers: { 'retry-after': retryAfter } })
          : json(200, { siteEntry: [] }),
        () => listSites('at'),
      );
      assert.equal(calls.length, 2, retryAfter);
      assert.equal(delays[0], 3_000, retryAfter);
    }
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('listSites: RFC 850 year within fifty future years is not mistaken for the past', async () => {
  const originalNow = Date.now;
  Date.now = () => Date.UTC(2026, 10, 10, 18, 0, 0);
  let attempts = 0;
  try {
    await assert.rejects(
      () => withMockFetch(
        () => {
          attempts += 1;
          return new Response('quota wait', {
            status: 429,
            headers: { 'retry-after': 'Thursday, 06-Nov-75 08:49:37 GMT' },
          });
        },
        () => listSites('at'),
      ),
      /List sites failed: 429 quota wait/,
    );
    assert.equal(attempts, 1, 'a far-future Retry-After must prevent additional quota-charging attempts');
  } finally {
    Date.now = originalNow;
  }
});

test('Search Console metadata reads reserve a unit before each additional Google attempt', async () => {
  const site = { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' };
  const sitemap = { path: 'https://example.com/sitemap.xml' };
  const reads = [
    { name: 'sites.list', invoke: (beforeRetry: () => Promise<void>) => listSites('at', beforeRetry), response: { siteEntry: [site] } },
    { name: 'sites.get', invoke: (beforeRetry: () => Promise<void>) => getSite('at', site.siteUrl, beforeRetry), response: site },
    { name: 'sitemaps.list', invoke: (beforeRetry: () => Promise<void>) => listSitemaps('at', site.siteUrl, undefined, beforeRetry), response: { sitemap: [sitemap] } },
    { name: 'sitemaps.get', invoke: (beforeRetry: () => Promise<void>) => getSitemap('at', site.siteUrl, sitemap.path, beforeRetry), response: sitemap },
  ];

  for (const read of reads) {
    let attempts = 0;
    let reservations = 0;
    const { calls } = await withMockFetch(
      () => {
        attempts += 1;
        return attempts === 1
          ? new Response('temporary', { status: 503, headers: { 'retry-after': '0' } })
          : json(200, read.response);
      },
      () => read.invoke(async () => { reservations += 1; }),
    );
    assert.equal(calls.length, 2, read.name);
    assert.equal(reservations, 1, `${read.name} must meter its retry`);
  }
});

test('Search Console metadata reads stop before upstream retry when quota denies it', async () => {
  const siteUrl = 'sc-domain:example.com';
  const feedpath = 'https://example.com/sitemap.xml';
  const reads = [
    { name: 'sites.list', invoke: (beforeRetry: () => Promise<void>) => listSites('at', beforeRetry) },
    { name: 'sites.get', invoke: (beforeRetry: () => Promise<void>) => getSite('at', siteUrl, beforeRetry) },
    { name: 'sitemaps.list', invoke: (beforeRetry: () => Promise<void>) => listSitemaps('at', siteUrl, undefined, beforeRetry) },
    { name: 'sitemaps.get', invoke: (beforeRetry: () => Promise<void>) => getSitemap('at', siteUrl, feedpath, beforeRetry) },
  ];

  for (const read of reads) {
    let attempts = 0;
    await assert.rejects(
      () => withMockFetch(
        () => {
          attempts += 1;
          return new Response('temporary', { status: 503, headers: { 'retry-after': '0' } });
        },
        () => read.invoke(async () => { throw new Error('Metadata retry budget exhausted'); }),
      ),
      /Metadata retry budget exhausted/,
      read.name,
    );
    assert.equal(attempts, 1, `${read.name} must not send an unreserved retry`);
  }
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

for (const scenario of [
  { label: 'HTTP 429', status: 429, body: 'rate limited', stops: true },
  {
    label: 'structured HTTP 403 user quota', status: 403,
    body: JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }),
    stops: true,
  },
  {
    label: 'structured HTTP 403 overall quota', status: 403,
    body: JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } }),
    stops: true,
  },
  {
    label: 'modern HTTP 403 RESOURCE_EXHAUSTED', status: 403,
    body: JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }),
    stops: true,
  },
  {
    label: 'modern HTTP 403 Google ErrorInfo rate limit', status: 403,
    body: JSON.stringify({ error: {
      status: 'PERMISSION_DENIED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED' }],
    } }),
    stops: true,
  },
  {
    label: 'unrelated HTTP 403 detail type is not a quota reason', status: 403,
    body: JSON.stringify({ error: {
      status: 'PERMISSION_DENIED',
      details: [{ '@type': 'type.googleapis.com/example.OtherInfo', reason: 'RATE_LIMIT_EXCEEDED' }],
    } }),
    stops: false,
  },
  {
    label: 'modern HTTP 403 Google ErrorInfo permission denial', status: 403,
    body: JSON.stringify({ error: {
      status: 'PERMISSION_DENIED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
    } }),
    stops: false,
  },
  { label: 'ordinary HTTP 403 permission', status: 403, body: 'forbidden', stops: false },
  { label: 'HTTP 503 transient failure', status: 503, body: 'unavailable', stops: false },
]) {
  test(`inspectUrlsSequentially: ${scenario.label} ${scenario.stops ? 'stops' : 'does not stop'} later inspections`, async () => {
    const urls = ['https://example.com/first', 'https://example.com/second', 'https://example.com/third'];
    const { result, calls } = await withMockFetch(
      (_url, init) => {
        const inspected = JSON.parse(String(init?.body)).inspectionUrl as string;
        return inspected === urls[0]
          ? new Response(scenario.body, { status: scenario.status, headers: { 'retry-after': '60' } })
          : json(200, { inspectionResult: { inspected } });
      },
      () => inspectUrlsSequentially('at', 'https://example.com/', urls),
    );
    assert.equal(calls.length, scenario.stops ? 1 : 3);
    assert.deepEqual(result.map((entry) => entry.inspectionUrl), urls);
    assert.match(result[0]?.error ?? '', new RegExp(`^URL inspection failed: ${scenario.status} `));
    for (const entry of result.slice(1)) {
      if (scenario.stops) {
        assert.match(entry.error ?? '', /Not inspected because Google URL Inspection reported a quota/);
        assert.equal(entry.inspectionResult, undefined);
      } else {
        assert.deepEqual(entry.inspectionResult, { inspected: entry.inspectionUrl });
      }
    }
  });
}

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

test('inspectUrlsBoundedConcurrently: processes URL inspections strictly one at a time', async () => {
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

  assert.equal(URL_INSPECTION_BATCH_CONCURRENCY, 1);
  assert.equal(calls.length, urls.length);
  assert.equal(maxActive, 1);
  assert.deepEqual(
    result.map((entry) => entry.inspectionUrl),
    urls,
  );
});

test('inspectUrl: reserves an extra unit before retrying a network failure', async () => {
  let attempts = 0;
  let retryReservations = 0;
  const { result, calls } = await withMockFetch(
    () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('Temporary network failure');
      return json(200, { inspectionResult: { indexStatusResult: { verdict: 'PASS' } } });
    },
    () => inspectUrl(
      'access-token',
      'sc-domain:example.com',
      'https://example.com/page',
      'en-US',
      async () => { retryReservations += 1; },
    ),
  );

  assert.equal(retryReservations, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(result, { indexStatusResult: { verdict: 'PASS' } });
});

test('inspectUrl: aborts immediately without retries or additional quota reservations', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  let retryReservations = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    throw new DOMException('Request canceled', 'AbortError');
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => inspectUrl(
        'access-token',
        'sc-domain:example.com',
        'https://example.com/page',
        undefined,
        async () => { retryReservations += 1; },
      ),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(attempts, 1);
  assert.equal(retryReservations, 0);
});

test('inspectUrlsSequentially: aborts the entire batch before subsequent URL inspections', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    if (requests === 1) throw new DOMException('Request canceled', 'AbortError');
    return json(200, { inspectionResult: { indexStatusResult: { verdict: 'PASS' } } });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => inspectUrlsSequentially(
        'access-token',
        'sc-domain:example.com',
        ['https://example.com/page', 'https://example.com/next'],
      ),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests, 1);
});

test('inspectUrl: a non-retryable authorization failure consumes no retry units', async () => {
  let retryReservations = 0;
  let attempts = 0;
  await assert.rejects(
    withMockFetch(
      () => {
        attempts += 1;
        return new Response('', { status: 401 });
      },
      () => inspectUrl(
        'expired-token',
        'sc-domain:example.com',
        'https://example.com/page',
        undefined,
        async () => { retryReservations += 1; },
      ),
    ),
    new RegExp(GSC_ACCESS_REVOKED_MESSAGE.slice(0, 22)),
  );
  assert.equal(attempts, 1);
  assert.equal(retryReservations, 0);
});

test('querySearchAnalyticsPaginated: forwards retry budget reservation to underlying reads', async () => {
  let retryReservations = 0;
  let requests = 0;
  const { result, calls } = await withMockFetch(
    () => {
      requests += 1;
      return requests === 1
        ? new Response('transient', { status: 503, headers: { 'retry-after': '0' } })
        : json(200, { rows: [] });
    },
    () => querySearchAnalyticsPaginated(
      'at',
      'sc-domain:example.com',
      { startDate: '2026-09-01', endDate: '2026-09-07', dimensions: ['query'] },
      { maxRows: 1, beforeRetry: async () => { retryReservations += 1; } },
    ),
  );
  assert.equal(retryReservations, 1);
  assert.equal(calls.length, 2);
  assert.equal(result.pagesFetched, 1);
  assert.equal(result.localLimitReached, false);
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

test('inspectUrlsBoundedConcurrently: access revocation prevents later inspections from starting', async () => {
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

  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls.map((call) => JSON.parse(String(call.init?.body)).inspectionUrl),
    urls.slice(0, 1),
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

test('querySearchAnalytics: recognizes message-only Search Analytics load quota errors', async () => {
  for (const message of [
    'Search Analytics load quota exceeded. Learn about usage limits.',
    'Quota exceeded for quota metric SearchAnalyticsLoad',
  ]) {
    const { calls } = await withMockFetch(
      () => json(403, { error: { code: 403, message } }),
      async () => {
        await assert.rejects(
          querySearchAnalytics('at', 'sc-domain:example.com', {
            startDate: '2026-05-01',
            endDate: '2026-05-31',
            dimensions: ['query', 'page'],
            rowLimit: 100,
          }),
          (error: Error) => {
            assert.match(error.message, /15 minutes/i);
            assert.match(error.message, /reduce expensive page\/query grouping or filtering/i);
            return true;
          },
        );
      },
    );
    assert.equal(calls.length, 1, 'load-quota failures must not trigger fast retries');
  }
});

test('querySearchAnalytics: prefix-sharing quota metrics are not SearchAnalyticsLoad', async () => {
  for (const metric of ['SearchAnalyticsLoadBudget', 'SearchAnalyticsLoad_daily', 'SearchAnalyticsLoad.requests', 'SearchAnalyticsLoad/Burst']) {
    const { calls } = await withMockFetch(
      () => json(403, { error: { code: 403, message: `Quota exceeded for quota metric ${metric}` } }),
      async () => {
        await assert.rejects(
          querySearchAnalytics('at', 'sc-domain:example.com', {
            startDate: '2026-05-01', endDate: '2026-05-31',
            dimensions: ['query', 'page'], rowLimit: 100,
          }),
          (error: Error) => {
            assert.match(error.message, /Search analytics query failed: 403/i);
            assert.doesNotMatch(error.message, /15 minutes|page\/query grouping or filtering/i);
            return true;
          },
        );
      },
    );
    assert.equal(calls.length, 1, 'unrelated metric must not be retried');
  }
});

test('querySearchAnalytics: generic quotaExceeded does not imply Search Analytics load exhaustion', async () => {
  const { calls } = await withMockFetch(
    () => json(403, {
      error: {
        code: 403,
        message: 'Quota exceeded for quota metric read_requests per minute',
        errors: [{
          domain: 'usageLimits',
          reason: 'quotaExceeded',
          message: 'Quota exceeded',
        }],
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
          assert.match(error.message, /Search analytics query failed: 403/i);
          assert.match(error.message, /read_requests per minute/i);
          assert.doesNotMatch(error.message, /15 minutes|page\/query grouping or filtering/i);
          return true;
        },
      );
    },
  );

  assert.equal(calls.length, 1, 'generic quota errors must not trigger immediate retries');
});

test('querySearchAnalytics: modern structured SearchAnalyticsLoad quota metadata gives scoped guidance', async () => {
  for (const metric of ['SearchAnalyticsLoad', 'searchconsole.googleapis.com/SearchAnalyticsLoad']) {
    const { calls } = await withMockFetch(
      () => json(403, {
        error: {
          status: 'RESOURCE_EXHAUSTED',
          message: 'Quota exceeded',
          details: [{
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'QUOTA_EXCEEDED',
            metadata: { quota_metric: metric },
          }],
        },
      }),
      async () => {
        await assert.rejects(
          querySearchAnalytics('at', 'sc-domain:example.com', {
            startDate: '2026-05-01', endDate: '2026-05-31',
            dimensions: ['query', 'page'], rowLimit: 100,
          }),
          (error: Error) => {
            assert.match(error.message, /15 minutes/i);
            assert.match(error.message, /page\/query grouping or filtering/i);
            return true;
          },
        );
      },
    );
    assert.equal(calls.length, 1, 'structured load-quota failure must not waste retries');
  }
});

test('querySearchAnalytics: modern unrelated quota metadata remains generic', async () => {
  for (const metric of ['read_requests_per_minute', 'preSearchAnalyticsLoadTest']) {
    const { calls } = await withMockFetch(
      () => json(403, {
        error: {
          status: 'RESOURCE_EXHAUSTED',
          message: 'Quota exceeded',
          details: [{
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'QUOTA_EXCEEDED',
            metadata: { quota_metric: metric },
          }],
        },
      }),
      async () => {
        await assert.rejects(
          querySearchAnalytics('at', 'sc-domain:example.com', {
            startDate: '2026-05-01', endDate: '2026-05-31',
            dimensions: ['query', 'page'], rowLimit: 100,
          }),
          (error: Error) => {
            assert.match(error.message, /Search analytics query failed: 403/i);
            assert.doesNotMatch(error.message, /15 minutes|page\/query grouping or filtering/i);
            return true;
          },
        );
      },
    );
    assert.equal(calls.length, 1);
  }
});

test('querySearchAnalytics: typed QuotaFailure SearchAnalyticsLoad violations give scoped guidance', async () => {
  for (const violation of [
    { quotaMetric: 'SearchAnalyticsLoad' },
    { quota_metric: 'searchconsole.googleapis.com/SearchAnalyticsLoad' },
  ]) {
    const { calls } = await withMockFetch(
      () => json(403, {
        error: {
          status: 'RESOURCE_EXHAUSTED',
          message: 'Quota exceeded',
          details: [{
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [violation],
          }],
        },
      }),
      async () => {
        await assert.rejects(
          querySearchAnalytics('at', 'sc-domain:example.com', {
            startDate: '2026-05-01', endDate: '2026-05-31',
            dimensions: ['query', 'page'], rowLimit: 100,
          }),
          (error: Error) => {
            assert.match(error.message, /15 minutes/i);
            assert.match(error.message, /page\/query grouping or filtering/i);
            return true;
          },
        );
      },
    );
    assert.equal(calls.length, 1, 'typed load quota must not waste retries');
  }
});

test('querySearchAnalytics: unrelated or spoofed QuotaFailure metrics remain generic', async () => {
  for (const detail of [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'read_requests_per_minute' }] },
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'preSearchAnalyticsLoadTest' }] },
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', violations: [{ quotaMetric: 'SearchAnalyticsLoad' }] },
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 42 }] },
  ]) {
    const { calls } = await withMockFetch(
      () => json(403, {
        error: {
          status: 'RESOURCE_EXHAUSTED',
          message: 'Quota exceeded',
          details: [detail],
        },
      }),
      async () => {
        await assert.rejects(
          querySearchAnalytics('at', 'sc-domain:example.com', {
            startDate: '2026-05-01', endDate: '2026-05-31',
            dimensions: ['query', 'page'], rowLimit: 100,
          }),
          (error: Error) => {
            assert.match(error.message, /Search analytics query failed: 403/i);
            assert.doesNotMatch(error.message, /15 minutes|page\/query grouping or filtering/i);
            return true;
          },
        );
      },
    );
    assert.equal(calls.length, 1);
  }
});

test('querySearchAnalytics: unrelated 403 permission errors are not called quota exhaustion', async () => {
  const { calls } = await withMockFetch(
    () => json(403, { error: { code: 403, message: 'Permission denied.' } }),
    async () => {
      await assert.rejects(
        querySearchAnalytics('at', 'sc-domain:example.com', {
          startDate: '2026-05-01',
          endDate: '2026-05-31',
          dimensions: ['query', 'page'],
          rowLimit: 100,
        }),
        (error: Error) => {
          assert.match(error.message, /query failed: 403/i);
          assert.doesNotMatch(error.message, /15 minutes/i);
          return true;
        },
      );
    },
  );
  assert.equal(calls.length, 1);
});

test('querySearchAnalytics: bounds and cancels oversized provider error bodies', async () => {
  let chunksProduced = 0;
  let cancelled = false;
  const chunk = new TextEncoder().encode('x'.repeat(4096));
  const { calls } = await withMockFetch(
    () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksProduced === 300) {
          controller.close();
          return;
        }
        chunksProduced += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 400 }),
    async () => {
      await assert.rejects(
        querySearchAnalytics('at', 'sc-domain:example.com', {
          startDate: '2026-05-01',
          endDate: '2026-05-31',
          dimensions: ['query'],
          rowLimit: 100,
        }),
        (error: Error) => {
          assert.match(error.message, /query failed: 400/i);
          assert.match(error.message, /truncated/i);
          assert.ok(error.message.length < 20_000, 'provider errors must not flood MCP output');
          return true;
        },
      );
    },
  );
  assert.equal(calls.length, 1);
  assert.ok(chunksProduced < 30, 'the provider stream must not be fully consumed');
  assert.equal(cancelled, true);
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

test('getIndexingNotificationMetadata: reserves indexing metadata budget before retrying', async () => {
  let reservations = 0;
  let attempts = 0;
  const { calls, result } = await withMockFetch(
    () => {
      attempts += 1;
      return attempts === 1
        ? new Response('transient', { status: 503, headers: { 'retry-after': '0' } })
        : json(200, { url: 'https://example.com/careers/role' });
    },
    () => getIndexingNotificationMetadata(
      'at',
      'https://example.com/careers/role',
      async () => { reservations += 1; },
    ),
  );
  assert.equal(calls.length, 2);
  assert.equal(reservations, 1);
  assert.equal(result.url, 'https://example.com/careers/role');
});

test('getIndexingNotificationMetadata: refuses an unreserved retry before contacting Google', async () => {
  let attempts = 0;
  await assert.rejects(
    () => withMockFetch(
      () => {
        attempts += 1;
        return new Response('temporary', { status: 503, headers: { 'retry-after': '0' } });
      },
      () => getIndexingNotificationMetadata(
        'at',
        'https://example.com/careers/role',
        async () => { throw new Error('Indexing metadata retry budget exhausted'); },
      ),
    ),
    /Indexing metadata retry budget exhausted/,
  );
  assert.equal(attempts, 1);
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



