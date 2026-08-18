import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processQuickWins, querySearchAnalytics, type SearchAnalyticsQuery } from '../src/google';

const QUERY: SearchAnalyticsQuery = {
  startDate: '2026-08-01',
  endDate: '2026-08-10',
  dimensions: ['query'],
  rowLimit: 100,
};

const rows = [
  { keys: ['example query'], clicks: 10, impressions: 200, ctr: 0.05, position: 9 },
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

async function withMockFetch<T>(
  response: unknown,
  callback: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => json(response);
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('querySearchAnalytics preserves rows when Google sends no optional metadata', async () => {
  const response = await withMockFetch({ rows }, () =>
    querySearchAnalytics('token', 'sc-domain:example.com', QUERY),
  );

  assert.deepEqual(response, { rows });
  assert.equal('responseAggregationType' in response, false);
  assert.equal('metadata' in response, false);
});

test('querySearchAnalytics preserves Google response aggregation type', async () => {
  const response = await withMockFetch(
    { rows, responseAggregationType: 'byPage' },
    () => querySearchAnalytics('token', 'sc-domain:example.com', QUERY),
  );

  assert.deepEqual(response, { rows, responseAggregationType: 'byPage' });
});

test('querySearchAnalytics preserves first incomplete date metadata', async () => {
  const response = await withMockFetch(
    { rows, metadata: { first_incomplete_date: '2026-08-09' } },
    () => querySearchAnalytics('token', 'sc-domain:example.com', QUERY),
  );

  assert.deepEqual(response, {
    rows,
    metadata: { first_incomplete_date: '2026-08-09' },
  });
});

test('querySearchAnalytics preserves first incomplete hour metadata', async () => {
  const response = await withMockFetch(
    { rows, metadata: { first_incomplete_hour: '2026-08-10T12:00:00Z' } },
    () => querySearchAnalytics('token', 'sc-domain:example.com', QUERY),
  );

  assert.deepEqual(response, {
    rows,
    metadata: { first_incomplete_hour: '2026-08-10T12:00:00Z' },
  });
});

test('higher-level analytics transformations continue to consume response rows', async () => {
  const quickWinRows = [
    {
      keys: ['example query', 'https://example.com/page'],
      clicks: 10,
      impressions: 200,
      ctr: 0.05,
      position: 9,
    },
  ];
  const response = await withMockFetch(
    { rows: quickWinRows, responseAggregationType: 'byPage' },
    () => querySearchAnalytics('token', 'sc-domain:example.com', QUERY),
  );

  assert.deepEqual(processQuickWins(response.rows, 100, 8, 20), [
    {
      query: 'example query',
      page: 'https://example.com/page',
      clicks: 10,
      impressions: 200,
      ctr: 0.05,
      position: 9,
    },
  ]);
});
