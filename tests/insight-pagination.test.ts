import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_PAGINATED_SEARCH_ANALYTICS_ROWS,
  processQuickWins,
  querySearchAnalyticsPaginated,
  SEARCH_ANALYTICS_PAGE_SIZE,
  type PaginatedSearchAnalyticsQuery,
  type SearchAnalyticsRow,
} from '../src/google';
import {
  resultPageMetadata,
  takeBoundedItems,
} from '../src/result-bounds';

async function withMockAnalyticsPages<T>(
  pages: Map<number, SearchAnalyticsRow[]>,
  callback: (startRows: number[]) => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const startRows: number[] = [];
  globalThis.fetch = (async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as SearchAnalyticsQuery;
    const startRow = request.startRow ?? 0;
    startRows.push(startRow);
    return Response.json({ rows: pages.get(startRow) ?? [] });
  }) as typeof fetch;

  try {
    return await callback(startRows);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function makeRows(count: number, offset = 0): SearchAnalyticsRow[] {
  return Array.from({ length: count }, (_, index) => ({
    keys: [`query-${offset + index}`, `https://example.com/${offset + index}`],
    clicks: 10,
    impressions: 100,
    ctr: 0.1,
    position: 10,
  }));
}

const baseQuery: PaginatedSearchAnalyticsQuery = {
  startDate: '2026-01-01',
  endDate: '2026-01-31',
  dimensions: ['query', 'page'],
};

test('paginator stops after a short non-empty page', async () => {
  const firstPage = makeRows(SEARCH_ANALYTICS_PAGE_SIZE);
  const secondPage = makeRows(2, SEARCH_ANALYTICS_PAGE_SIZE);
  const thirdPage = makeRows(1, SEARCH_ANALYTICS_PAGE_SIZE * 2);
  await withMockAnalyticsPages(
    new Map([
      [0, firstPage],
      [SEARCH_ANALYTICS_PAGE_SIZE, secondPage],
      [SEARCH_ANALYTICS_PAGE_SIZE * 2, thirdPage],
      [SEARCH_ANALYTICS_PAGE_SIZE * 3, []],
    ]),
    async (startRows) => {
      const result = await querySearchAnalyticsPaginated('token', 'sc-domain:example.com', baseQuery);
      assert.deepEqual(startRows, [
        0,
        SEARCH_ANALYTICS_PAGE_SIZE,
      ]);
      assert.equal(result.rows.length, SEARCH_ANALYTICS_PAGE_SIZE + 2);
      assert.equal(result.pagesFetched, 2);
      assert.equal(result.localLimitReached, false);
    },
  );
});

test('paginator requests an empty page after exactly full pages', async () => {
  const firstPage = makeRows(SEARCH_ANALYTICS_PAGE_SIZE);
  const secondPage = makeRows(SEARCH_ANALYTICS_PAGE_SIZE, SEARCH_ANALYTICS_PAGE_SIZE);
  await withMockAnalyticsPages(
    new Map([
      [0, firstPage],
      [SEARCH_ANALYTICS_PAGE_SIZE, secondPage],
      [SEARCH_ANALYTICS_PAGE_SIZE * 2, []],
    ]),
    async (startRows) => {
      const result = await querySearchAnalyticsPaginated(
        'token',
        'sc-domain:example.com',
        baseQuery,
        { maxRows: SEARCH_ANALYTICS_PAGE_SIZE * 3 },
      );
      assert.deepEqual(startRows, [0, SEARCH_ANALYTICS_PAGE_SIZE, SEARCH_ANALYTICS_PAGE_SIZE * 2]);
      assert.equal(result.rows.length, SEARCH_ANALYTICS_PAGE_SIZE * 2);
      assert.equal(result.pagesFetched, 3);
      assert.equal(result.localLimitReached, false);
    },
  );
});

test('paginator reports when its local safety ceiling is reached', async () => {
  const fullPage = makeRows(SEARCH_ANALYTICS_PAGE_SIZE);
  await withMockAnalyticsPages(
    new Map([
      [0, fullPage],
      [SEARCH_ANALYTICS_PAGE_SIZE, fullPage],
      [SEARCH_ANALYTICS_PAGE_SIZE * 2, fullPage],
      [SEARCH_ANALYTICS_PAGE_SIZE * 3, fullPage],
    ]),
    async (startRows) => {
      const result = await querySearchAnalyticsPaginated(
        'token',
        'sc-domain:example.com',
        baseQuery,
        { maxRows: MAX_PAGINATED_SEARCH_ANALYTICS_ROWS + SEARCH_ANALYTICS_PAGE_SIZE },
      );
      assert.deepEqual(startRows, [
        0,
        SEARCH_ANALYTICS_PAGE_SIZE,
        SEARCH_ANALYTICS_PAGE_SIZE * 2,
        SEARCH_ANALYTICS_PAGE_SIZE * 3,
      ]);
      assert.equal(result.rows.length, MAX_PAGINATED_SEARCH_ANALYTICS_ROWS);
      assert.equal(result.localLimitReached, true);
      assert.equal(MAX_PAGINATED_SEARCH_ANALYTICS_ROWS, SEARCH_ANALYTICS_PAGE_SIZE * 4);
    },
  );
});

test('paginator advances from a supplied startRow and stops on a short page', async () => {
  const initialStartRow = 100;
  await withMockAnalyticsPages(
    new Map([
      [initialStartRow, makeRows(SEARCH_ANALYTICS_PAGE_SIZE, initialStartRow)],
      [initialStartRow + SEARCH_ANALYTICS_PAGE_SIZE, makeRows(1)],
    ]),
    async (startRows) => {
      const result = await querySearchAnalyticsPaginated(
        'token',
        'sc-domain:example.com',
        { ...baseQuery, startRow: initialStartRow },
      );
      assert.deepEqual(startRows, [
        initialStartRow,
        initialStartRow + SEARCH_ANALYTICS_PAGE_SIZE,
      ]);
      assert.equal(result.rows.length, SEARCH_ANALYTICS_PAGE_SIZE + 1);
      assert.equal(result.pagesFetched, 2);
      assert.equal(result.localLimitReached, false);
    },
  );
});

test('existing insight transformations receive the combined paginated rows unchanged', async () => {
  const row: SearchAnalyticsRow = {
    keys: ['seo job', 'https://example.com/jobs/seo'],
    clicks: 5,
    impressions: 150,
    ctr: 0.03,
    position: 10,
  };
  await withMockAnalyticsPages(new Map([[0, [row]]]), async () => {
    const source = await querySearchAnalyticsPaginated('token', 'sc-domain:example.com', baseQuery);
    assert.deepEqual(processQuickWins(source.rows, 100, 8, 20), [
      {
        query: 'seo job',
        page: 'https://example.com/jobs/seo',
        clicks: 5,
        impressions: 150,
        ctr: 0.03,
        position: 10,
      },
    ]);
  });
});

test('structured result bounding stops oversized row sets deterministically', () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({
    key: `result-${index}-${'x'.repeat(200)}`,
    impressions: 1000 - index,
  }));

  const bounded = takeBoundedItems(rows, 200, 4_000);
  assert.equal(bounded.byteLimitReached, true);
  assert.ok(bounded.items.length > 0);
  assert.ok(bounded.items.length < rows.length);
  assert.deepEqual(
    bounded.items.map((row) => row.key),
    rows.slice(0, bounded.items.length).map((row) => row.key),
  );
  assert.ok(
    new TextEncoder().encode(JSON.stringify(bounded.items)).byteLength <= 4_000,
  );
});

test('result page metadata exposes truncation and a usable next offset', () => {
  assert.deepEqual(
    resultPageMetadata({
      startRow: 25,
      limit: 50,
      returnedCount: 17,
      totalCount: 200,
      hasMore: true,
      byteLimitReached: true,
    }),
    {
      start_row: 25,
      limit: 50,
      returned_count: 17,
      total_count: 200,
      has_more: true,
      truncated: true,
      byte_limit_reached: true,
      next_start_row: 42,
    },
  );
});
