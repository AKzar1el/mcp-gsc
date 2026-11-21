import { z } from 'zod';
import { isValidCalendarDate, SEARCH_CONSOLE_TIME_ZONE } from './date-validation';
import {
  assertSearchAnalyticsQueryCompatible,
  querySearchAnalytics,
  type DataState,
  type DimensionFilterGroup,
  type SearchAnalyticsQuery,
  type SearchAnalyticsResponse,
  type SearchAnalyticsRow,
  type SearchType,
} from './google';

const DAY_MS = 86_400_000;
export const INCIDENT_TIMELINE_MAX_DAYS = 90;

export interface IncidentTimelineInput {
  site_url: string;
  start_date: string;
  end_date: string;
  baseline_start_date?: string;
  baseline_end_date?: string;
  incident_start_date?: string;
  incident_end_date?: string;
  search_type: SearchType;
  data_state: Extract<DataState, 'all' | 'final'>;
  dimension_filter_groups?: DimensionFilterGroup[];
  include_property_aggregate: boolean;
}

interface Window {
  start_date: string;
  end_date: string;
}

export interface IncidentTimelinePlan {
  input: IncidentTimelineInput;
  dates: string[];
  baseline: Window;
  incident: Window;
  window_selection: 'automatic_halves' | 'explicit';
  filtered: boolean;
  daily_query: SearchAnalyticsQuery;
  control_query?: SearchAnalyticsQuery;
  aggregate_query?: SearchAnalyticsQuery;
  search_analytics_request_budget: number;
}

export interface IncidentTimelineSources {
  daily: SearchAnalyticsResponse;
  control?: SearchAnalyticsResponse;
  aggregate?: SearchAnalyticsResponse;
}

function dateToUtc(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function inclusiveDays(start: string, end: string): number {
  return Math.round((dateToUtc(end) - dateToUtc(start)) / DAY_MS) + 1;
}

function isoDate(utcMillis: number): string {
  return new Date(utcMillis).toISOString().slice(0, 10);
}

function enumerateDates(start: string, end: string): string[] {
  const count = inclusiveDays(start, end);
  return Array.from({ length: count }, (_, i) => isoDate(dateToUtc(start) + i * DAY_MS));
}

/** Validate before reserving quota. Each source query returns at most 90 rows. */
export function planIncidentTimeline(input: IncidentTimelineInput): IncidentTimelinePlan {
  if (!isValidCalendarDate(input.start_date) || !isValidCalendarDate(input.end_date)
      || input.start_date > input.end_date) {
    throw new Error('Incident timeline requires valid, ordered inclusive calendar dates.');
  }
  const count = inclusiveDays(input.start_date, input.end_date);
  if (count < 4 || count > INCIDENT_TIMELINE_MAX_DAYS) {
    throw new Error('Incident timeline requires 4-90 inclusive calendar days.');
  }

  const explicit = [
    input.baseline_start_date, input.baseline_end_date,
    input.incident_start_date, input.incident_end_date,
  ];
  if (explicit.some((date) => date !== undefined) && explicit.some((date) => date === undefined)) {
    throw new Error('Supply all four baseline/incident date bounds, or omit all four.');
  }
  let baseline: Window;
  let incident: Window;
  if (explicit.every((date) => date !== undefined)) {
    baseline = {
      start_date: input.baseline_start_date!,
      end_date: input.baseline_end_date!,
    };
    incident = {
      start_date: input.incident_start_date!,
      end_date: input.incident_end_date!,
    };
    if (![baseline.start_date, baseline.end_date, incident.start_date, incident.end_date]
      .every(isValidCalendarDate)
      || baseline.start_date < input.start_date || baseline.end_date > input.end_date
      || incident.start_date < input.start_date || incident.end_date > input.end_date
      || baseline.start_date > baseline.end_date || incident.start_date > incident.end_date
      || baseline.end_date >= incident.start_date
      || inclusiveDays(baseline.start_date, baseline.end_date) < 2
      || inclusiveDays(incident.start_date, incident.end_date) < 2) {
      throw new Error('Baseline and incident windows must each span at least two dates, stay within the requested range, and be ordered without overlap.');
    }
  } else {
    const baselineDays = Math.floor(count / 2);
    baseline = { start_date: input.start_date, end_date: isoDate(dateToUtc(input.start_date) + (baselineDays - 1) * DAY_MS) };
    incident = { start_date: isoDate(dateToUtc(input.start_date) + baselineDays * DAY_MS), end_date: input.end_date };
  }

  const groups = input.dimension_filter_groups;
  const filtered = !!groups?.some((group) => group.filters.length > 0 || (group.filterLists?.length ?? 0) > 0);
  const common: SearchAnalyticsQuery = {
    startDate: input.start_date,
    endDate: input.end_date,
    dimensions: ['date'],
    rowLimit: count,
    startRow: 0,
    type: input.search_type,
    dataState: input.data_state,
    aggregationType: 'auto',
  };
  const daily_query: SearchAnalyticsQuery = filtered ? { ...common, dimensionFilterGroups: groups } : common;
  // Google's documented way to distinguish segment omissions from a property
  // with no returned data is an unfiltered date-grouped control request.
  const control_query: SearchAnalyticsQuery | undefined = filtered ? common : undefined;
  // Optional keyless aggregate is contextual evidence, not a substitute for
  // daily observations and not directly comparable to a filtered segment.
  const aggregate_query: SearchAnalyticsQuery | undefined = input.include_property_aggregate
    ? { ...common, dimensions: [], rowLimit: 1 }
    : undefined;
  for (const query of [daily_query, control_query, aggregate_query]) {
    if (query) assertSearchAnalyticsQueryCompatible(query);
  }
  return {
    input,
    dates: enumerateDates(input.start_date, input.end_date),
    baseline,
    incident,
    window_selection: explicit.every((date) => date !== undefined) ? 'explicit' : 'automatic_halves',
    filtered,
    daily_query,
    ...(control_query ? { control_query } : {}),
    ...(aggregate_query ? { aggregate_query } : {}),
    search_analytics_request_budget: 1 + Number(!!control_query) + Number(!!aggregate_query),
  };
}

/** Sequential, bounded Google reads; caller reserves the entire initial fan-out first. */
export async function fetchIncidentTimelineSources(
  token: string,
  plan: IncidentTimelinePlan,
  beforeRetry: () => Promise<void>,
): Promise<IncidentTimelineSources> {
  const siteUrl = plan.input.site_url;
  const daily = await querySearchAnalytics(token, siteUrl, plan.daily_query, beforeRetry);
  const control = plan.control_query
    ? await querySearchAnalytics(token, siteUrl, plan.control_query, beforeRetry) : undefined;
  const aggregate = plan.aggregate_query
    ? await querySearchAnalytics(token, siteUrl, plan.aggregate_query, beforeRetry) : undefined;
  return { daily, ...(control ? { control } : {}), ...(aggregate ? { aggregate } : {}) };
}

const nullableMetric = z.number().finite().nullable();
const periodSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  expected_days: z.number().int().nonnegative(),
  observed_days: z.number().int().nonnegative(),
  omitted_days: z.number().int().nonnegative(),
  preliminary_days: z.number().int().nonnegative(),
  clicks: z.number().nonnegative(),
  impressions: z.number().nonnegative(),
  pooled_ctr: nullableMetric,
  impression_weighted_position: nullableMetric,
  position_coverage: z.enum(['complete', 'partially_missing', 'no_impressions', 'unsupported']),
  clicks_per_observed_day: nullableMetric,
  impressions_per_observed_day: nullableMetric,
});

export const INCIDENT_TIMELINE_OUTPUT_SCHEMA = {
  site_url: z.string(),
  search_type: z.string(),
  data_state: z.enum(['final', 'all']),
  position_supported: z.boolean(),
  source: z.object({
    provider: z.literal('Google Search Console Search Analytics API'),
    endpoint: z.string(),
    timezone: z.literal('America/Los_Angeles'),
    daily_dimensions: z.array(z.literal('date')),
    requested_aggregation_type: z.literal('auto'),
    verified_permission_level: z.string(),
    filter_group_count: z.number().int().nonnegative(),
    filtered: z.boolean(),
    analytics_initial_requests_reserved: z.number().int().min(1).max(3),
    analytics_retry_requests_reserved: z.number().int().nonnegative(),
    property_verification_initial_requests_reserved: z.literal(1),
    property_verification_retry_requests_reserved: z.number().int().nonnegative(),
    daily_response_aggregation_type: z.string().nullable(),
    control_response_aggregation_type: z.string().nullable(),
    aggregate_response_aggregation_type: z.string().nullable(),
    daily_metadata: z.object({
      first_incomplete_date: z.string().nullable(),
      first_incomplete_hour: z.string().nullable(),
    }),
    control_metadata: z.object({
      first_incomplete_date: z.string().nullable(),
      first_incomplete_hour: z.string().nullable(),
    }).nullable(),
    provider_exhaustiveness_guaranteed: z.literal(false),
  }),
  observation: z.object({
    start_date: z.string(),
    end_date: z.string(),
    expected_days: z.number().int(),
    reported_days: z.number().int(),
    omitted_days: z.number().int(),
    preliminary_days: z.number().int(),
    all_days_reported_and_final: z.boolean(),
    first_incomplete_date: z.string().nullable(),
    first_incomplete_hour: z.string().nullable(),
    note: z.string(),
  }),
  daily: z.array(z.object({
    date: z.string(),
    state: z.enum(['reported', 'reported_zero', 'omitted']),
    preliminary: z.boolean(),
    property_control_has_reported_date: z.boolean().nullable(),
    clicks: nullableMetric,
    impressions: nullableMetric,
    ctr: nullableMetric,
    position: nullableMetric,
  })).max(INCIDENT_TIMELINE_MAX_DAYS),
  baseline: periodSchema,
  incident: periodSchema,
  window_selection: z.enum(['explicit', 'automatic_halves']),
  comparison: z.object({
    status: z.enum(['complete_observed', 'partial_observed', 'insufficient_observations']),
    daily_impressions_change: nullableMetric,
    daily_impressions_change_pct: nullableMetric,
    daily_clicks_change: nullableMetric,
    daily_clicks_change_pct: nullableMetric,
    pooled_ctr_change_percentage_points: nullableMetric,
    impression_weighted_position_change: nullableMetric,
    note: z.string(),
  }),
  change_points: z.array(z.object({
    date: z.string(),
    direction: z.enum(['decline', 'increase']),
    preceding_three_day_median_impressions: z.number(),
    following_two_day_median_impressions: z.number(),
    impressions_change_pct: z.number(),
    note: z.string(),
  })).max(4),
  property_aggregate: z.object({
    available: z.boolean(),
    clicks: nullableMetric,
    impressions: nullableMetric,
    pooled_ctr: nullableMetric,
    impression_weighted_position: nullableMetric,
    daily_alignment: z.enum(['matching_observed_totals', 'different_observed_totals', 'different_scope', 'insufficient_daily_evidence', 'aggregate_omitted']),
  }).nullable(),
  interpretation_note: z.string(),
};

type TimelineDay = z.infer<typeof INCIDENT_TIMELINE_OUTPUT_SCHEMA.daily>[number];
// A separate row lookup prevents provider ordering from influencing chronology.
function indexedRows(rows: SearchAnalyticsRow[], dates: ReadonlySet<string>): Map<string, SearchAnalyticsRow> {
  const result = new Map<string, SearchAnalyticsRow>();
  for (const row of rows) {
    const date = row.keys?.[0];
    if (!date || !isValidCalendarDate(date) || !dates.has(date) || result.has(date)) {
      throw new Error('Google returned an invalid, duplicate or out-of-window incident timeline date.');
    }
    result.set(date, row);
  }
  return result;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function periodMetrics(
  window: Window,
  daily: TimelineDay[],
  positionSupported: boolean,
): z.infer<typeof periodSchema> {
  const days = daily.filter((day) => day.date >= window.start_date && day.date <= window.end_date);
  const reported = days.filter((day) => day.state !== 'omitted');
  const clicks = reported.reduce((total, day) => total + (day.clicks ?? 0), 0);
  const impressions = reported.reduce((total, day) => total + (day.impressions ?? 0), 0);
  const relevantPositions = reported.filter((day) => (day.impressions ?? 0) > 0);
  const positionCoverage = !positionSupported ? 'unsupported'
    : relevantPositions.length === 0 ? 'no_impressions'
    : relevantPositions.some((day) => day.position === null) ? 'partially_missing'
    : 'complete';
  const position = positionCoverage === 'complete'
    ? relevantPositions.reduce((total, day) => total + day.position! * day.impressions!, 0) / impressions
    : null;
  return {
    ...window,
    expected_days: days.length,
    observed_days: reported.length,
    omitted_days: days.length - reported.length,
    preliminary_days: days.filter((day) => day.preliminary).length,
    clicks,
    impressions,
    pooled_ctr: impressions > 0 ? clicks / impressions : null,
    impression_weighted_position: position,
    position_coverage: positionCoverage,
    clicks_per_observed_day: reported.length ? clicks / reported.length : null,
    impressions_per_observed_day: reported.length ? impressions / reported.length : null,
  };
}

function relativeChange(base: number | null, next: number | null): number | null {
  return base === null || next === null || base === 0 ? null : ((next - base) / base) * 100;
}

function abruptChanges(daily: TimelineDay[]): z.infer<typeof INCIDENT_TIMELINE_OUTPUT_SCHEMA.change_points> {
  const candidates: z.infer<typeof INCIDENT_TIMELINE_OUTPUT_SCHEMA.change_points> = [];
  for (let i = 3; i + 1 < daily.length; i++) {
    const surrounding = daily.slice(i - 3, i + 2);
    if (surrounding.some((day) => day.state === 'omitted' || day.preliminary)) continue;
    const pre = median(surrounding.slice(0, 3).map((day) => day.impressions!));
    const post = median(surrounding.slice(3).map((day) => day.impressions!));
    if (pre < 20) continue; // Avoid unstable relative changes at negligible volume.
    const ratio = post / pre;
    if (ratio > 0.5 && ratio < 2) continue;
    candidates.push({
      date: daily[i].date,
      direction: ratio <= 0.5 ? 'decline' : 'increase',
      preceding_three_day_median_impressions: pre,
      following_two_day_median_impressions: post,
      impressions_change_pct: (ratio - 1) * 100,
      note: 'Heuristic candidate only: 3 reported prior dates versus 2 reported following dates; no causal or statistical attribution.',
    });
  }
  // Prevent one sustained drop from producing several nearby candidates.
  const strongest = [...candidates].sort((a, b) =>
    Math.abs(b.impressions_change_pct) - Math.abs(a.impressions_change_pct)
    || a.date.localeCompare(b.date));
  const selected: typeof candidates = [];
  for (const candidate of strongest) {
    if (selected.some((item) => Math.abs(dateToUtc(item.date) - dateToUtc(candidate.date)) <= 2 * DAY_MS)) continue;
    selected.push(candidate);
    if (selected.length >= 4) break;
  }
  return selected.sort((a, b) => a.date.localeCompare(b.date));
}

export const INCIDENT_TIMELINE_RESULT_SCHEMA = z.object(INCIDENT_TIMELINE_OUTPUT_SCHEMA);
export type IncidentTimelineOutput = z.infer<typeof INCIDENT_TIMELINE_RESULT_SCHEMA>;

export function buildIncidentTimeline(
  plan: IncidentTimelinePlan,
  sources: IncidentTimelineSources,
  verification: {
    permission_level: string;
    analytics_retries: number;
    metadata_retries: number;
  },
): IncidentTimelineOutput {
  const { input } = plan;
  const knownDates = new Set(plan.dates);
  const rows = indexedRows(sources.daily.rows, knownDates);
  const control = sources.control ? indexedRows(sources.control.rows, knownDates) : null;
  const aggregateRows = sources.aggregate?.rows;
  if (aggregateRows && (aggregateRows.length > 1 || aggregateRows.some((row) => row.keys !== undefined))) {
    throw new Error('Google returned invalid keyless property aggregate rows.');
  }
  const dayMetadata = sources.daily.metadata;
  const controlMetadata = sources.control?.metadata;
  const incompleteCandidates = [
    dayMetadata?.first_incomplete_date,
    dayMetadata?.first_incomplete_hour?.slice(0, 10),
    controlMetadata?.first_incomplete_date,
    controlMetadata?.first_incomplete_hour?.slice(0, 10),
  ].filter((value): value is string => value !== undefined);
  const firstIncomplete = incompleteCandidates.sort()[0] ?? null;
  const positionSupported = input.search_type !== 'discover' && input.search_type !== 'googleNews';
  const daily = plan.dates.map((date) => {
    const row = rows.get(date);
    const preliminary = input.data_state === 'all' && firstIncomplete !== null && date >= firstIncomplete;
    return {
      date,
      state: !row ? 'omitted' as const
        : row.clicks === 0 && row.impressions === 0 ? 'reported_zero' as const : 'reported' as const,
      preliminary,
      property_control_has_reported_date: control === null ? null : control.has(date),
      clicks: row ? row.clicks : null,
      impressions: row ? row.impressions : null,
      ctr: row && row.impressions > 0 ? row.clicks / row.impressions : null,
      position: row && row.impressions > 0 && positionSupported ? row.position ?? null : null,
    };
  });
  const baseline = periodMetrics(plan.baseline, daily, positionSupported);
  const incident = periodMetrics(plan.incident, daily, positionSupported);
  const status = baseline.observed_days === 0 || incident.observed_days === 0
    ? 'insufficient_observations' as const
    : baseline.omitted_days || incident.omitted_days || baseline.preliminary_days || incident.preliminary_days
      ? 'partial_observed' as const : 'complete_observed' as const;
  const diff = (before: number | null, after: number | null): number | null =>
    before === null || after === null ? null : after - before;
  const completeDaily = daily.every((day) => day.state !== 'omitted' && !day.preliminary);
  const aggregateRow = aggregateRows?.[0];
  const alignment = !aggregateRows || aggregateRows.length === 0 ? 'aggregate_omitted' as const
    : plan.filtered ? 'different_scope' as const
    : !completeDaily ? 'insufficient_daily_evidence' as const
    : aggregateRow!.clicks === daily.reduce((sum, day) => sum + day.clicks!, 0)
      && aggregateRow!.impressions === daily.reduce((sum, day) => sum + day.impressions!, 0)
      ? 'matching_observed_totals' as const : 'different_observed_totals' as const;
  const propertyAggregate = !sources.aggregate ? null : {
    available: !!aggregateRow,
    clicks: aggregateRow?.clicks ?? null,
    impressions: aggregateRow?.impressions ?? null,
    pooled_ctr: aggregateRow && aggregateRow.impressions > 0
      ? aggregateRow.clicks / aggregateRow.impressions : null,
    impression_weighted_position: aggregateRow && positionSupported
      && aggregateRow.impressions > 0 ? aggregateRow.position ?? null : null,
    daily_alignment: alignment,
  };
  return {
    site_url: input.site_url,
    search_type: input.search_type,
    data_state: input.data_state,
    position_supported: positionSupported,
    source: {
      provider: 'Google Search Console Search Analytics API',
      endpoint: 'POST /webmasters/v3/sites/{siteUrl}/searchAnalytics/query',
      timezone: SEARCH_CONSOLE_TIME_ZONE,
      daily_dimensions: ['date'],
      requested_aggregation_type: 'auto',
      verified_permission_level: verification.permission_level,
      filter_group_count: input.dimension_filter_groups?.length ?? 0,
      filtered: plan.filtered,
      analytics_initial_requests_reserved: plan.search_analytics_request_budget,
      analytics_retry_requests_reserved: verification.analytics_retries,
      property_verification_initial_requests_reserved: 1,
      property_verification_retry_requests_reserved: verification.metadata_retries,
      daily_response_aggregation_type: sources.daily.responseAggregationType ?? null,
      control_response_aggregation_type: sources.control?.responseAggregationType ?? null,
      aggregate_response_aggregation_type: sources.aggregate?.responseAggregationType ?? null,
      daily_metadata: {
        first_incomplete_date: dayMetadata?.first_incomplete_date ?? null,
        first_incomplete_hour: dayMetadata?.first_incomplete_hour ?? null,
      },
      control_metadata: sources.control ? {
        first_incomplete_date: controlMetadata?.first_incomplete_date ?? null,
        first_incomplete_hour: controlMetadata?.first_incomplete_hour ?? null,
      } : null,
      provider_exhaustiveness_guaranteed: false,
    },
    observation: {
      start_date: input.start_date,
      end_date: input.end_date,
      expected_days: plan.dates.length,
      reported_days: rows.size,
      omitted_days: plan.dates.length - rows.size,
      preliminary_days: daily.filter((day) => day.preliminary).length,
      all_days_reported_and_final: completeDaily,
      first_incomplete_date: firstIncomplete,
      first_incomplete_hour: dayMetadata?.first_incomplete_hour ?? controlMetadata?.first_incomplete_hour ?? null,
      note: 'Google omits dates with no returned Search Analytics data. Omitted is not measured zero; even full date coverage does not guarantee provider-level exhaustiveness.',
    },
    daily,
    baseline,
    incident,
    window_selection: plan.window_selection,
    comparison: {
      status,
      daily_impressions_change: diff(baseline.impressions_per_observed_day, incident.impressions_per_observed_day),
      daily_impressions_change_pct: relativeChange(baseline.impressions_per_observed_day, incident.impressions_per_observed_day),
      daily_clicks_change: diff(baseline.clicks_per_observed_day, incident.clicks_per_observed_day),
      daily_clicks_change_pct: relativeChange(baseline.clicks_per_observed_day, incident.clicks_per_observed_day),
      pooled_ctr_change_percentage_points: diff(baseline.pooled_ctr, incident.pooled_ctr) === null
        ? null : (incident.pooled_ctr! - baseline.pooled_ctr!) * 100,
      impression_weighted_position_change: diff(baseline.impression_weighted_position, incident.impression_weighted_position),
      note: status === 'complete_observed'
        ? 'Changes compare reported calendar-day averages and pooled period metrics; they do not establish causation.'
        : 'Changes use only returned, observed days and may be biased by omissions or preliminary data. Do not treat them as finalized full-window changes.',
    },
    change_points: abruptChanges(daily),
    property_aggregate: propertyAggregate,
    interpretation_note: 'Change points are descriptive candidates, not proof of a Google algorithm update, ranking penalty, indexing issue, or any particular cause. Search surfaces and filters must match before comparisons.',
  };
}
