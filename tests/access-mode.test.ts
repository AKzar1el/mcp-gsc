import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_GSC_ACCESS_MODE,
  getGoogleOAuthScopes,
  getToolCatalogForAccessMode,
  resolveGscAccessMode,
  WRITE_TOOL_NAMES,
} from '../src/access-mode';
import { buildAuthUrl } from '../src/google';

const ALL_TOOL_NAMES = [
  'sites.list',
  'sites.add',
  'sites.delete',
  'analytics.query',
  'urls.inspect',
  'sitemaps.list',
  'sitemaps.submit',
  'sitemaps.delete',
  'sitemaps.get',
  'insights.quick_wins',
  'insights.cannibalization',
  'insights.content_decay',
  'indexing.request',
  'indexing.list_pages',
  'analytics.compare',
  'reports.weekly_digest',
  'server.capabilities',
].map((name) => ({ name }));

test('GSC access mode defaults to backward-compatible readwrite', () => {
  assert.equal(DEFAULT_GSC_ACCESS_MODE, 'readwrite');
  assert.equal(resolveGscAccessMode(undefined), 'readwrite');
  assert.equal(resolveGscAccessMode(''), 'readwrite');
  assert.equal(resolveGscAccessMode('readonly'), 'readonly');
  assert.equal(resolveGscAccessMode('readwrite'), 'readwrite');
  assert.throws(
    () => resolveGscAccessMode('write-only'),
    /Invalid GSC_ACCESS_MODE configuration/,
  );
});

test('GSC access modes request their exact OAuth scope sets', () => {
  assert.deepEqual(getGoogleOAuthScopes('readonly'), [
    'openid',
    'email',
    'https://www.googleapis.com/auth/webmasters.readonly',
  ]);
  assert.deepEqual(getGoogleOAuthScopes('readwrite'), [
    'openid',
    'email',
    'https://www.googleapis.com/auth/webmasters',
    'https://www.googleapis.com/auth/indexing',
  ]);
});

test('Google authorization URLs use the scope set selected by access mode', () => {
  for (const mode of ['readonly', 'readwrite'] as const) {
    const url = new URL(
      buildAuthUrl(
        'client-id',
        'https://worker.example/google/callback',
        'nonce',
        mode,
      ),
    );
    assert.deepEqual(
      url.searchParams.get('scope')?.split(' '),
      getGoogleOAuthScopes(mode),
      mode,
    );
  }
});

test('read-only mode excludes every mutation while readwrite preserves the full catalog', () => {
  assert.deepEqual(
    getToolCatalogForAccessMode(ALL_TOOL_NAMES, 'readwrite'),
    ALL_TOOL_NAMES,
  );

  const readonlyToolNames = getToolCatalogForAccessMode(
    ALL_TOOL_NAMES,
    'readonly',
  ).map(({ name }) => name);

  assert.deepEqual(readonlyToolNames, [
    'sites.list',
    'analytics.query',
    'urls.inspect',
    'sitemaps.list',
    'sitemaps.get',
    'insights.quick_wins',
    'insights.cannibalization',
    'insights.content_decay',
    'indexing.list_pages',
    'analytics.compare',
    'reports.weekly_digest',
    'server.capabilities',
  ]);
  for (const writeTool of WRITE_TOOL_NAMES) {
    assert.equal(readonlyToolNames.includes(writeTool), false, writeTool);
  }
});
