import { z } from 'zod';
import { isValidCalendarDate } from './date-validation';
import {
  querySearchAnalytics,
  type SearchAnalyticsQuery,
  type SearchAnalyticsRow,
} from './google';

export type ShiftDimension = 'query' | 'page' | 'query_page';
export const SHIFT_DIMENSIONS: readonly ShiftDimension[] = ['query', 'page', 'query_page'];
export const SHIFT_MAX_SOURCE_ROWS_PER_PAGE = 250;
export const SHIFT_MAX_SOURCE_PAGES = 2;
export const SHIFT_MAX_WINDOW_DAYS = 31;

type Metric = {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
};
type Change = {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
  clicks_percent: number | null;
  impressions_percent: number | null;
  daily_clicks: number;
  daily_impressions: number;
};
type Matched = { keys: string[]; earlier: Metric; later: Metric; change: Change };
type OneSided = { keys: string[]; observed: Metric };
export interface ShiftSource {
  rows: SearchAnalyticsRow[];
  rows_fetched: number;
  pages_fetched: number;
  rows_per_page: number;
  page_cap: number;
  local_page_cap_reached: boolean;
  short_page_observed: boolean;
  next_source_start_row: number | null;
  aggregation_types: string[];
  provider_exhaustiveness_guaranteed: false;
}
export type ShiftSourceInput = Omit<SearchAnalyticsQuery, 'rowLimit' | 'startRow'>;
export type ShiftAnalysisInput = {
  dimension: ShiftDimension;
  earlier: ShiftSource;
  later: ShiftSource;
};
export type ShiftWindow = { start: string; end: string };
export type ShiftWindows = { earlier: ShiftWindow; later: ShiftWindow };

const METRIC_SCHEMA = z.object({
  clicks: z.number(), impressions: z.number(), ctr: z.number(),
  position: z.number().nullable(),
});
const SOURCE_SCHEMA = z.object({
  rows_fetched: z.number().int().nonnegative(),
  pages_fetched: z.number().int().nonnegative(),
  rows_per_page: z.number().int().positive(),
  page_cap: z.number().int().positive(),
  local_page_cap_reached: z.boolean(),
  short_page_observed: z.boolean(),
  next_source_start_row: z.number().int().nonnegative().nullable(),
  aggregation_types: z.array(z.string()),
  provider_exhaustiveness_guaranteed: z.literal(false),
});
const MATCHED_SCHEMA = z.object({
  keys: z.array(z.string()),
  earlier: METRIC_SCHEMA,
  later: METRIC_SCHEMA,
  change: z.object({
    clicks: z.number(), impressions: z.number(), ctr: z.number(),
    position: z.number().nullable(),
    clicks_percent: z.number().nullable(),
    impressions_percent: z.number().nullable(),
    daily_clicks: z.number(), daily_impressions: z.number(),
  }),
});
export const QUERY_PAGE_SHIFT_OUTPUT_SCHEMA = {
  site_url: z.string(),
  search_type: z.enum(['web', 'image', 'video', 'news']),
  data_state: z.enum(['final', 'all']),
  preliminary_data_possible: z.boolean(),
  filters: z.object({
    country: z.string().nullable(), device: z.string().nullable(),
    query_contains: z.string().nullable(), page_contains: z.string().nullable(),
  }),
  periods: z.object({
    earlier: z.object({ start: z.string(), end: z.string(), days: z.number().int() }),
    later: z.object({ start: z.string(), end: z.string(), days: z.number().int() }),
    equal_duration: z.boolean(), note: z.string(),
  }),
  request_budget: z.object({
    reserved_search_analytics_calls: z.number().int(),
    actual_initial_calls: z.number().int(),
    max_source_rows_per_page: z.number().int(),
    max_source_pages: z.number().int(),
    retries_reserved_separately: z.literal(true),
    load_quota_cost_not_equivalent_to_call_count: z.literal(true),
  }),
  analyses: z.array(z.object({
    dimension: z.enum(['query', 'page', 'query_page']),
    source: z.object({ earlier: SOURCE_SCHEMA, later: SOURCE_SCHEMA }),
    observed_keys: z.object({
      earlier: z.number().int(), later: z.number().int(), common: z.number().int(),
      earlier_only: z.number().int(), later_only: z.number().int(),
      ambiguous_excluded: z.number().int(), malformed_excluded: z.number().int(),
      observed_jaccard: z.number().nullable(),
    }),
    matched_sample_totals: z.object({
      earlier_clicks: z.number(), later_clicks: z.number(),
      earlier_impressions: z.number(), later_impressions: z.number(),
      click_change: z.number(), impression_change: z.number(),
      not_property_wide: z.literal(true),
    }),
    signals: z.object({
      position_worsening_common_keys: z.number().int(),
      observed_key_mix_differs: z.boolean(),
      not_causal_attribution: z.literal(true),
    }),
    observed_only_samples: z.object({
      earlier: z.array(z.object({ keys: z.array(z.string()), observed: METRIC_SCHEMA })),
      later: z.array(z.object({ keys: z.array(z.string()), observed: METRIC_SCHEMA })),
      absence_is_not_zero: z.literal(true),
    }),
    ranked_declines: z.object({
      clicks: z.array(MATCHED_SCHEMA),
      impressions: z.array(MATCHED_SCHEMA),
      average_position: z.array(MATCHED_SCHEMA),
    }),
    rankings_truncated: z.boolean(),
  })),
  output_byte_limit_reached: z.boolean(),
  evidence_boundary: z.string(),
  hypotheses: z.array(z.string()),
};

export function assertShiftWindows(windows: ShiftWindows): { earlierDays: number; laterDays: number; equal: boolean } {
  const days = (window: ShiftWindow): number => {
    if (!isValidCalendarDate(window.start) || !isValidCalendarDate(window.end) || window.start > window.end) {
      throw new Error('Each comparison window requires valid ordered YYYY-MM-DD dates.');
    }
    const length = Math.round(
      (Date.parse(window.end + 'T00:00:00Z') - Date.parse(window.start + 'T00:00:00Z')) / 86_400_000,
    ) + 1;
    if (length > SHIFT_MAX_WINDOW_DAYS) {
      throw new Error('Each comparison window is limited to 31 days to bound Search Analytics load.');
    }
    return length;
  };
  const earlierDays = days(windows.earlier);
  const laterDays = days(windows.later);
  if (windows.earlier.end >= windows.later.start) {
    throw new Error('The earlier comparison window must end before the later one starts (no overlaps).');
  }
  return { earlierDays, laterDays, equal: earlierDays === laterDays };
}

export function shiftRequestBudget(includeQueryPage: boolean, sourcePages: number): number {
  if (!Number.isInteger(sourcePages) || sourcePages < 1 || sourcePages > SHIFT_MAX_SOURCE_PAGES) {
    throw new Error('source_pages must be 1 or 2.');
  }
  return 2 * (includeQueryPage ? 3 : 2) * sourcePages;
}

export async function fetchShiftSource(
  token: string,
  siteUrl: string,
  query: ShiftSourceInput,
  rowsPerPage: number,
  pageCap: number,
  beforeRetry: () => Promise<void>,
): Promise<ShiftSource> {
  if (!Number.isInteger(rowsPerPage) || rowsPerPage < 1 || rowsPerPage > SHIFT_MAX_SOURCE_ROWS_PER_PAGE ||
    !Number.isInteger(pageCap) || pageCap < 1 || pageCap > SHIFT_MAX_SOURCE_PAGES) {
    throw new Error('Source pagination exceeds the bounded query/page shift limits.');
  }
  const rows: SearchAnalyticsRow[] = [];
  const aggregations = new Set<string>();
  let pagesFetched = 0;
  let shortPage = false;
  let lastPageFull = false;
  for (let page = 0; page < pageCap; page += 1) {
    const result = await querySearchAnalytics(token, siteUrl, {
      ...query, rowLimit: rowsPerPage, startRow: page * rowsPerPage,
    }, beforeRetry);
    pagesFetched += 1;
    rows.push(...result.rows);
    if (result.responseAggregationType) aggregations.add(result.responseAggregationType);
    lastPageFull = result.rows.length === rowsPerPage;
    if (!lastPageFull) {
      shortPage = true;
      break;
    }
  }
  return {
    rows,
    rows_fetched: rows.length,
    pages_fetched: pagesFetched,
    rows_per_page: rowsPerPage,
    page_cap: pageCap,
    local_page_cap_reached: lastPageFull && pagesFetched === pageCap,
    short_page_observed: shortPage,
    next_source_start_row: lastPageFull ? pagesFetched * rowsPerPage : null,
    aggregation_types: [...aggregations],
    provider_exhaustiveness_guaranteed: false,
  };
}

function metrics(row: SearchAnalyticsRow): Metric {
  return {
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    // Position is not comparable without a positive observed impression base.
    position: row.impressions > 0 && row.position !== undefined && row.position > 0
      && Number.isFinite(row.position) ? row.position : null,
  };
}
function percent(later: number, earlier: number): number | null {
  if (earlier === 0) return later === 0 ? 0 : null;
  return Math.round(((later - earlier) / earlier) * 1000) / 10;
}
function observedMap(rows: SearchAnalyticsRow[], dimension: ShiftDimension) {
  const expected = dimension === 'query_page' ? 2 : 1;
  const candidates = new Map<string, { keys: string[]; observed: Metric }>();
  const ambiguous = new Set<string>();
  let malformed = 0;
  for (const row of rows) {
    if (!Array.isArray(row.keys) || row.keys.length !== expected ||
      row.keys.some((key) => typeof key !== 'string')) {
      malformed += 1;
      continue;
    }
    // JSON tuples avoid collisions between e.g. ['a,b'] and ['a', 'b'].
    // Duplicate provider tuples are ambiguous; never overwrite or sum them.
    const identifier = JSON.stringify(row.keys);
    if (candidates.has(identifier)) ambiguous.add(identifier);
    else candidates.set(identifier, { keys: [...row.keys], observed: metrics(row) });
  }
  for (const key of ambiguous) candidates.delete(key);
  return { candidates, ambiguous, malformed };
}
function keyOrder(a: { keys: string[] }, b: { keys: string[] }): number {
  return JSON.stringify(a.keys).localeCompare(JSON.stringify(b.keys));
}
function summarizeOne(input: ShiftAnalysisInput, earlierDays: number, laterDays: number, rankLimit: number, minImpressions: number) {
  const before = observedMap(input.earlier.rows, input.dimension);
  const after = observedMap(input.later.rows, input.dimension);
  const excluded = new Set([...before.ambiguous, ...after.ambiguous]);
  for (const key of excluded) {
    before.candidates.delete(key);
    after.candidates.delete(key);
  }
  const common: Matched[] = [];
  const earlierOnly: OneSided[] = [];
  const laterOnly: OneSided[] = [];
  for (const [id, previous] of before.candidates) {
    const recent = after.candidates.get(id);
    if (!recent) {
      earlierOnly.push(previous);
      continue;
    }
    const older = previous.observed;
    const newer = recent.observed;
    common.push({
      keys: previous.keys, earlier: older, later: newer,
      change: {
        clicks: newer.clicks - older.clicks,
        impressions: newer.impressions - older.impressions,
        ctr: newer.ctr - older.ctr,
        position: older.position !== null && newer.position !== null
          ? newer.position - older.position : null,
        clicks_percent: percent(newer.clicks, older.clicks),
        impressions_percent: percent(newer.impressions, older.impressions),
        daily_clicks: newer.clicks / laterDays - older.clicks / earlierDays,
        daily_impressions: newer.impressions / laterDays - older.impressions / earlierDays,
      },
    });
  }
  for (const [id, recent] of after.candidates) {
    if (!before.candidates.has(id)) laterOnly.push(recent);
  }
  const sameScope = common.filter((entry) =>
    entry.earlier.impressions >= minImpressions && entry.later.impressions >= minImpressions);
  const rankings = {
    clicks: sameScope.filter((entry) => entry.change.daily_clicks < 0)
      .sort((a, b) => a.change.daily_clicks - b.change.daily_clicks ||
        a.change.daily_impressions - b.change.daily_impressions || keyOrder(a, b)),
    impressions: sameScope.filter((entry) => entry.change.daily_impressions < 0)
      .sort((a, b) => a.change.daily_impressions - b.change.daily_impressions ||
        a.change.daily_clicks - b.change.daily_clicks || keyOrder(a, b)),
    average_position: sameScope.filter((entry) => entry.change.position !== null && entry.change.position > 0)
      .sort((a, b) => b.change.position! - a.change.position! ||
        a.change.daily_impressions - b.change.daily_impressions || keyOrder(a, b)),
  };
  const matchedTotals = common.reduce((acc, item) => {
    acc.earlier_clicks += item.earlier.clicks;
    acc.later_clicks += item.later.clicks;
    acc.earlier_impressions += item.earlier.impressions;
    acc.later_impressions += item.later.impressions;
    return acc;
  }, { earlier_clicks: 0, later_clicks: 0, earlier_impressions: 0, later_impressions: 0 });
  const observedUnion = before.candidates.size + after.candidates.size - common.length;
  const sample = (items: OneSided[]) => items.sort((a, b) =>
    b.observed.impressions - a.observed.impressions ||
    b.observed.clicks - a.observed.clicks || keyOrder(a, b)).slice(0, 3);
  return {
    dimension: input.dimension,
    source: {
      earlier: stripRows(input.earlier), later: stripRows(input.later),
    },
    observed_keys: {
      earlier: before.candidates.size, later: after.candidates.size,
      common: common.length, earlier_only: earlierOnly.length, later_only: laterOnly.length,
      ambiguous_excluded: excluded.size,
      malformed_excluded: before.malformed + after.malformed,
      observed_jaccard: observedUnion ? common.length / observedUnion : null,
    },
    matched_sample_totals: {
      ...matchedTotals,
      click_change: matchedTotals.later_clicks - matchedTotals.earlier_clicks,
      impression_change: matchedTotals.later_impressions - matchedTotals.earlier_impressions,
      not_property_wide: true as const,
    },
    signals: {
      position_worsening_common_keys: common.filter((entry) =>
        entry.change.position !== null && entry.change.position > 0).length,
      observed_key_mix_differs: earlierOnly.length > 0 || laterOnly.length > 0,
      not_causal_attribution: true as const,
    },
    observed_only_samples: {
      earlier: sample(earlierOnly), later: sample(laterOnly), absence_is_not_zero: true as const,
    },
    ranked_declines: {
      clicks: rankings.clicks.slice(0, rankLimit),
      impressions: rankings.impressions.slice(0, rankLimit),
      average_position: rankings.average_position.slice(0, rankLimit),
    },
    rankings_truncated: Object.values(rankings).some((items) => items.length > rankLimit),
  };
}
function stripRows(source: ShiftSource): Omit<ShiftSource, 'rows'> {
  const { rows: _rows, ...metadata } = source;
  return metadata;
}

export function buildShiftReport(input: {
  siteUrl: string;
  searchType: 'web' | 'image' | 'video' | 'news';
  dataState: 'final' | 'all';
  filters: { country?: string; device?: string; query_contains?: string; page_contains?: string };
  windows: ShiftWindows;
  sources: ShiftAnalysisInput[];
  rowsPerPage: number;
  sourcePages: number;
  includeQueryPage: boolean;
  resultLimit: number;
  minImpressionsPerPeriod: number;
}) {
  const periods = assertShiftWindows(input.windows);
  if (!Number.isInteger(input.resultLimit) || input.resultLimit < 1 || input.resultLimit > 10 ||
    !Number.isInteger(input.minImpressionsPerPeriod) || input.minImpressionsPerPeriod < 0) {
    throw new Error('Result limits or minimum impressions are invalid.');
  }
  const expected = input.includeQueryPage ? SHIFT_DIMENSIONS : SHIFT_DIMENSIONS.slice(0, 2);
  if (input.sources.length !== expected.length ||
    input.sources.some((source, index) => source.dimension !== expected[index])) {
    throw new Error('Shift source dimensions must be ordered query, page, then optional query_page.');
  }
  const analyses = input.sources.map((source) => summarizeOne(
    source, periods.earlierDays, periods.laterDays,
    input.resultLimit, input.minImpressionsPerPeriod,
  ));
  const result = {
    site_url: input.siteUrl, search_type: input.searchType,
    data_state: input.dataState, preliminary_data_possible: input.dataState === 'all',
    filters: {
      country: input.filters.country ?? null,
      device: input.filters.device ?? null,
      query_contains: input.filters.query_contains ?? null,
      page_contains: input.filters.page_contains ?? null,
    },
    periods: {
      earlier: { ...input.windows.earlier, days: periods.earlierDays },
      later: { ...input.windows.later, days: periods.laterDays },
      equal_duration: periods.equal,
      note: periods.equal
        ? 'Equal-duration, disjoint Pacific-date windows; all changes are between observed same keys.'
        : 'Unequal-duration, disjoint Pacific-date windows: prioritize daily-rate differences; raw changes are not like-for-like.',
    },
    request_budget: {
      reserved_search_analytics_calls: shiftRequestBudget(input.includeQueryPage, input.sourcePages),
      actual_initial_calls: input.sources.reduce((count, source) =>
        count + source.earlier.pages_fetched + source.later.pages_fetched, 0),
      max_source_rows_per_page: input.rowsPerPage,
      max_source_pages: input.sourcePages,
      retries_reserved_separately: true as const,
      load_quota_cost_not_equivalent_to_call_count: true as const,
    },
    analyses,
    output_byte_limit_reached: false,
    evidence_boundary: 'Measured changes use only exact dimension tuples observed in both bounded Search Analytics periods; omitted or ambiguous keys are never imputed as zero. Query, page and query-page samples overlap and MUST NOT be summed. Provider may return only top rows, including after a short page; these are neither property-wide totals nor index-coverage evidence.',
    hypotheses: [
      'Worsening average position on matched returned keys could contribute to lower visibility; it is not proof of ranking causation or a live rank.',
      'Differences in earlier-only/later-only returned keys indicate changed observed sample composition, not verified appearances, disappearances or deindexing.',
    ],
  };
  // Long Google queries/URLs make count-only bounds insufficient. Remove ranked
  // evidence last-first until the entire structured response fits safely.
  const bytes = () => new TextEncoder().encode(JSON.stringify(result)).byteLength;
  while (bytes() > 44_000) {
    const lists = analyses.flatMap((analysis) => [
      analysis.ranked_declines.average_position,
      analysis.ranked_declines.impressions,
      analysis.ranked_declines.clicks,
      analysis.observed_only_samples.later,
      analysis.observed_only_samples.earlier,
    ]);
    const candidate = lists.find((items) => items.length > 0);
    if (!candidate) {
      throw new Error('Shift report metadata exceeds the response byte budget.');
    }
    candidate.pop();
    result.output_byte_limit_reached = true;
  }
  return result;
}
