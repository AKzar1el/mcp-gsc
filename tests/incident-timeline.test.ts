import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildIncidentTimeline,
  fetchIncidentTimelineSources,
  planIncidentTimeline,
  INCIDENT_TIMELINE_MAX_DAYS,
  INCIDENT_TIMELINE_RESULT_SCHEMA,
  type IncidentTimelineInput,
} from '../src/incident-timeline';
import type { SearchAnalyticsResponse, SearchAnalyticsRow } from '../src/google';

function input(overrides: Partial<IncidentTimelineInput> = {}): IncidentTimelineInput {
  return {
    site_url: 'sc-domain:example.test',
    start_date: '2026-09-01',
    end_date: '2026-09-10',
    search_type: 'web',
    data_state: 'final',
    include_property_aggregate: false,
    ...overrides,
  };
}

function row(date: string, clicks: number, impressions: number, position?: number): SearchAnalyticsRow {
  return {
    keys: [date],
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : 0,
    ...(position !== undefined ? { position } : {}),
  };
}

function analyze(
  args: IncidentTimelineInput,
  dailyRows: SearchAnalyticsRow[],
  extras: Partial<{
    metadata: SearchAnalyticsResponse['metadata'];
    control: SearchAnalyticsResponse;
    aggregate: SearchAnalyticsResponse;
  }> = {},
) {
  const plan = planIncidentTimeline(args);
  const result = buildIncidentTimeline(plan, {
    daily: { rows: dailyRows, ...(extras.metadata ? { metadata: extras.metadata } : {}) },
    ...(extras.control ? { control: extras.control } : {}),
    ...(extras.aggregate ? { aggregate: extras.aggregate } : {}),
  }, { permission_level: 'siteFullUser', analytics_retries: 0, metadata_retries: 0 });
  assert.doesNotThrow(() => INCIDENT_TIMELINE_RESULT_SCHEMA.parse(result));
  return result;
}

test('bounded timeline validates explicit windows and provider query compatibility before quota use', () => {
  assert.equal(planIncidentTimeline(input()).search_analytics_request_budget, 1);
  assert.equal(planIncidentTimeline(input()).window_selection, 'automatic_halves');
  assert.deepEqual(planIncidentTimeline(input()).baseline, {
    start_date: '2026-09-01', end_date: '2026-09-05',
  });
  assert.deepEqual(planIncidentTimeline(input()).incident, {
    start_date: '2026-09-06', end_date: '2026-09-10',
  });
  for (const overrides of [
    { start_date: '2026-02-30', end_date: '2026-03-04' },
    { start_date: '2026-09-01', end_date: '2026-09-03' },
    { start_date: '2026-09-10', end_date: '2026-09-01' },
    { end_date: '2026-12-15' },
  ] as Partial<IncidentTimelineInput>[]) {
    assert.throws(() => planIncidentTimeline(input(overrides)), /Incident timeline|calendar/i);
  }
  const tooLong = input({ start_date: '2026-01-01', end_date: '2026-05-01' });
  assert.throws(() => planIncidentTimeline(tooLong), /4-90/);
  assert.equal(INCIDENT_TIMELINE_MAX_DAYS, 90);
  assert.throws(() => planIncidentTimeline(input({ baseline_start_date: '2026-09-01' })), /all four/);
  assert.throws(() => planIncidentTimeline(input({
    baseline_start_date: '2026-09-01', baseline_end_date: '2026-09-06',
    incident_start_date: '2026-09-06', incident_end_date: '2026-09-10',
  })), /without overlap/);
  assert.throws(() => planIncidentTimeline(input({
    baseline_start_date: '2026-09-01', baseline_end_date: '2026-09-01',
    incident_start_date: '2026-09-06', incident_end_date: '2026-09-10',
  })), /at least two/);
  assert.throws(() => planIncidentTimeline(input({
    search_type: 'discover',
    dimension_filter_groups: [{
      groupType: 'and',
      filters: [{ dimension: 'query', operator: 'contains', expression: 'topic' }],
    }],
  })), /does not support.*query/i);
});

test('synthetic abrupt search collapse produces correct daily and window deltas without causation', () => {
  const args = input();
  const dates = planIncidentTimeline(args).dates;
  const rows = dates.map((day, i) => i < 5
    ? row(day, 100, 1_000, 3)
    : row(day, 2, 30, 19));
  const result = analyze(args, rows);
  assert.equal(result.observation.all_days_reported_and_final, true);
  assert.equal(result.baseline.impressions, 5_000);
  assert.equal(result.incident.impressions, 150);
  assert.equal(result.comparison.daily_impressions_change_pct, -97);
  assert.equal(result.comparison.daily_clicks_change_pct, -98);
  assert.equal(result.comparison.status, 'complete_observed');
  assert.equal(result.baseline.pooled_ctr, 0.1);
  assert.equal(result.incident.pooled_ctr, 2 / 30);
  assert.equal(result.comparison.pooled_ctr_change_percentage_points, ((2 / 30) - 0.1) * 100);
  assert.equal(result.comparison.impression_weighted_position_change, 16);
  assert.equal(result.change_points[0]?.date, '2026-09-06');
  assert.equal(result.change_points[0]?.direction, 'decline');
  assert.equal(result.change_points[0]?.impressions_change_pct, -97);
  assert.match(result.interpretation_note, /not proof.*algorithm update/i);
});

test('reported zero, omitted dates and unfiltered property control are separate evidence states', () => {
  const args = input({
    start_date: '2026-09-01', end_date: '2026-09-04',
    dimension_filter_groups: [{
      groupType: 'and', filters: [{ dimension: 'device', operator: 'equals', expression: 'DESKTOP' }],
    }],
    include_property_aggregate: true,
  });
  const plan = planIncidentTimeline(args);
  assert.equal(plan.search_analytics_request_budget, 3);
  assert.equal(plan.daily_query.dimensionFilterGroups?.length, 1);
  assert.equal(plan.control_query?.dimensionFilterGroups, undefined);
  assert.deepEqual(plan.aggregate_query?.dimensions, []);
  const result = analyze(args, [
    row('2026-09-01', 0, 0),
    row('2026-09-03', 0, 20, 11),
    row('2026-09-04', 2, 20, 8),
  ], {
    control: { rows: plan.dates.map((day) => row(day, 20, 100, 4)) },
    aggregate: { rows: [{ clicks: 80, impressions: 400, ctr: 0.2, position: 4 }] },
  });
  assert.equal(result.daily[0].state, 'reported_zero');
  assert.equal(result.daily[0].clicks, 0);
  assert.equal(result.daily[0].impressions, 0);
  assert.equal(result.daily[0].ctr, null);
  assert.equal(result.daily[1].state, 'omitted');
  assert.equal(result.daily[1].clicks, null);
  assert.equal(result.daily[1].property_control_has_reported_date, true);
  assert.equal(result.daily[2].state, 'reported');
  assert.equal(result.observation.omitted_days, 1);
  assert.equal(result.comparison.status, 'partial_observed');
  assert.equal(result.property_aggregate?.daily_alignment, 'different_scope');
  assert.equal(result.property_aggregate?.impressions, 400);
  assert.equal(result.source.analytics_initial_requests_reserved, 3);
});

test('first incomplete date/hour metadata is preserved, and incomplete days suppress change candidates', () => {
  const args = input({ data_state: 'all' });
  const dates = planIncidentTimeline(args).dates;
  const result = analyze(args, dates.map((day, i) =>
    row(day, i < 7 ? 40 : 0, i < 7 ? 400 : 0, 5)), {
    metadata: {
      first_incomplete_date: '2026-09-08',
      first_incomplete_hour: '2026-09-08T13:00:00-07:00',
    },
  });
  assert.equal(result.observation.first_incomplete_date, '2026-09-08');
  assert.equal(result.observation.first_incomplete_hour, '2026-09-08T13:00:00-07:00');
  assert.equal(result.observation.preliminary_days, 3);
  assert.equal(result.daily[7].preliminary, true);
  assert.equal(result.comparison.status, 'partial_observed');
  assert.equal(result.change_points.length, 0);
  assert.equal(result.source.daily_metadata.first_incomplete_date, '2026-09-08');
});

test('period CTR is pooled and position is weighted by impressions, never daily arithmetic averages', () => {
  const args = input({ start_date: '2026-09-01', end_date: '2026-09-04' });
  const result = analyze(args, [
    row('2026-09-01', 10, 100, 2),
    row('2026-09-02', 1, 10, 20),
    row('2026-09-03', 20, 40, 6),
    row('2026-09-04', 0, 60, 12),
  ]);
  assert.equal(result.baseline.pooled_ctr, 11 / 110);
  assert.equal(result.baseline.impression_weighted_position, 400 / 110);
  assert.equal(result.incident.pooled_ctr, 0.2);
  assert.equal(result.incident.impression_weighted_position, (40 * 6 + 60 * 12) / 100);
  assert.equal(result.comparison.pooled_ctr_change_percentage_points, (0.2 - 0.1) * 100);
  assert.equal(result.property_aggregate, null);
  assert.equal(result.source.analytics_initial_requests_reserved, 1);
});

test('unsupported and absent position stay null, without losing impressions or clicks', () => {
  const args = input({ search_type: 'discover', start_date: '2026-09-01', end_date: '2026-09-04' });
  const rows = planIncidentTimeline(args).dates.map((day) => row(day, 6, 60));
  const discover = analyze(args, rows);
  assert.equal(discover.position_supported, false);
  assert.equal(discover.baseline.position_coverage, 'unsupported');
  assert.equal(discover.baseline.impression_weighted_position, null);
  assert.equal(discover.comparison.impression_weighted_position_change, null);
  assert.equal(discover.baseline.impressions, 120);
  const web = analyze(input({
    start_date: '2026-09-01', end_date: '2026-09-04',
  }), [row('2026-09-01', 6, 60), row('2026-09-02', 6, 60, 5), ...rows.slice(2)]);
  assert.equal(web.baseline.position_coverage, 'partially_missing');
  assert.equal(web.baseline.impression_weighted_position, null);
});

test('fully omitted provider dates are not counted as zero or an incident decline', () => {
  const result = analyze(input({
    start_date: '2026-09-01', end_date: '2026-09-04',
  }), []);
  assert.equal(result.observation.reported_days, 0);
  assert.equal(result.observation.omitted_days, 4);
  assert.equal(result.baseline.clicks_per_observed_day, null);
  assert.equal(result.incident.impressions_per_observed_day, null);
  assert.equal(result.comparison.daily_impressions_change_pct, null);
  assert.equal(result.comparison.status, 'insufficient_observations');
  assert.equal(result.change_points.length, 0);
});

test('unexpected duplicate or out-of-range provider date rows fail closed', () => {
  const args = input({ start_date: '2026-09-01', end_date: '2026-09-04' });
  assert.throws(() => analyze(args, [
    row('2026-09-01', 1, 10), row('2026-09-01', 1, 10),
  ]), /duplicate or out-of-window/);
  assert.throws(() => analyze(args, [row('2026-08-31', 1, 10)]), /duplicate or out-of-window/);
});

test('provider request plan calls exactly the bounded authenticated Search Analytics endpoints', async () => {
  const args = input({
    start_date: '2026-09-01', end_date: '2026-09-04',
    include_property_aggregate: true,
    dimension_filter_groups: [{
      groupType: 'and', filters: [{ dimension: 'device', operator: 'equals', expression: 'MOBILE' }],
    }],
  });
  const plan = planIncidentTimeline(args);
  const observed: unknown[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/webmasters\/v3\/sites\/sc-domain%3Aexample.test\/searchAnalytics\/query$/);
    assert.equal(init?.method, 'POST');
    assert.match(String((init?.headers as Record<string, string>).authorization), /^Bearer /);
    const body = JSON.parse(String(init?.body)) as {
      dimensions: string[];
      dimensionFilterGroups?: unknown[];
      rowLimit: number;
    };
    observed.push(body);
    return new Response(JSON.stringify({
      rows: body.dimensions.length === 0
        ? [{ clicks: 5, impressions: 100, ctr: 0.05, position: 9 }]
        : [row('2026-09-01', 5, 100, 9)],
      responseAggregationType: 'auto',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await fetchIncidentTimelineSources('synthetic-token', plan, async () => {
      throw new Error('No provider retries expected in this success case.');
    });
    assert.equal(observed.length, 3);
    assert.equal((observed[0] as { rowLimit: number }).rowLimit, 4);
    assert.ok((observed[0] as { dimensionFilterGroups?: unknown[] }).dimensionFilterGroups);
    assert.equal((observed[1] as { dimensionFilterGroups?: unknown[] }).dimensionFilterGroups, undefined);
    assert.deepEqual((observed[2] as { dimensions: string[] }).dimensions, []);
    assert.equal(result.aggregate?.rows[0]?.impressions, 100);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('provider errors propagate rather than being converted into misleading empty results', async () => {
  const plan = planIncidentTimeline(input({
    start_date: '2026-09-01', end_date: '2026-09-04',
  }));
  let count = 0;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    count += 1;
    return new Response(JSON.stringify({ error: { message: 'Invalid property access' } }), {
      status: 403, headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await assert.rejects(
      fetchIncidentTimelineSources('synthetic-token', plan, async () => {}),
      /Search analytics query failed: 403/,
    );
    assert.equal(count, 1);
  } finally {
    globalThis.fetch = savedFetch;
  }
});
