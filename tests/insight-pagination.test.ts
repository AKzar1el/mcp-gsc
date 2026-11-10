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
  windowSourceRows,
  mapSourceRows,
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

test('paginator rejects an offset window that would exceed the Search Analytics startRow bound before fetching', async () => {
  await withMockAnalyticsPages(new Map(), async (startRows) => {
    await assert.rejects(
      querySearchAnalyticsPaginated(
        'token',
        'sc-domain:example.com',
        { ...baseQuery, startRow: 2_147_483_647 },
        { maxRows: SEARCH_ANALYTICS_PAGE_SIZE + 1 },
      ),
      /Search Analytics pagination startRow.*32-bit/i,
    );
    assert.deepEqual(startRows, [], 'invalid pagination must not consume Google API quota');
  });
});

test('paginator permits the largest valid startRow for a single-page request', async () => {
  const lastStartRow = 2_147_483_647;
  await withMockAnalyticsPages(new Map([[lastStartRow, []]]), async (startRows) => {
    const result = await querySearchAnalyticsPaginated(
      'token',
      'sc-domain:example.com',
      { ...baseQuery, startRow: lastStartRow },
      { maxRows: SEARCH_ANALYTICS_PAGE_SIZE },
    );
    assert.deepEqual(startRows, [lastStartRow]);
    assert.equal(result.pagesFetched, 1);
    assert.equal(result.localLimitReached, false);
  });
});

test('paginator accepts a two-page window ending at the maximum supported startRow', async () => {
  const firstStartRow = 2_147_483_647 - SEARCH_ANALYTICS_PAGE_SIZE;
  await withMockAnalyticsPages(new Map([
    [firstStartRow, makeRows(SEARCH_ANALYTICS_PAGE_SIZE)],
    [2_147_483_647, []],
  ]), async (startRows) => {
    const result = await querySearchAnalyticsPaginated(
      'token',
      'sc-domain:example.com',
      { ...baseQuery, startRow: firstStartRow },
      { maxRows: SEARCH_ANALYTICS_PAGE_SIZE + 1 },
    );
    assert.deepEqual(startRows, [firstStartRow, 2_147_483_647]);
    assert.equal(result.rows.length, SEARCH_ANALYTICS_PAGE_SIZE);
    assert.equal(result.pagesFetched, 2);
    assert.equal(result.localLimitReached, false);
  });
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

test('byte-limited known-result pages advance past an unrepresentable first item', () => {
  const requested = [{ query: 'x'.repeat(200) }, { query: 'small' }];
  const bounded = takeBoundedItems(requested, 2, 60);
  assert.equal(bounded.items.length, 0);
  assert.equal(bounded.byteLimitReached, true);
  const page = resultPageMetadata({
    startRow: 12,
    limit: 2,
    returnedCount: bounded.items.length,
    totalCount: 14,
    hasMore: true,
    byteLimitReached: bounded.byteLimitReached,
  });
  assert.equal(page.next_start_row, 13);
  assert.equal(page.has_more, true);
  assert.equal(page.byte_limit_reached, true);
});

test('empty provider pages do not manufacture a continuation without a byte-limit signal', () => {
  const page = resultPageMetadata({
    startRow: 12,
    limit: 2,
    returnedCount: 0,
    hasMore: true,
    byteLimitReached: false,
  });
  assert.equal(page.next_start_row, undefined);
});

test('source pagination advances past filtered provider rows instead of repeating them', () => {
  const rows = mapSourceRows(['first', undefined, 'third', undefined], (row) => row);
  const page = windowSourceRows(rows.items, 20, 2, true, 24, rows.sourceRowOffsets);
  assert.deepEqual(page.items, ['first', 'third']);
  assert.deepEqual(rows.sourceRowOffsets, [0, 2]);
  assert.equal(page.resultPage.next_start_row, 24);
  // An entire source page can lack usable position/keys; the next offset must
  // still progress when the provider reported a full page.
  const empty = windowSourceRows([], 20, 4, true, 24, []);
  assert.equal(empty.resultPage.has_more, true);
  assert.equal(empty.resultPage.next_start_row, 24);
});

test('byte-limited insight continuation counts the last emitted source index', () => {
  const big = 'x'.repeat(30_000);
  const page = windowSourceRows([big, big, big], 40, 3, true, 46, [1, 3, 5]);
  assert.deepEqual(page.items, [big]);
  assert.equal(page.resultPage.byte_limit_reached, true);
  assert.equal(page.resultPage.next_start_row, 42);
});

test('oversized first source row still provides a progressing continuation cursor', () => {
  const oversized = 'x'.repeat(48_000);
  const page = windowSourceRows([oversized, 'next-row'], 10, 2, false);
  assert.deepEqual(page.items, []);
  assert.equal(page.resultPage.byte_limit_reached, true);
  assert.equal(page.resultPage.has_more, true);
  assert.equal(page.resultPage.next_start_row, 11);

  // Insight results can filter source rows before applying the byte limit.
  const filtered = windowSourceRows([oversized, 'next-row'], 40, 2, false, undefined, [2, 4]);
  assert.equal(filtered.resultPage.next_start_row, 43);
  const continuation = windowSourceRows(['next-row'], 43, 2, false);
  assert.deepEqual(continuation.items, ['next-row']);
  assert.equal(continuation.resultPage.has_more, false);
});
