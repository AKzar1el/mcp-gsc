import { querySearchAnalytics, type SearchAnalyticsRow } from './google';
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

type ActionKey =
  | 'indexing_blocked'
  | 'ctr_zero'
  | 'investigate_drop'
  | 'promote_rising'
  | 'celebrate_and_double_down'
  | 'publish_one_post';

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

export async function generateWeeklyDigest(
  accessTokens: GoogleAccessTokenProvider,
  googleId: string,
  siteUrl: string,
  endDate: string,
): Promise<string> {
  const dates = computeDateRanges(endDate);
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
      dataState: 'all',
    }),
    querySearchAnalytics(accessToken, siteUrl, {
      startDate: dates.prevStart,
      endDate: dates.prevEnd,
      dimensions: [],
      rowLimit: 1,
      dataState: 'all',
    }),
    querySearchAnalytics(accessToken, siteUrl, {
      startDate: dates.currentStart,
      endDate: dates.currentEnd,
      dimensions: ['query'],
      rowLimit: 25,
      dataState: 'all',
    }),
    querySearchAnalytics(accessToken, siteUrl, {
      startDate: dates.prevStart,
      endDate: dates.prevEnd,
      dimensions: ['query'],
      rowLimit: 25,
      dataState: 'all',
    }),
    querySearchAnalytics(accessToken, siteUrl, {
      startDate: dates.currentStart,
      endDate: dates.currentEnd,
      dimensions: ['page'],
      rowLimit: 10,
      dataState: 'all',
    }),
  ]);

  const currentTotals = totalsFromRow(currentTotalsResponse.rows[0]);
  const prevTotals = totalsFromRow(prevTotalsResponse.rows[0]);
  const currentQueries = rowsToQueries(currentQueriesResponse.rows);
  const prevQueries = rowsToQueries(prevQueriesResponse.rows);
  const currentPages = rowsToPages(currentPagesResponse.rows);

  const movers = computeMovers(currentQueries, prevQueries);
  const action = pickActionAndBuild(
    currentTotals,
    prevTotals,
    movers,
    currentQueries,
  );

  return renderMarkdown({
    siteUrl,
    dates,
    currentTotals,
    prevTotals,
    movers,
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
  return rows.map((r) => ({
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
  const currentByQuery = new Map(current.map((q) => [q.query, q]));
  const allQueries = new Set<string>([
    ...current.map((q) => q.query),
    ...prev.map((q) => q.query),
  ]);

  const rising: Mover[] = [];
  const falling: Mover[] = [];
  const newImpressions: Mover[] = [];

  for (const query of allQueries) {
    const c = currentByQuery.get(query);
    const p = prevByQuery.get(query);
    const cClicks = c?.clicks ?? 0;
    const pClicks = p?.clicks ?? 0;
    const cImpr = c?.impressions ?? 0;
    const pImpr = p?.impressions ?? 0;
    const cPos = c?.position ?? 0;
    const pPos = p?.position ?? 0;

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
        change: cImpr,
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
        how: `1. In Search Console's Performance report, keep this same date range and filter to '${topRealQuery.query}'.\n2. Review the matching page rows, CTR, and average position, then compare them with the previous period.\n3. Change the title or meta description only if that query/page evidence suggests the snippet mismatches intent. A manual Google search can differ by location, device, and personalization, so do not treat it as authoritative reproduction.`,
      },
    };
  }

  const bigDrop = movers.falling.find((m) => m.change > 10);
  if (bigDrop) {
    return {
      key: 'investigate_drop',
      item: {
        headline: 'Search traffic for one of your queries dropped this week',
        why: `Search Console recorded ${bigDrop.prevClicks} clicks for '${bigDrop.query}' last week and ${bigDrop.currentClicks} this week. That is a measured decline, but Search Console alone does not establish whether the cause was ranking movement, demand, SERP features, a site change, or competition.`,
        how: `1. In Search Console, filter to '${bigDrop.query}' for both weeks and compare Pages, impressions, CTR, average position, Devices, and Countries.\n2. Review site changes made before the decline and treat them as hypotheses, not proven causes.\n3. If the same page lost useful visibility across supporting metrics, investigate that page and its search intent before changing it.`,
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
        why: `'${risingWithWeakerAveragePosition.query}' is bringing more clicks than last week and has an average Search Console position of ${risingWithWeakerAveragePosition.currentPosition.toFixed(1)}. Average position is not a literal current rank or page number; it averages the topmost result position across recorded impressions.`,
        how: `1. In Search Console, filter to '${risingWithWeakerAveragePosition.query}' for the same date range.\n2. Review the Pages, Devices, and Countries dimensions to see where the extra clicks and impressions came from.\n3. If one page is clearly gaining useful visibility, improve that page based on the query intent and evidence you see rather than assuming an average position maps to a specific results page.`,
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

function renderMarkdown(data: {
  siteUrl: string;
  dates: DateRanges;
  currentTotals: SiteTotals;
  prevTotals: SiteTotals;
  movers: Movers;
  currentPages: PageRow[];
  action: { key: ActionKey; item: ActionItem };
}): string {
  const { siteUrl, dates, currentTotals, prevTotals, movers, currentPages, action } = data;
  const siteName = siteDisplayName(siteUrl);
  const lines: string[] = [];

  if (isWithinLast3Days(dates.currentEnd)) {
    lines.push(
      `> Note: this digest covers the last 7 days ending ${dates.currentEnd}. Google usually finalizes search data 2–3 days after it happens, so the most recent numbers may still shift slightly.`,
    );
    lines.push('');
  }

  lines.push(`# Your weekly site report — ${siteName}`);
  lines.push(`### Week of ${dates.currentStart} to ${dates.currentEnd}`);
  lines.push('');
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

  const hasAnyMovers =
    movers.rising.length > 0 ||
    movers.falling.length > 0 ||
    movers.newImpressions.length > 0;

  if (movers.rising.length > 0) {
    lines.push('### Searches gaining traction');
    lines.push('');
    for (const m of movers.rising) {
      lines.push(
        `- **"${m.query}"** — ${m.currentClicks} clicks this week (was ${m.prevClicks} last week). Average position ${m.currentPosition.toFixed(1)}.`,
      );
    }
    lines.push('');
  }

  if (movers.falling.length > 0) {
    lines.push('### Searches losing traction');
    lines.push('');
    for (const m of movers.falling) {
      lines.push(
        `- **"${m.query}"** — ${m.currentClicks} clicks this week (was ${m.prevClicks} last week). Average position ${m.currentPosition.toFixed(1)}.`,
      );
    }
    lines.push('');
  }

  if (movers.newImpressions.length > 0) {
    lines.push('### New searches showing your site');
    lines.push('');
    for (const m of movers.newImpressions) {
      lines.push(
        `- **"${m.query}"** — ${m.currentImpressions} impressions this week (was ${m.prevImpressions} last week).`,
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
        `Your overall numbers moved this week, but no single query stood out as the driver. ${describeSiteLevelMove(siteImpressionsChangePct, siteClicksChangePct, sitePositionDelta)}`,
      );
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
    lines.push('- No pages had impressions this week.');
  } else {
    for (const p of topPages) {
      lines.push(
        `- **${relativePagePath(p.page)}** — ${formatNumber(p.clicks)} clicks, ${formatNumber(p.impressions)} times shown.`,
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
    `*This report covers ${siteUrl} from ${dates.currentStart} to ${dates.currentEnd}. Data comes from Google Search Console.*`,
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
  if (prev === 0 && current > 0) return 'new — no data last week';
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
    return new URL(siteUrl).hostname;
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
      return `Your site recorded many more search impressions this week (+${impressionsChangePct.toFixed(0)}%), but the increase was spread across lots of small queries rather than one big winner.`;
    }
    return `Your site recorded fewer search impressions this week (${impressionsChangePct.toFixed(0)}%). The drop is spread across many queries rather than one specific search losing traction.`;
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
