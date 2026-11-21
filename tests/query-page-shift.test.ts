import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertShiftWindows,
  buildShiftReport,
  fetchShiftSource,
  shiftRequestBudget,
  type ShiftAnalysisInput,
  type ShiftSource,
} from '../src/query-page-shift';
import type { SearchAnalyticsRow } from '../src/google';

function row(keys: string[], clicks: number, impressions: number, position?: number): SearchAnalyticsRow {
  return {
    keys, clicks, impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    ...(position !== undefined ? { position } : {}),
  };
}
function source(rows: SearchAnalyticsRow[], truncated = false): ShiftSource {
  return {
    rows, rows_fetched: rows.length, pages_fetched: 1,
    rows_per_page: 100, page_cap: 1,
    local_page_cap_reached: truncated, short_page_observed: !truncated,
    next_source_start_row: truncated ? rows.length : null,
    aggregation_types: ['auto'], provider_exhaustiveness_guaranteed: false,
  };
}
function report(sources: ShiftAnalysisInput[], options: {
  minImpressions?: number;
  earlier?: { start: string; end: string };
  later?: { start: string; end: string };
  limit?: number;
} = {}) {
  return buildShiftReport({
    siteUrl: 'sc-domain:example.test',
    searchType: 'web', dataState: 'final', filters: {},
    windows: {
      earlier: options.earlier ?? { start: '2026-10-01', end: '2026-10-03' },
      later: options.later ?? { start: '2026-10-04', end: '2026-10-06' },
    },
    sources, rowsPerPage: 100, sourcePages: 1,
    includeQueryPage: sources.length === 3,
    resultLimit: options.limit ?? 5,
    minImpressionsPerPeriod: options.minImpressions ?? 1,
  });
}
const emptyPageSource: ShiftAnalysisInput = {
  dimension: 'page', earlier: source([]), later: source([]),
};

test('separates same-query position worsening from observed query mix shift', () => {
  const q: ShiftAnalysisInput = {
    dimension: 'query',
    earlier: source([
      row(['steady'], 40, 400, 3),
      row(['earlier only'], 8, 80, 2),
      row(['no position'], 2, 25),
    ]),
    later: source([
      row(['steady'], 10, 100, 9),
      row(['later only'], 5, 30, 7),
      row(['no position'], 1, 20),
    ]),
  };
  const result = report([q, emptyPageSource]);
  const analysis = result.analyses[0];
  assert.deepEqual(analysis.observed_keys, {
    earlier: 3, later: 3, common: 2,
    earlier_only: 1, later_only: 1, ambiguous_excluded: 0,
    malformed_excluded: 0, observed_jaccard: 0.5,
  });
  assert.equal(analysis.signals.position_worsening_common_keys, 1);
  assert.equal(analysis.signals.observed_key_mix_differs, true);
  assert.deepEqual(analysis.ranked_declines.clicks.map((item) => item.keys), [['steady'], ['no position']]);
  assert.equal(analysis.ranked_declines.average_position[0].change.position, 6);
  assert.equal(analysis.ranked_declines.clicks[1].change.position, null);
  assert.deepEqual(analysis.observed_only_samples.earlier.map((item) => item.keys), [['earlier only']]);
  assert.equal(analysis.observed_only_samples.earlier[0].observed.clicks, 8);
  assert.equal(analysis.matched_sample_totals.not_property_wide, true);
  assert.equal(analysis.matched_sample_totals.click_change, -31);
  assert.equal(result.request_budget.reserved_search_analytics_calls, 4);
});

test('exact query-page tuples do not collide or get confused with query-only keys', () => {
  const pair: ShiftAnalysisInput = {
    dimension: 'query_page',
    earlier: source([
      row(['a,b', 'c'], 30, 100, 4),
      row(['a', 'b,c'], 7, 50, 8),
      row(['same query', '/old'], 9, 30, 4),
    ]),
    later: source([
      row(['a,b', 'c'], 2, 40, 9),
      row(['a', 'b,c'], 6, 40, 8),
      row(['same query', '/new'], 9, 50, 3),
    ]),
  };
  const result = report([
    { dimension: 'query', earlier: source([]), later: source([]) },
    emptyPageSource,
    pair,
  ]);
  const analysis = result.analyses[2];
  assert.equal(analysis.observed_keys.common, 2);
  assert.equal(analysis.observed_keys.earlier_only, 1);
  assert.equal(analysis.observed_keys.later_only, 1);
  assert.deepEqual(analysis.ranked_declines.clicks.map((item) => item.keys), [['a,b', 'c'], ['a', 'b,c']]);
});

test('duplicate and malformed provider tuples are excluded, not overwritten or fabricated', () => {
  const query: ShiftAnalysisInput = {
    dimension: 'query',
    earlier: source([
      row(['duplicate'], 30, 100, 1),
      row(['duplicate'], 25, 100, 2),
      row(['unique'], 5, 20, 5),
      row(['not', 'a query key'], 7, 80, 2),
    ]),
    later: source([
      row(['duplicate'], 1, 10, 20),
      row(['unique'], 4, 18, 7),
    ]),
  };
  const analysis = report([query, emptyPageSource]).analyses[0];
  assert.equal(analysis.observed_keys.ambiguous_excluded, 1);
  assert.equal(analysis.observed_keys.malformed_excluded, 1);
  assert.equal(analysis.observed_keys.common, 1);
  assert.deepEqual(analysis.ranked_declines.clicks.map((entry) => entry.keys), [['unique']]);
  assert.equal(analysis.observed_keys.earlier_only, 0);
  assert.equal(analysis.observed_keys.later_only, 0);
});

test('zero-valued observations remain real; missing and unsupported positions stay null', () => {
  const query: ShiftAnalysisInput = {
    dimension: 'query',
    earlier: source([
      row(['zero baseline'], 0, 0, 0),
      row(['both zero'], 0, 0),
      row(['no rank'], 4, 50),
      row(['only earlier'], 10, 100, 3),
    ]),
    later: source([
      row(['zero baseline'], 2, 20, 3),
      row(['both zero'], 0, 0),
      row(['no rank'], 2, 40),
    ]),
  };
  const result = report([query, emptyPageSource], { minImpressions: 0 });
  const analysis = result.analyses[0];
  assert.equal(analysis.observed_keys.common, 3);
  assert.equal(analysis.observed_keys.earlier_only, 1);
  const baseline = analysis.ranked_declines.impressions.find((item) => item.keys[0] === 'zero baseline');
  assert.equal(baseline, undefined);
  const missingRank = analysis.ranked_declines.clicks.find((item) => item.keys[0] === 'no rank');
  assert.equal(missingRank?.change.position, null);
  assert.equal(analysis.observed_only_samples.earlier[0].observed.clicks, 10);
  assert.equal(analysis.ranked_declines.average_position.length, 0);
  assert.equal(analysis.matched_sample_totals.click_change, 0);
});

test('comparable zero baselines have correct relative metrics and no artificial position', () => {
  const query: ShiftAnalysisInput = {
    dimension: 'query',
    earlier: source([row(['x'], 0, 0), row(['y'], 0, 0)]),
    later: source([row(['x'], 4, 50), row(['y'], 0, 0)]),
  };
  const result = report([query, emptyPageSource], { minImpressions: 0 });
  // Rank lists only include losses. Observe the directly reported measured changes.
  assert.equal(result.analyses[0].matched_sample_totals.earlier_clicks, 0);
  assert.equal(result.analyses[0].matched_sample_totals.later_clicks, 4);
  assert.equal(result.analyses[0].ranked_declines.clicks.length, 0);
});

test('window validation rejects overlaps/reversal/invalid dates and flags unequal duration', () => {
  assert.throws(() => assertShiftWindows({
    earlier: { start: '2026-10-01', end: '2026-10-07' },
    later: { start: '2026-10-07', end: '2026-10-13' },
  }), /no overlaps/);
  assert.throws(() => assertShiftWindows({
    earlier: { start: '2026-10-05', end: '2026-10-04' },
    later: { start: '2026-10-06', end: '2026-10-10' },
  }), /valid ordered/);
  assert.throws(() => assertShiftWindows({
    earlier: { start: '2026-10-01', end: '2026-11-08' },
    later: { start: '2026-11-09', end: '2026-11-10' },
  }), /31 days/);
  const result = report([
    { dimension: 'query', earlier: source([]), later: source([]) },
    emptyPageSource,
  ], {
    earlier: { start: '2026-10-01', end: '2026-10-02' },
    later: { start: '2026-10-03', end: '2026-10-05' },
  });
  assert.equal(result.periods.equal_duration, false);
  assert.match(result.periods.note, /daily-rate/);
});

test('request budget reserves every possible initial upstream call', () => {
  assert.equal(shiftRequestBudget(false, 1), 4);
  assert.equal(shiftRequestBudget(true, 1), 6);
  assert.equal(shiftRequestBudget(false, 2), 8);
  assert.equal(shiftRequestBudget(true, 2), 12);
  assert.throws(() => shiftRequestBudget(true, 3), /source_pages/);
});

test('bounded provider pagination records exact page counts, truncation and offsets', async () => {
  const originalFetch = globalThis.fetch;
  const starts: number[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { startRow: number; rowLimit: number };
    starts.push(body.startRow);
    return Response.json({ rows: [
      row(['key' + body.startRow], 1, 10, 2),
      row(['key' + (body.startRow + 1)], 0, 10, 3),
    ] });
  };
  try {
    const result = await fetchShiftSource('synthetic-token', 'sc-domain:example.test', {
      startDate: '2026-10-01', endDate: '2026-10-02',
      dimensions: ['query'], type: 'web', dataState: 'final',
    }, 2, 2, async () => {});
    assert.deepEqual(starts, [0, 2]);
    assert.equal(result.pages_fetched, 2);
    assert.equal(result.rows_fetched, 4);
    assert.equal(result.local_page_cap_reached, true);
    assert.equal(result.short_page_observed, false);
    assert.equal(result.next_source_start_row, 4);
    assert.equal(result.provider_exhaustiveness_guaranteed, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('provider short page is recorded but never falsely declared exhaustive', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ rows: [row(['one'], 2, 10, 2)] });
  try {
    const result = await fetchShiftSource('synthetic-token', 'sc-domain:example.test', {
      startDate: '2026-10-01', endDate: '2026-10-02',
      dimensions: ['page'], type: 'web', dataState: 'final',
    }, 2, 2, async () => {});
    assert.equal(result.pages_fetched, 1);
    assert.equal(result.short_page_observed, true);
    assert.equal(result.local_page_cap_reached, false);
    assert.equal(result.provider_exhaustiveness_guaranteed, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('long synthetic keys trigger bounded response without silently claiming complete rankings', () => {
  const earlier: SearchAnalyticsRow[] = [];
  const later: SearchAnalyticsRow[] = [];
  for (let i = 0; i < 15; i += 1) {
    const key = 'synthetic-' + String(i) + '-'.repeat(4_000);
    earlier.push(row([key], 100 + i, 1_000, 3));
    later.push(row([key], 1, 20, 9));
  }
  const result = report([
    { dimension: 'query', earlier: source(earlier), later: source(later) },
    emptyPageSource,
  ], { limit: 10 });
  assert.equal(new TextEncoder().encode(JSON.stringify(result)).byteLength <= 44_000, true);
  assert.equal(result.output_byte_limit_reached, true);
  assert.equal(result.analyses[0].observed_keys.common, 15);
  assert.equal(result.analyses[0].rankings_truncated, true);
});
