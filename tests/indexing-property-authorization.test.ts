import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertIndexingRequestUrl,
  assertIndexingUrlAuthorized,
  type SearchConsoleSite,
} from '../src/indexing-property-authorization';
import { checkIndexingEligibility } from '../src/google';

const ownerPrefix: SearchConsoleSite = {
  siteUrl: 'https://example.com/jobs/',
  permissionLevel: 'siteOwner',
};

const ownerDomain: SearchConsoleSite = {
  siteUrl: 'sc-domain:example.com',
  permissionLevel: 'siteOwner',
};

function assertAuthorized(
  url: string,
  siteUrl: string,
  sites: SearchConsoleSite[],
): void {
  assert.doesNotThrow(() => assertIndexingUrlAuthorized(url, siteUrl, sites));
}

function assertRejected(
  url: string,
  siteUrl: string,
  sites: SearchConsoleSite[],
  message: RegExp,
): void {
  assert.throws(
    () => assertIndexingUrlAuthorized(url, siteUrl, sites),
    message,
  );
}

test('Indexing authorization accepts URLs within an owner URL-prefix property', () => {
  assertAuthorized(
    'HTTPS://EXAMPLE.COM:443/jobs/engineer',
    'https://EXAMPLE.com:443/jobs/',
    [ownerPrefix],
  );
  assertAuthorized(
    'https://example.com/jobs/',
    ownerPrefix.siteUrl,
    [ownerPrefix],
  );
});

test('Indexing authorization enforces path boundaries for URL-prefix properties', () => {
  const prefixWithoutTrailingSlash: SearchConsoleSite = {
    siteUrl: 'https://example.com/jobs',
    permissionLevel: 'siteOwner',
  };
  assertAuthorized('https://example.com/jobs', prefixWithoutTrailingSlash.siteUrl, [prefixWithoutTrailingSlash]);
  assertAuthorized('https://example.com/jobs/engineer', prefixWithoutTrailingSlash.siteUrl, [prefixWithoutTrailingSlash]);
  assertRejected(
    'https://example.com/jobs-other/engineer',
    prefixWithoutTrailingSlash.siteUrl,
    [prefixWithoutTrailingSlash],
    /must belong/,
  );
});

test('Indexing authorization rejects URLs outside a URL-prefix property', () => {
  for (const url of [
    'https://example.com/job/engineer',
    'https://example.com/jobs-other/engineer',
    'http://example.com/jobs/engineer',
    'https://sub.example.com/jobs/engineer',
    'https://example.com.evil.test/jobs/engineer',
  ]) {
    assertRejected(url, ownerPrefix.siteUrl, [ownerPrefix], /must belong/);
  }
});

test('Indexing authorization accepts the root domain and subdomains for a domain property', () => {
  assertAuthorized('https://example.com/jobs/engineer', ownerDomain.siteUrl, [ownerDomain]);
  assertAuthorized('http://jobs.example.com/opening/1', ownerDomain.siteUrl, [ownerDomain]);
});

test('Indexing authorization rejects lookalikes outside a domain property', () => {
  for (const url of [
    'https://example.com.evil.test/jobs/engineer',
    'https://evil-example.com/jobs/engineer',
    'https://example.org/jobs/engineer',
  ]) {
    assertRejected(url, ownerDomain.siteUrl, [ownerDomain], /must belong/);
  }
});

test('Indexing authorization rejects malformed, non-HTTP, and userinfo URLs', () => {
  for (const url of [
    '/jobs/engineer',
    'example.com/jobs/engineer',
    'https:example.com/jobs/engineer',
    'ftp://example.com/jobs/engineer',
    'https://example.com@evil.test/jobs/engineer',
  ]) {
    assert.throws(() => assertIndexingRequestUrl(url), /fully qualified|HTTP or HTTPS|userinfo/);
  }
});

test('Indexing authorization rejects missing and insufficiently permitted properties', () => {
  assertRejected(
    'https://example.com/jobs/engineer',
    ownerPrefix.siteUrl,
    [],
    /must be a Search Console property.*owner/,
  );
  assertRejected(
    'https://example.com/jobs/engineer',
    ownerPrefix.siteUrl,
    [{ ...ownerPrefix, permissionLevel: 'siteFullUser' }],
    /must be a Search Console property.*owner/,
  );
});

test('Indexing eligibility does not follow redirects outside the authorized URL', async () => {
  const originalFetch = globalThis.fetch;
  let redirectMode: RequestRedirect | undefined;
  globalThis.fetch = async (_input, init) => {
    redirectMode = init?.redirect;
    return new Response('', {
      status: 302,
      headers: { location: 'https://evil.test/' },
    });
  };

  try {
    const result = await checkIndexingEligibility('https://example.com/jobs/engineer');
    assert.equal(redirectMode, 'manual');
    assert.equal(result.eligible, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
