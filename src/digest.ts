import {
  GoogleRefreshTokenRevokedError,
  querySearchAnalytics,
  refreshAccessToken,
  type SearchAnalyticsRow,
} from './google';
import { getDecryptedRefreshToken } from './storage';

interface DigestEnv {
  OAUTH_KV: KVNamespace;
  USER_KV: KVNamespace;
  TOKEN_ENCRYPTION_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

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

export async function generateWeeklyDigest(
  env: DigestEnv,
  googleId: string,
  siteUrl: string,
  endDate: string,
): Promise<string> {
  const dates = computeDateRanges(endDate);
  const accessToken = await getAccessTokenForDigest(env, googleId);

  const [
    currentTotalsRaw,
    prevTotalsRaw,
    currentQueriesRaw,
    prevQueriesRaw,
    currentPagesRaw,
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

  const currentTotals = totalsFromRow(currentTotalsRaw[0]);
  const prevTotals = totalsFromRow(prevTotalsRaw[0]);
  const currentQueries = rowsToQueries(currentQueriesRaw);
  const prevQueries = rowsToQueries(prevQueriesRaw);
  const currentPages = rowsToPages(currentPagesRaw);

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

async function getAccessTokenForDigest(
  env: DigestEnv,
  googleId: string,
): Promise<string> {
  const refreshToken = await getDecryptedRefreshToken(env, googleId);
  if (!refreshToken) {
    throw new GoogleRefreshTokenRevokedError();
  }
  const { access_token } = await refreshAccessToken(
    refreshToken,
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
  );
  return access_token;
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
    query: r.keys[0] ?? '',
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));
}

function rowsToPages(rows: SearchAnalyticsRow[]): PageRow[] {
  return rows.map((r) => ({
    page: r.keys[0] ?? '',
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
        headline: "Your site isn't showing up in Google yet",
        why: "Google has crawled your site but nothing is appearing in search results. This usually means either your homepage uses JavaScript to load content (Google can't read it), or your pages haven't been submitted for indexing.",
        how: "1. Open https://search.google.com/search-console and click 'URL inspection' at the top.\n2. Paste your homepage URL.\n3. Click 'Request indexing.' If it says 'URL is not on Google' and the page looks blank when you view the 'Tested page' tab, your site is JavaScript-rendered and you need to add server-side rendering. Ask your developer.",
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
          headline:
            'Your site is mostly being found by people who already know about it',
          why: "Almost all of your search impressions this week came from branded queries — people typing your domain or site name directly. That's good (people know you exist) but it means Google isn't yet showing your site to people searching for what you offer. To grow, you need to rank for queries about the topic of your site, not just the site itself.",
          how: "1. Pick the single most important thing your site is about (your product, your service, the topic you write about).\n2. Write a 500-word page that answers the most basic question someone would have about that topic.\n3. Publish it. Make sure it's linked from your homepage.",
        },
      };
    }

    return {
      key: 'ctr_zero',
      item: {
        headline: 'Your site appears in search but nobody clicks',
        why: `Google showed your site to ${formatNumber(currentTotals.impressions)} people this week, but zero clicked. The most common reason is that the title and description shown in search results don't match what people are searching for, or look unappealing compared to other results on the page.`,
        how: `1. Go to https://google.com and search for the query that got the most impressions this week: '${topRealQuery.query}'.\n2. Look at your result. Is the title clear? Does the description answer what someone searching for that would want to know?\n3. If not, edit the page's <title> tag and meta description to match the search intent. Re-check in a week.`,
      },
    };
  }

  const bigDrop = movers.falling.find((m) => m.change > 10);
  if (bigDrop) {
    return {
      key: 'investigate_drop',
      item: {
        headline: 'Search traffic for one of your queries dropped this week',
        why: `Last week, '${bigDrop.query}' brought you ${bigDrop.prevClicks} clicks. This week, only ${bigDrop.currentClicks}. A drop this size in one week usually means either: a competitor outranked you, the page itself changed, or Google changed how it shows your page.`,
        how: `1. Search Google for '${bigDrop.query}' and find your page.\n2. Compare your result to the top 3 results above and below you. What do they have that you don't?\n3. Either update your page to be more useful, or accept the drop if the query isn't strategic.`,
      },
    };
  }

  const risingOnPage2 = movers.rising.find((m) => m.currentPosition > 10);
  if (risingOnPage2) {
    return {
      key: 'promote_rising',
      item: {
        headline: "One of your pages is climbing — give it a push",
        why: `'${risingOnPage2.query}' is bringing more clicks each week, but you're still ranking on page 2 of search results (position ${Math.round(risingOnPage2.currentPosition)}). Pages on page 1 get ~10x more clicks than pages on page 2.`,
        how: `1. Find your page that ranks for this query.\n2. Add 2-3 paragraphs answering related questions someone searching for '${risingOnPage2.query}' would also want to know.\n3. Get 1 other page on your site to link to it with the text '${risingOnPage2.query}' as the link.`,
      },
    };
  }

  const positionImprovement = prevTotals.position - currentTotals.position;
  if (prevTotals.position > 0 && currentTotals.position > 0 && positionImprovement > 2) {
    return {
      key: 'celebrate_and_double_down',
      item: {
        headline: "Your rankings improved — here's how to compound it",
        why: `Your average position improved by ${positionImprovement.toFixed(1)} spots this week. Google noticed something positive (better content, faster page, more links). Whatever you did, do more of it.`,
        how: "1. Look at what you published or changed in the last 2-4 weeks. Was it new content, technical fixes, or external links?\n2. Repeat that exact pattern on your next 2-3 pages.\n3. Skip this week's celebration and ship the next thing.",
      },
    };
  }

  return {
    key: 'publish_one_post',
    item: {
      headline: 'Publish one new piece of content this week',
      why: 'Your numbers are steady — nothing broken, nothing breakthrough. The single biggest predictor of organic search growth is consistent publishing of content people are searching for.',
      how: "1. Open your GSC and look at the 'Queries' tab — find a query with at least 5 impressions but where you don't have a dedicated page.\n2. Write a 500-1000 word page directly answering that query.\n3. Publish it. Submit the URL via 'URL inspection' for faster indexing.",
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
    `- **People who saw your site in Google search this week:** ${formatNumber(currentTotals.impressions)} (${formatPctChange(currentTotals.impressions, prevTotals.impressions)})`,
  );
  lines.push(
    `- **People who clicked through to your site:** ${formatNumber(currentTotals.clicks)} (${formatPctChange(currentTotals.clicks, prevTotals.clicks)})`,
  );
  lines.push(
    `- **Average rank when your site appeared:** ${formatPosition(currentTotals.position)} (${formatPositionChange(currentTotals.position, prevTotals.position)})`,
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
        `- **"${m.query}"** — ${m.currentClicks} clicks this week (was ${m.prevClicks} last week). Currently ranking #${Math.round(m.currentPosition)}.`,
      );
    }
    lines.push('');
  }

  if (movers.falling.length > 0) {
    lines.push('### Searches losing traction');
    lines.push('');
    for (const m of movers.falling) {
      lines.push(
        `- **"${m.query}"** — ${m.currentClicks} clicks this week (was ${m.prevClicks} last week). Currently ranking #${Math.round(m.currentPosition)}.`,
      );
    }
    lines.push('');
  }

  if (movers.newImpressions.length > 0) {
    lines.push('### New searches showing your site');
    lines.push('');
    for (const m of movers.newImpressions) {
      lines.push(
        `- **"${m.query}"** — ${m.currentImpressions} people saw your site in results for this search for the first time.`,
      );
    }
    lines.push('');
  }

  if (!hasAnyMovers) {
    const siteImpressionsChangePct =
      prevTotals.impressions > 0
        ? ((currentTotals.impressions - prevTotals.impressions) /
            prevTotals.impressions) *
          100
        : 0;
    const siteClicksChangePct =
      prevTotals.clicks > 0
        ? ((currentTotals.clicks - prevTotals.clicks) / prevTotals.clicks) *
          100
        : 0;
    const sitePositionDelta = currentTotals.position - prevTotals.position;

    const siteHadBigMove =
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
    '- **Saw your site:** Google calls these "impressions." Your site appeared in someone\'s search results page.',
  );
  lines.push('- **Clicked through:** Your link was clicked from the search results.');
  lines.push(
    '- **Average rank:** Where your site appeared in search results on average. Lower is better. #1 is the top result.',
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
  const todayISO = new Date().toISOString().slice(0, 10);
  const todayUTC = new Date(`${todayISO}T00:00:00Z`);
  const endUTC = new Date(`${endDate}T00:00:00Z`);
  const diffDays =
    (todayUTC.getTime() - endUTC.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays <= 3;
}

function describeSiteLevelMove(
  impressionsChangePct: number,
  clicksChangePct: number,
  positionDelta: number,
): string {
  const candidates: Array<{
    metric: 'impressions' | 'position' | 'clicks';
    ratio: number;
  }> = [];
  if (Math.abs(impressionsChangePct) >= 25) {
    candidates.push({
      metric: 'impressions',
      ratio: Math.abs(impressionsChangePct) / 25,
    });
  }
  if (Math.abs(positionDelta) >= 3) {
    candidates.push({ metric: 'position', ratio: Math.abs(positionDelta) / 3 });
  }
  if (Math.abs(clicksChangePct) >= 25 && Math.abs(impressionsChangePct) < 25) {
    candidates.push({ metric: 'clicks', ratio: Math.abs(clicksChangePct) / 25 });
  }

  candidates.sort((a, b) => b.ratio - a.ratio);
  const winner = candidates[0];
  if (!winner) {
    return 'Numbers moved across multiple dimensions but no single one stands out.';
  }

  if (winner.metric === 'impressions') {
    if (impressionsChangePct >= 25) {
      return `Google showed your site to many more people this week (+${impressionsChangePct.toFixed(0)}%), but the increase was spread across lots of small queries rather than one big winner.`;
    }
    return `Google showed your site to fewer people this week (${impressionsChangePct.toFixed(0)}%). The drop is spread across many queries rather than one specific search losing traction.`;
  }

  if (winner.metric === 'position') {
    if (positionDelta >= 3) {
      return `Your average rank slipped by ${positionDelta.toFixed(1)} positions this week. Many queries moved slightly lower at the same time. Likely an algorithm update or a competitor improving.`;
    }
    return `Your average rank improved by ${Math.abs(positionDelta).toFixed(1)} positions this week — many queries moved up at the same time. Something you did is working.`;
  }

  const clicksSign = clicksChangePct >= 0 ? '+' : '';
  const impressionsSign = impressionsChangePct >= 0 ? '+' : '';
  return `Your click rate changed sharply this week (clicks ${clicksSign}${clicksChangePct.toFixed(0)}%, but impressions only moved ${impressionsSign}${impressionsChangePct.toFixed(0)}%). Worth looking at whether something changed about how your titles or descriptions appear in search results.`;
}
