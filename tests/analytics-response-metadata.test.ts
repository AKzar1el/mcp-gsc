import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSearchAnalyticsQueryCompatible, processQuickWins, querySearchAnalytics, type SearchAnalyticsQuery } from '../src/google';

const QUERY: SearchAnalyticsQuery = {
  startDate: '2026-08-01',
  endDate: '2026-08-10',
  dimensions: ['query'],
  rowLimit: 100,
};

const rows = [
  { keys: ['example query'], clicks: 10, impressions: 200, ctr: 0.05, position: 9 },
];

test('Search Analytics rejects invalid request dates before issuing a provider query', () => {
  for (const dates of [
    { startDate: '2026-02-30', endDate: '2026-03-01' },
    { startDate: 'not-a-date', endDate: '2026-08-10' },
    { startDate: '2026-08-11', endDate: '2026-08-10' },
  ]) {
    assert.throws(
      () => assertSearchAnalyticsQueryCompatible({ ...QUERY, ...dates }),
      /Search Analytics .*date/i,
    );
  }
  assert.doesNotThrow(() => assertSearchAnalyticsQueryCompatible({
    ...QUERY,
    startDate: '2024-02-29',
    endDate: '2024-03-01',
  }));
});

test('Search Analytics rejects invalid row limits and starting offsets before provider calls', () => {
  for (const rowLimit of [-1, 0, 0.5, 25001, Infinity]) {
    assert.throws(
      () => assertSearchAnalyticsQueryCompatible({ ...QUERY, rowLimit }),
      /rowLimit/,
    );
  }
  for (const startRow of [-1, 0.5, Infinity, NaN, 2_147_483_648]) {
    assert.throws(
      () => assertSearchAnalyticsQueryCompatible({ ...QUERY, startRow }),
      /startRow/,
    );
  }
  assert.doesNotThrow(() => assertSearchAnalyticsQueryCompatible({
    ...QUERY,
    rowLimit: 25000,
    startRow: 0,
  }));
});

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
    { rows, metadata: { firstIncompleteDate: '2026-08-09' } },
    () => querySearchAnalytics('token', 'sc-domain:example.com', QUERY),
  );

  assert.deepEqual(response, {
    rows,
    metadata: { first_incomplete_date: '2026-08-09' },
  });
});

test('querySearchAnalytics preserves first incomplete hour metadata', async () => {
  const response = await withMockFetch(
    { rows, metadata: { firstIncompleteHour: '2026-08-10T12:00:00Z' } },
    () => querySearchAnalytics('token', 'sc-domain:example.com', QUERY),
  );

  assert.deepEqual(response, {
    rows,
    metadata: { first_incomplete_hour: '2026-08-10T12:00:00Z' },
  });
});

test('querySearchAnalytics rejects invalid calendar dates in incomplete-data metadata', async () => {
  for (const date of ['not-a-date', '2026-02-30', '2026-13-01']) {
    await assert.rejects(
      withMockFetch(
        { rows, metadata: { firstIncompleteDate: date } },
        () => querySearchAnalytics('token', 'sc-domain:example.com', QUERY),
      ),
      /Search Analytics response contains invalid metadata/,
    );
  }
});

test('querySearchAnalytics validates incomplete hours while accepting Pacific offsets', async () => {
  for (const hour of ['bad-value', '2026-02-30T12:00:00-08:00', '2026-08-10T29:00:00-07:00']) {
    await assert.rejects(
      withMockFetch(
        { rows, metadata: { firstIncompleteHour: hour } },
        () => querySearchAnalytics('token', 'sc-domain:example.com', QUERY),
      ),
      /Search Analytics response contains invalid metadata/,
    );
  }
  const valid = '2026-08-10T12:00:00-07:00';
  const response = await withMockFetch(
    { rows, metadata: { firstIncompleteHour: valid } },
    () => querySearchAnalytics('token', 'sc-domain:example.com', QUERY),
  );
  assert.equal(response.metadata?.first_incomplete_hour, valid);
});

test('querySearchAnalytics preserves valid leap dates and rejects malformed hour offsets', async () => {
  const leapDate = '2024-02-29';
  const dateResponse = await withMockFetch(
    { rows, metadata: { firstIncompleteDate: leapDate } },
    () => querySearchAnalytics('token', 'sc-domain:example.com', QUERY),
  );
  assert.equal(dateResponse.metadata?.first_incomplete_date, leapDate);

  for (const hour of ['2024-02-29T23:59:59-08:00', '2026-08-10T00:00:00-07:00']) {
    const response = await withMockFetch(
      { rows, metadata: { firstIncompleteHour: hour } },
      () => querySearchAnalytics('token', 'sc-domain:example.com', QUERY),
    );
    assert.equal(response.metadata?.first_incomplete_hour, hour);
  }

  for (const hour of [
    '2026-08-10T12:60:00-07:00',
    '2026-08-10T12:30:60-07:00',
    '2026-08-10T12:30:00+25:00',
    '2026-08-10T12:30:00+07:60',
  ]) {
    await assert.rejects(
      withMockFetch(
        { rows, metadata: { firstIncompleteHour: hour } },
        () => querySearchAnalytics('token', 'sc-domain:example.com', QUERY),
      ),
      /Search Analytics response contains invalid metadata/,
    );
  }
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
    () => querySearchAnalytics('token', 'sc-domain:example.com', {
      ...QUERY,
      dimensions: ['query', 'page'],
    }),
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

test('querySearchAnalytics rejects missing, short, and extra grouped dimension keys', async () => {
  const metrics = { clicks: 2, impressions: 20, ctr: 0.1, position: 4 };
  for (const row of [
    metrics,
    { ...metrics, keys: ['query'] },
    { ...metrics, keys: ['query', 'https://example.com/', 'extra'] },
  ]) {
    await assert.rejects(
      withMockFetch({ rows: [row] }, () => querySearchAnalytics(
        'token',
        'sc-domain:example.com',
        { ...QUERY, dimensions: ['query', 'page'] },
      )),
      /Search Analytics response contains invalid rows/,
    );
  }
});

test('querySearchAnalytics preserves keyless aggregates and rejects extraneous keys', async () => {
  const metrics = { clicks: 2, impressions: 20, ctr: 0.1, position: 4 };
  const query = { ...QUERY, dimensions: [] };
  for (const row of [metrics, { ...metrics, keys: [] }]) {
    const response = await withMockFetch(
      { rows: [row] },
      () => querySearchAnalytics('token', 'sc-domain:example.com', query),
    );
    assert.deepEqual(response.rows, [row]);
  }
  await assert.rejects(
    withMockFetch({ rows: [{ ...metrics, keys: ['unexpected'] }] }, () =>
      querySearchAnalytics('token', 'sc-domain:example.com', query)),
    /Search Analytics response contains invalid rows/,
  );
});

test('querySearchAnalytics rejects CTR greater than 100 percent and accepts boundary values', async () => {
  const metrics = { keys: ['example query'], clicks: 2, impressions: 20, position: 4 };
  for (const ctr of [0, 1]) {
    const response = await withMockFetch(
      { rows: [{ ...metrics, ctr }] },
      () => querySearchAnalytics('token', 'sc-domain:example.com', QUERY),
    );
    assert.equal(response.rows[0].ctr, ctr);
  }
  for (const ctr of [1.00001, 2]) {
    await assert.rejects(
      withMockFetch(
        { rows: [{ ...metrics, ctr }] },
        () => querySearchAnalytics('token', 'sc-domain:example.com', QUERY),
      ),
      /Search Analytics response contains invalid rows/,
    );
  }
});
