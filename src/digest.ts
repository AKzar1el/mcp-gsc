import {
  hasRecordedPosition,
  querySearchAnalytics,
  type DimensionFilterGroup,
  type SearchAnalyticsRow,
} from './google';
import type { GoogleAccessTokenProvider } from './access-token-lifecycle';
import { getSearchConsoleCalendarDate } from './date-validation';

interface DateRanges {
  currentStart: string;
  currentEnd: string;
  prevStart: string;
  prevEnd: string;
}

interface SiteTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface QueryRow {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface PageRow {
  page: string;
  clicks: number;
  impressions: number;
}

type MoverType = 'rising' | 'falling' | 'new_impressions';

interface Mover {
  type: MoverType;
  query: string;
  currentClicks: number;
  prevClicks: number;
  currentImpressions: number;
  prevImpressions: number;
  currentPosition: number;
  prevPosition: number;
  change: number;
}

interface Movers {
  rising: Mover[];
  falling: Mover[];
  newImpressions: Mover[];
}

interface ObservedQueryOverlap {
  current: number;
  previous: number;
  common: number;
}

type ActionKey =
  | 'indexing_blocked'
  | 'ctr_zero'
  | 'investigate_drop'
  | 'promote_rising'
  | 'celebrate_and_double_down'
  | 'publish_one_post'
  | 'review_search_surface';

interface ActionItem {
  headline: string;
  why: string;
  how: string;
}

export function resolveWeeklyDigestEndDate(
  endDate: string | undefined,
  today: string,
): string {
  if (endDate) return endDate;

  const latestCompleteDate = new Date(`${today}T00:00:00Z`);
  latestCompleteDate.setUTCDate(latestCompleteDate.getUTCDate() - 3);
  return latestCompleteDate.toISOString().slice(0, 10);
}

/** Preliminary snapshots use current-week evidence only; finalized reports compare both weeks. */
export function weeklyDigestAnalyticsRequestCount(endDate: string, today: string): 3 | 5 {
  return endDate > resolveWeeklyDigestEndDate(undefined, today) ? 3 : 5;
}

export async function generateWeeklyDigest(
  accessTokens: GoogleAccessTokenProvider,
  googleId: string,
  siteUrl: string,
  endDate: string,
  beforeRetry?: () => Promise<void>,
  today: string = getSearchConsoleCalendarDate(),
  pageContains?: string,
  searchType: 'web' | 'image' | 'video' | 'news' = 'web',
  device?: 'desktop' | 'mobile' | 'tablet',
  queryContains?: string,
  country?: string,
): Promise<string> {
  const dates = computeDateRanges(endDate);
  const isPreliminary = weeklyDigestAnalyticsRequestCount(endDate, today) === 3;
  // Explicit recent dates opt into Google's fresh rows; historical/default dates remain finalized-only.
  const requestedDataState = isPreliminary ? 'all' : 'final';
  const filters: DimensionFilterGroup['filters'] = [];
  if (pageContains) {
    filters.push({ dimension: 'page', operator: 'contains', expression: pageContains });
  }
  if (device) {
    filters.push({ dimension: 'device', operator: 'equals', expression: device.toUpperCase() });
  }
  if (queryContains) {
    filters.push({ dimension: 'query', operator: 'contains', expression: queryContains });
  }
  if (country) {
    filters.push({ dimension: 'country', operator: 'equals', expression: country.toUpperCase() });
  }
  const dimensionFilterGroups: DimensionFilterGroup[] | undefined = filters.length > 0
    ? [{ groupType: 'and', filters }]
    : undefined;
  const pageScopeNotice = pageContains
    ? `> **Page URL filter:** Metrics, queries and pages include only URLs containing ${escapeMarkdownInline(pageContains)} (case-insensitive); this is not property-wide traffic.`
    : undefined;
  const deviceScopeNotice = device
    ? `> **Device filter:** ${device[0].toUpperCase() + device.slice(1)} searches only. Figures exclude other devices and are not property-wide totals.`
    : undefined;
  const queryScopeNotice = queryContains
    ? `> **Query topic filter:** ${escapeMarkdownInline(queryContains)} (case-insensitive). All figures cover only matching search queries, not property-wide totals; anonymized queries may be omitted by Google.`
    : undefined;
  const countryScopeNotice = country
    ? `> **Country filter:** ${country.toUpperCase()} (ISO 3166-1 alpha-3). Metrics include only searches attributed to this country, not property-wide traffic; a page language or URL path does not determine searcher location.`
    : undefined;
  const searchTypeNotice = searchType === 'web'
    ? undefined
    : `> **Search type:** ${searchType === 'image' ? 'Image search' : searchType === 'video' ? 'Video search' : 'Google Search News tab (not Google News app)'}. All figures are specific to this Search Console search type, not combined Web search traffic.`;
  const typeFilter = searchType === 'web' ? {} : { type: searchType };
  const accessToken = await accessTokens.getAccessToken(googleId);

  const [
    currentTotalsResponse,
    prevTotalsResponse,
    currentQueriesResponse,
    prevQueriesResponse,
    currentPagesResponse,
  ] = await Promise.all([
    querySearchAnalytics(accessToken, siteUrl, {
      startDate: dates.currentStart,
      endDate: dates.currentEnd,
      dimensions: [],
      rowLimit: 1,
      dataState: requestedDataState,
      dimensionFilterGroups,
      ...typeFilter,
    }, beforeRetry),
    // Preliminary snapshots never consume previous-week evidence.
    isPreliminary
      ? Promise.resolve(undefined)
      : querySearchAnalytics(accessToken, siteUrl, {
        startDate: dates.prevStart,
        endDate: dates.prevEnd,
        dimensions: [],
        rowLimit: 1,
        dataState: requestedDataState,
        dimensionFilterGroups,
        ...typeFilter,
      }, beforeRetry),
    querySearchAnalytics(accessToken, siteUrl, {
      startDate: dates.currentStart,
      endDate: dates.currentEnd,
      dimensions: ['query'],
      rowLimit: 25,
      dataState: requestedDataState,
      dimensionFilterGroups,
      ...typeFilter,
    }, beforeRetry),
    isPreliminary
      ? Promise.resolve(undefined)
      : querySearchAnalytics(accessToken, siteUrl, {
        startDate: dates.prevStart,
        endDate: dates.prevEnd,
        dimensions: ['query'],
        rowLimit: 25,
        dataState: requestedDataState,
        dimensionFilterGroups,
        ...typeFilter,
      }, beforeRetry),
    querySearchAnalytics(accessToken, siteUrl, {
      startDate: dates.currentStart,
      endDate: dates.currentEnd,
      dimensions: ['page'],
      rowLimit: 10,
      dataState: requestedDataState,
      dimensionFilterGroups,
      ...typeFilter,
    }, beforeRetry),
  ]);

  // Fresh totals cannot support finalized week-on-week claims. Show only directly
  // observed current-week values and clearly mark their provisional nature.
  if (isPreliminary) {
    const lines = [
      `# Your weekly site report - ${escapeMarkdownInline(siteDisplayName(siteUrl))}`,
      `### Preliminary snapshot for ${dates.currentStart} to ${dates.currentEnd}`,
      '',
      ...searchConsoleReviewLines(siteUrl),
      ...(searchTypeNotice ? [searchTypeNotice, ''] : []),
      ...(pageScopeNotice ? [pageScopeNotice, ''] : []),
      ...(deviceScopeNotice ? [deviceScopeNotice, ''] : []),
      ...(queryScopeNotice ? [queryScopeNotice, ''] : []),
      ...(countryScopeNotice ? [countryScopeNotice, ''] : []),
      '> **Preliminary Search Console data:** Explicitly requested recent dates may include incomplete metrics. Google may revise these values as reporting finishes.',
      '',
    ];
    if (currentTotalsResponse.rows.length === 0) {
      lines.push(
        '## Data availability',
        'Search Console returned no aggregate row yet for the requested week; missing data is not a measured zero.',
      );
    } else {
      const totals = totalsFromRow(currentTotalsResponse.rows[0]);
      lines.push(
        '## Available current-week metrics',
        `- ${formatNumber(totals.clicks)} clicks`,
        `- ${formatNumber(totals.impressions)} impressions`,
      );
      const pages = rowsToPages(currentPagesResponse.rows).slice(0, 3);
      if (pages.length > 0) {
        lines.push('', '## Selected returned page rows (not exhaustive)');
        for (const page of pages) {
          lines.push(`- ${escapeMarkdownInline(page.page)}: ${formatNumber(page.impressions)} impressions`);
        }
      }
      const queries = rowsToQueries(currentQueriesResponse.rows).slice(0, 3);
      if (queries.length > 0) {
        lines.push('', '## Selected returned query rows (not exhaustive)');
        for (const query of queries) {
          lines.push(`- ${escapeMarkdownInline(query.query)}: ${formatNumber(query.impressions)} impressions`);
        }
      }
    }
    lines.push(
      '',
      '## Limitations',
      'No week-over-week comparisons, query-mover conclusions, or SEO action recommendations are made from these preliminary numbers. Recheck after the week is finalized.',
    );
    return lines.join('\n');
  }

  if (!prevTotalsResponse || !prevQueriesResponse) {
    throw new Error('Finalized weekly reports require both previous-week responses.');
  }

  // No aggregate row is not a measured zero. Avoid manufacturing a weekly drop
  // or an indexing diagnosis when Search Console returns no data for either week.
  const missingPeriods = [
    ...(currentTotalsResponse.rows.length === 0
      ? [`${dates.currentStart} to ${dates.currentEnd}`]
      : []),
    ...(prevTotalsResponse.rows.length === 0
      ? [`${dates.prevStart} to ${dates.prevEnd}`]
      : []),
  ];
  if (missingPeriods.length > 0) {
    return [
      `# Your weekly site report - ${escapeMarkdownInline(siteDisplayName(siteUrl))}`,
      `### Week of ${dates.currentStart} to ${dates.currentEnd}`,
      '',
      ...searchConsoleReviewLines(siteUrl),
      ...(searchTypeNotice ? [searchTypeNotice, ''] : []),
      ...(pageScopeNotice ? [pageScopeNotice, ''] : []),
      ...(deviceScopeNotice ? [deviceScopeNotice, ''] : []),
      ...(queryScopeNotice ? [queryScopeNotice, ''] : []),
      ...(countryScopeNotice ? [countryScopeNotice, ''] : []),
      '## Data availability',
      `Google Search Console returned no aggregate Search Analytics row for ${missingPeriods.join(' and ')}.`,
      'An empty API response does not establish a measured zero for clicks or impressions. It may reflect no search activity or data that has not yet been processed.',
      'A week-over-week comparison and SEO action recommendation are withheld rather than treating absent rows as confirmed traffic loss.',
      '',
      '## What to check',
      '1. Open the Search Console Performance report and check its latest available reporting date.',
      '2. Query the same period grouped by date, or compare an earlier finalized week, to identify which days contain data.',
      '3. Search Analytics alone does not tell us whether Google crawled or indexed a URL; use this server\'s `urls.inspect` tool to inspect Google\'s indexed version of a representative URL, not the live page, before diagnosing an indexing issue.',
    ].join('\n');
  }
  const currentTotals = totalsFromRow(currentTotalsResponse.rows[0]);
  const prevTotals = totalsFromRow(prevTotalsResponse.rows[0]);
  const currentQueries = rowsToQueries(currentQueriesResponse.rows);
  const prevQueries = rowsToQueries(prevQueriesResponse.rows);
  const currentPages = rowsToPages(currentPagesResponse.rows);

  const currentQueryKeys = new Set(currentQueries.map((row) => row.query).filter(Boolean));
  const previousQueryKeys = new Set(prevQueries.map((row) => row.query).filter(Boolean));
  const observedQueryOverlap: ObservedQueryOverlap = {
    current: currentQueryKeys.size,
    previous: previousQueryKeys.size,
    common: [...currentQueryKeys].filter((query) => previousQueryKeys.has(query)).length,
  };

  const movers = computeMovers(currentQueries, prevQueries);
  const action = searchType === 'web'
    ? pickActionAndBuild(currentTotals, prevTotals, movers, currentQueries)
    : {
        key: 'review_search_surface' as const,
        item: {
          headline: 'Review this search surface before changing content',
          why: 'These observations describe one Search Console search type. Search Analytics alone does not establish the reason for a change or which optimization would help.',
          how: '1. Open the matching Search Console Performance search type for these exact dates.\n2. Check the returned query/page evidence and whether the relevant content format matches search intent.\n3. Verify a specific problem before making changes; do not apply Web snippet advice automatically to Image, Video or News-tab search.',
        },
      };

  return renderMarkdown({
    siteUrl,
    searchTypeNotice,
    pageScopeNotice,
    deviceScopeNotice,
    queryScopeNotice,
    countryScopeNotice,
    dates,
    currentTotals,
    prevTotals,
    movers,
    observedQueryOverlap,
    currentPages,
    action,
  });
}

function computeDateRanges(endDate: string): DateRanges {
  const end = new Date(`${endDate}T00:00:00Z`);
  const addDays = (date: Date, n: number): Date => {
    const d = new Date(date);
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  };
  const toISO = (d: Date): string => d.toISOString().slice(0, 10);
  return {
    currentEnd: toISO(end),
    currentStart: toISO(addDays(end, -6)),
    prevEnd: toISO(addDays(end, -7)),
    prevStart: toISO(addDays(end, -13)),
  };
}

function totalsFromRow(row: SearchAnalyticsRow | undefined): SiteTotals {
  if (!row) return { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  return {
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  };
}

function rowsToQueries(rows: SearchAnalyticsRow[]): QueryRow[] {
  return rows
    .filter(hasRecordedPosition)
    .map((r) => ({
      query: r.keys?.[0] ?? '',
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
    }));
}

function rowsToPages(rows: SearchAnalyticsRow[]): PageRow[] {
  return rows.map((r) => ({
    page: r.keys?.[0] ?? '',
    clicks: r.clicks,
    impressions: r.impressions,
  }));
}

function computeMovers(current: QueryRow[], prev: QueryRow[]): Movers {
  const prevByQuery = new Map(prev.map((q) => [q.query, q]));

  const rising: Mover[] = [];
  const falling: Mover[] = [];
  const newImpressions: Mover[] = [];

  for (const c of current) {
    const query = c.query;
    const p = prevByQuery.get(query);
    if (!p) continue;

    const cClicks = c.clicks;
    const pClicks = p.clicks;
    const cImpr = c.impressions;
    const pImpr = p.impressions;
    const cPos = c.position;
    const pPos = p.position;

    if (cClicks - pClicks >= 5 && cClicks >= 2 * Math.max(pClicks, 1)) {
      rising.push({
        type: 'rising',
        query,
        currentClicks: cClicks,
        prevClicks: pClicks,
        currentImpressions: cImpr,
        prevImpressions: pImpr,
        currentPosition: cPos,
        prevPosition: pPos,
        change: cClicks - pClicks,
      });
      continue;
    }
    if (pClicks - cClicks >= 5 && cClicks <= pClicks / 2) {
      falling.push({
        type: 'falling',
        query,
        currentClicks: cClicks,
        prevClicks: pClicks,
        currentImpressions: cImpr,
        prevImpressions: pImpr,
        currentPosition: cPos,
        prevPosition: pPos,
        change: pClicks - cClicks,
      });
      continue;
    }
    if (cClicks === 0 && pClicks === 0 && cImpr >= 20 && pImpr < 5) {
      newImpressions.push({
        type: 'new_impressions',
        query,
        currentClicks: cClicks,
        prevClicks: pClicks,
        currentImpressions: cImpr,
        prevImpressions: pImpr,
        currentPosition: cPos,
        prevPosition: pPos,
        change: cImpr - pImpr,
      });
    }
  }

  rising.sort((a, b) => b.change - a.change);
  falling.sort((a, b) => b.change - a.change);
  newImpressions.sort((a, b) => b.change - a.change);

  return {
    rising: rising.slice(0, 5),
    falling: falling.slice(0, 5),
    newImpressions: newImpressions.slice(0, 5),
  };
}

function pickActionAndBuild(
  currentTotals: SiteTotals,
  prevTotals: SiteTotals,
  movers: Movers,
  currentQueries: QueryRow[],
): { key: ActionKey; item: ActionItem } {
  if (currentTotals.impressions === 0) {
    return {
      key: 'indexing_blocked',
      item: {
        headline: 'No Google Search impressions were recorded this week',
        why: "Search Console reported zero impressions for this date range. Search Analytics alone does not tell us whether Google crawled or indexed your pages, or why they did not appear in search results. Use URL Inspection to check those signals directly.",
        how: "1. In Search Console, inspect your homepage and one important page, or use this server's `urls.inspect` tool.\n2. Check the index status, last crawl, page-fetch result, robots/noindex state, and canonical URL.\n3. Fix the specific issue URL Inspection reports. If the page is indexed and fetchable, treat zero impressions as a visibility, ranking, or query-demand problem rather than assuming an indexing failure.",
      },
    };
  }

  if (currentTotals.impressions > 0 && currentTotals.clicks === 0) {
    const realQueries = currentQueries.filter((q) => !isOperatorQuery(q.query));
    const topRealQuery = [...realQueries].sort(
      (a, b) => b.impressions - a.impressions,
    )[0];

    if (!topRealQuery) {
      if (currentQueries.length === 0) {
        return {
          key: 'ctr_zero',
          item: {
            headline: 'Search impressions recorded without visible query rows',
            why: "Search Console recorded " + formatNumber(currentTotals.impressions) + " impressions and zero clicks, but returned no query rows in this bounded result. Missing rows do not establish which searches produced the impressions.",
            how: "1. Open Search Console's Performance report for the same date range and review Queries and Pages together.\n2. Compare impressions, CTR, and average position for visible query/page pairs before changing content or snippets.\n3. Treat missing query rows as limited evidence, not proof that impressions came from search-operator checks.",
          },
        };
      }
      return {
        key: 'ctr_zero',
        item: {
          headline: 'The visible query rows are search-operator checks',
          why: "The query rows available to this digest are operator-style searches such as `site:` or `inurl:`. Those searches can be useful for diagnostics, but they do not prove that your impressions came from branded demand. Search Console's branded-query classification is a separate signal and may not be available for every property.",
          how: "1. Open Search Console's Performance report for the same date range and review Queries and Pages together.\n2. If your property offers the Branded/Non-branded query filter, use that instead of inferring brand intent from search operators.\n3. Prioritize non-operator query/page pairs with impressions but no clicks, then compare CTR and average position before deciding whether the page, snippet, or ranking needs work.",
        },
      };
    }

    return {
      key: 'ctr_zero',
      item: {
        headline: 'Your site recorded search impressions but no clicks',
        why: `Search Console recorded ${formatNumber(currentTotals.impressions)} impressions and zero clicks for this period. Impressions are search-result appearances, not unique people, and this aggregate alone does not show whether the cause is average position, search intent, SERP features, or snippet presentation.`,
        how: `1. In Search Console's Performance report, keep this same date range and filter to '${escapeMarkdownInline(topRealQuery.query)}'.\n2. Review the matching page rows, CTR, and average position, then compare them with the previous period.\n3. Change the title or meta description only if that query/page evidence suggests the snippet mismatches intent. A manual Google search can differ by location, device, and personalization, so do not treat it as authoritative reproduction.`,
      },
    };
  }

  const bigDrop = movers.falling.find((m) => m.change > 10);
  if (bigDrop) {
    return {
      key: 'investigate_drop',
      item: {
        headline: 'Search traffic for one of your queries dropped this week',
        why: `Search Console recorded ${bigDrop.prevClicks} clicks for '${escapeMarkdownInline(bigDrop.query)}' last week and ${bigDrop.currentClicks} this week. That is a measured decline, but Search Console alone does not establish whether the cause was ranking movement, demand, SERP features, a site change, or competition.`,
        how: `1. In Search Console, filter to '${escapeMarkdownInline(bigDrop.query)}' for both weeks and compare Pages, impressions, CTR, average position, Devices, and Countries.\n2. Review site changes made before the decline and treat them as hypotheses, not proven causes.\n3. If the same page lost useful visibility across supporting metrics, investigate that page and its search intent before changing it.`,
      },
    };
  }

  const risingWithWeakerAveragePosition = movers.rising.find(
    (m) => m.currentPosition > 10,
  );
  if (risingWithWeakerAveragePosition) {
    return {
      key: 'promote_rising',
      item: {
        headline: 'One of your queries is gaining clicks — inspect the opportunity',
        why: `'${escapeMarkdownInline(risingWithWeakerAveragePosition.query)}' is bringing more clicks than last week and has an average Search Console position of ${risingWithWeakerAveragePosition.currentPosition.toFixed(1)}. Average position is not a literal current rank or page number; it averages the topmost result position across recorded impressions.`,
        how: `1. In Search Console, filter to '${escapeMarkdownInline(risingWithWeakerAveragePosition.query)}' for the same date range.\n2. Review the Pages, Devices, and Countries dimensions to see where the extra clicks and impressions came from.\n3. If one page is clearly gaining useful visibility, improve that page based on the query intent and evidence you see rather than assuming an average position maps to a specific results page.`,
      },
    };
  }

  const positionImprovement = prevTotals.position - currentTotals.position;
  if (prevTotals.position > 0 && currentTotals.position > 0 && positionImprovement > 2) {
    return {
      key: 'celebrate_and_double_down',
      item: {
        headline: 'Your average Search Console position improved',
        why: `Average position improved by ${positionImprovement.toFixed(1)} this week. That is a useful trend signal, but it does not by itself prove that a specific content, technical, link, competitor, or algorithm change caused the movement.`,
        how: "1. Compare Queries and Pages for the two periods and identify which rows contributed most to the change.\n2. Check whether clicks and impressions improved for those same rows.\n3. Only connect the movement to a site change after the query/page evidence supports that explanation.",
      },
    };
  }

  return {
    key: 'publish_one_post',
    item: {
      headline: 'Review one evidence-backed search opportunity this week',
      why: 'The available Search Console data does not show one large mover that clearly deserves priority. Use the query/page rows to choose the next action instead of assuming more publishing is automatically the answer.',
      how: "1. Review Queries and Pages for impressions with few clicks or improving average position.\n2. Check whether an existing page already matches that search intent before creating anything new.\n3. Update an existing page or create a new one only when the query/page evidence supports that choice; use URL Inspection to verify index status when needed, not as a guarantee of faster indexing.",
    },
  };
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1');
}

function searchConsoleReviewLines(siteUrl: string): string[] {
  const href = `https://search.google.com/search-console/performance/search-analytics?resource_id=${encodeURIComponent(siteUrl)}`;
  return [
    `[Open this property in Search Console Performance](${href})`,
    '> Choose the same dates and filters in Search Console; this link opens the property but does not apply this report\'s filters.',
    '',
  ];
}

function renderMarkdown(data: {
  siteUrl: string;
  searchTypeNotice?: string;
  pageScopeNotice?: string;
  deviceScopeNotice?: string;
  queryScopeNotice?: string;
  countryScopeNotice?: string;
  dates: DateRanges;
  currentTotals: SiteTotals;
  prevTotals: SiteTotals;
  movers: Movers;
  observedQueryOverlap: ObservedQueryOverlap;
  currentPages: PageRow[];
  action: { key: ActionKey; item: ActionItem };
}): string {
  const { siteUrl, searchTypeNotice, pageScopeNotice, deviceScopeNotice, queryScopeNotice, countryScopeNotice, dates, currentTotals, prevTotals, movers, observedQueryOverlap, currentPages, action } = data;
  const siteName = siteDisplayName(siteUrl);
  const lines: string[] = [];

  if (isWithinLast3Days(dates.currentEnd)) {
    lines.push(
      `> Note: this digest covers the last 7 days ending ${dates.currentEnd}. Google usually finalizes search data 2–3 days after it happens, so the most recent numbers may still shift slightly.`,
    );
    lines.push('');
  }

  lines.push(`# Your weekly site report — ${escapeMarkdownInline(siteName)}`);
  lines.push(`### Week of ${dates.currentStart} to ${dates.currentEnd}`);
  lines.push('');
  lines.push(...searchConsoleReviewLines(siteUrl));
  if (searchTypeNotice) lines.push(searchTypeNotice, '');
  if (pageScopeNotice) lines.push(pageScopeNotice, '');
  if (deviceScopeNotice) lines.push(deviceScopeNotice, '');
  if (queryScopeNotice) lines.push(queryScopeNotice, '');
  if (countryScopeNotice) lines.push(countryScopeNotice, '');
  lines.push('## Quick numbers');
  lines.push('');
  lines.push(
    `- **Search-result impressions this week:** ${formatNumber(currentTotals.impressions)} (${formatPctChange(currentTotals.impressions, prevTotals.impressions)})`,
  );
  lines.push(
    `- **Clicks from Google Search:** ${formatNumber(currentTotals.clicks)} (${formatPctChange(currentTotals.clicks, prevTotals.clicks)})`,
  );
  lines.push(
    `- **Average Search Console position:** ${formatPosition(currentTotals.position)} (${formatPositionChange(currentTotals.position, prevTotals.position)})`,
  );
  lines.push('');

  lines.push('## What changed this week');
  lines.push('');
  lines.push(
    '> Query movers compare only query rows returned in both weekly Search Console result sets. A query missing from one bounded response is not treated as zero because Search Analytics returns top rows and does not guarantee every data row.',
  );
  lines.push(
    `> **Returned query-row overlap:** ${observedQueryOverlap.current} distinct current-week queries, ${observedQueryOverlap.previous} previous-week queries, ${observedQueryOverlap.common} observed in both. Each period contains at most 25 returned query rows; these counts are not exhaustive.`,
  );
  lines.push('');

  const hasAnyMovers =
    movers.rising.length > 0 ||
    movers.falling.length > 0 ||
    movers.newImpressions.length > 0;

  if (movers.rising.length > 0) {
    lines.push('### Searches gaining traction');
    lines.push('');
    for (const m of movers.rising) {
      lines.push(
        `- **"${escapeMarkdownInline(m.query)}"** — ${m.currentClicks} clicks this week (was ${m.prevClicks} last week). Average position ${m.currentPosition.toFixed(1)}.`,
      );
    }
    lines.push('');
  }

  if (movers.falling.length > 0) {
    lines.push('### Searches losing traction');
    lines.push('');
    for (const m of movers.falling) {
      lines.push(
        `- **"${escapeMarkdownInline(m.query)}"** — ${m.currentClicks} clicks this week (was ${m.prevClicks} last week). Average position ${m.currentPosition.toFixed(1)}.`,
      );
    }
    lines.push('');
  }

  if (movers.newImpressions.length > 0) {
    lines.push('### Queries gaining impressions without clicks');
    lines.push('');
    for (const m of movers.newImpressions) {
      lines.push(
        `- **"${escapeMarkdownInline(m.query)}"** — ${m.currentImpressions} impressions this week (was ${m.prevImpressions} last week).`,
      );
    }
    lines.push('');
  }

  if (!hasAnyMovers) {
    const siteImpressionsChangePct = percentageChangeOrNull(
      currentTotals.impressions,
      prevTotals.impressions,
    );
    const siteClicksChangePct = percentageChangeOrNull(
      currentTotals.clicks,
      prevTotals.clicks,
    );
    const sitePositionDelta = currentTotals.position - prevTotals.position;

    const siteHadBigMove =
      siteImpressionsChangePct === null ||
      siteClicksChangePct === null ||
      Math.abs(siteImpressionsChangePct) >= 25 ||
      Math.abs(siteClicksChangePct) >= 25 ||
      Math.abs(sitePositionDelta) >= 3;

    if (siteHadBigMove) {
      lines.push('### Site-level changes');
      lines.push('');
      lines.push(
        `Your overall numbers moved this week, but the available query rows do not establish which queries drove the change. ${describeSiteLevelMove(siteImpressionsChangePct, siteClicksChangePct, sitePositionDelta)}`,
      );
      lines.push('');
    } else if (observedQueryOverlap.common === 0) {
      lines.push('### Query trends not comparable');
      lines.push('Aggregate site totals are stable, but the bounded query results have no shared returned queries. Stability of individual query performance cannot be established from these samples.');
      lines.push('');
    } else {
      lines.push('### Steady week');
      lines.push('');
      lines.push('Nothing major changed this week. Numbers are stable.');
      lines.push('');
    }
  }

  lines.push('## Your top pages this week');
  lines.push('');
  const topPages = currentPages.slice(0, 5);
  if (topPages.length === 0) {
    lines.push('- No page-level rows were returned for this period. This does not prove that no pages received search impressions.');
  } else {
    const pagePathCounts = new Map<string, number>();
    for (const page of topPages) {
      const path = relativePagePath(page.page);
      pagePathCounts.set(path, (pagePathCounts.get(path) ?? 0) + 1);
    }
    for (const p of topPages) {
      const path = relativePagePath(p.page);
      // Keep concise paths unless dropping the host would merge distinct URLs.
      const displayPage = (pagePathCounts.get(path) ?? 0) > 1 ? p.page : path;
      lines.push(
        `- **${escapeMarkdownInline(displayPage)}** — ${formatNumber(p.clicks)} clicks, ${formatNumber(p.impressions)} times shown.`,
      );
    }
  }
  lines.push('');

  lines.push('## What to do this week');
  lines.push('');
  lines.push(`### 🎯 ${action.item.headline}`);
  lines.push('');
  lines.push(`**Why this matters:** ${action.item.why}`);
  lines.push('');
  lines.push(`**How to do it:** ${action.item.how}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    `*This report covers ${escapeMarkdownInline(siteUrl)} from ${dates.currentStart} to ${dates.currentEnd}. Data comes from Google Search Console.*`,
  );
  lines.push('');
  lines.push('<details>');
  lines.push('<summary>What do these numbers actually mean?</summary>');
  lines.push('');
  lines.push(
    '- **Impressions:** Your site appeared in Google Search results. This counts result appearances according to Search Console\'s reporting rules; it is not a unique-person count.',
  );
  lines.push('- **Clicks:** Your link was clicked from Google Search results.');
  lines.push(
    '- **Average position:** Search Console averages the topmost position of your result across recorded impressions. Lower values mean a higher average position, but this is not a literal current rank or results-page number.',
  );
  lines.push('');
  lines.push('</details>');

  return lines.join('\n');
}

function formatNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function formatPosition(n: number): string {
  if (n === 0) return '—';
  return n.toFixed(1);
}

function formatPctChange(current: number, prev: number): string {
  if (prev === 0 && current === 0) return 'same as last week';
  if (prev === 0 && current > 0) {
    return 'increased from a measured zero last week (percentage change unavailable)';
  }
  const pct = ((current - prev) / prev) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(0)}% vs last week`;
}

function percentageChangeOrNull(current: number, baseline: number): number | null {
  if (baseline === 0) return current === 0 ? 0 : null;
  return ((current - baseline) / baseline) * 100;
}

function formatPositionChange(current: number, prev: number): string {
  if (prev === 0 || current === 0) return 'no comparison available';
  const diff = current - prev;
  if (Math.abs(diff) < 0.05) return 'same as last week';
  if (diff < 0) {
    return `${Math.abs(diff).toFixed(1)} positions better vs last week`;
  }
  return `${diff.toFixed(1)} positions worse vs last week`;
}

function siteDisplayName(siteUrl: string): string {
  if (siteUrl.startsWith('sc-domain:')) {
    return siteUrl.slice('sc-domain:'.length);
  }
  try {
    const url = new URL(siteUrl);
    // URL-prefix properties can share a host but represent different site sections.
    return url.host + (url.pathname === '/' ? '' : url.pathname);
  } catch {
    return siteUrl;
  }
}

function relativePagePath(pageUrl: string): string {
  try {
    const u = new URL(pageUrl);
    return u.pathname + u.search;
  } catch {
    return pageUrl;
  }
}

function isOperatorQuery(q: string): boolean {
  const prefixOperators =
    /^(site|inurl|intitle|intext|filetype|cache|related|info|link|allintitle|allinurl|allintext|allinanchor):/i;
  if (prefixOperators.test(q)) return true;
  if (/ (site|inurl|intitle|intext|filetype):/i.test(q)) return true;
  return false;
}

function isWithinLast3Days(endDate: string): boolean {
  const todayISO = getSearchConsoleCalendarDate();
  const todayUTC = new Date(`${todayISO}T00:00:00Z`);
  const endUTC = new Date(`${endDate}T00:00:00Z`);
  const diffDays =
    (todayUTC.getTime() - endUTC.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays <= 3;
}

function describeSiteLevelMove(
  impressionsChangePct: number | null,
  clicksChangePct: number | null,
  positionDelta: number,
): string {
  const candidates: Array<{
    metric: 'impressions' | 'position' | 'clicks';
    ratio: number;
  }> = [];
  if (impressionsChangePct === null) {
    candidates.push({
      metric: 'impressions',
      ratio: Number.POSITIVE_INFINITY,
    });
  } else if (Math.abs(impressionsChangePct) >= 25) {
    candidates.push({
      metric: 'impressions',
      ratio: Math.abs(impressionsChangePct) / 25,
    });
  }
  if (Math.abs(positionDelta) >= 3) {
    candidates.push({ metric: 'position', ratio: Math.abs(positionDelta) / 3 });
  }
  if (
    clicksChangePct === null &&
    impressionsChangePct !== null
  ) {
    candidates.push({
      metric: 'clicks',
      ratio: Number.POSITIVE_INFINITY,
    });
  } else if (
    clicksChangePct !== null &&
    impressionsChangePct !== null &&
    Math.abs(clicksChangePct) >= 25 &&
    Math.abs(impressionsChangePct) < 25
  ) {
    candidates.push({ metric: 'clicks', ratio: Math.abs(clicksChangePct) / 25 });
  }

  candidates.sort((a, b) => b.ratio - a.ratio);
  const winner = candidates[0];
  if (!winner) {
    return 'Numbers moved across multiple dimensions but no single one stands out.';
  }

  if (winner.metric === 'impressions') {
    if (impressionsChangePct === null) {
      return 'Your site recorded search impressions this week after the previous period recorded none. A percentage change is unavailable from a zero baseline; inspect Queries and Pages to see where the new visibility appeared.';
    }
    if (impressionsChangePct >= 25) {
      return `Your site recorded many more search impressions this week (+${impressionsChangePct.toFixed(0)}%). The aggregate does not identify which queries drove this change; inspect Query and Page rows in Search Console.`;
    }
    return `Your site recorded fewer search impressions this week (${impressionsChangePct.toFixed(0)}%). The aggregate does not identify which queries drove this change; inspect Query and Page rows in Search Console.`;
  }

  if (winner.metric === 'position') {
    if (positionDelta >= 3) {
      return `Your average Search Console position worsened by ${positionDelta.toFixed(1)} this week. This aggregate can move because of changes in the mix of queries, pages, devices, countries, or result types, so inspect those dimensions before assigning a cause.`;
    }
    return `Your average Search Console position improved by ${Math.abs(positionDelta).toFixed(1)} this week. Treat this as a trend signal rather than proof of a specific cause, and inspect the query/page rows that contributed most to the change.`;
  }

  if (clicksChangePct === null) {
    const impressionsContext =
      impressionsChangePct === null
        ? 'impressions also started from a zero baseline'
        : `impressions moved ${impressionsChangePct >= 0 ? '+' : ''}${impressionsChangePct.toFixed(0)}%`;
    return `Your site recorded clicks this week after the previous period recorded none; a click percentage change is unavailable from a zero baseline (${impressionsContext}). Review query/page CTR and average position before assigning a cause.`;
  }
  if (impressionsChangePct === null) {
    return `Your clicks changed sharply this week (${clicksChangePct >= 0 ? '+' : ''}${clicksChangePct.toFixed(0)}%), while impressions started from a zero baseline so an impression percentage change is unavailable. Review query/page CTR and average position before assigning a cause.`;
  }
  const clicksSign = clicksChangePct >= 0 ? '+' : '';
  const impressionsSign =
    impressionsChangePct >= 0 ? '+' : '';
  return `Your clicks changed sharply this week (clicks ${clicksSign}${clicksChangePct.toFixed(0)}%, while impressions moved ${impressionsSign}${impressionsChangePct.toFixed(0)}%). Review CTR and average position by query and page before forming hypotheses about snippets, ranking, search intent, demand, or SERP features.`;
}
