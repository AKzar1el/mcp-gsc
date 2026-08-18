import {
  DEFAULT_GSC_ACCESS_MODE,
  getGoogleOAuthScopes,
  type GscAccessMode,
} from './access-mode';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

// Kept as the default-mode export for compatibility with existing callers.
export const SCOPES = getGoogleOAuthScopes(DEFAULT_GSC_ACCESS_MODE);

export function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  accessMode: GscAccessMode = DEFAULT_GSC_ACCESS_MODE,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: getGoogleOAuthScopes(accessMode).join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  id_token?: string;
  token_type: string;
  scope: string;
}

export const GSC_ACCESS_REVOKED_MESSAGE =
  'Google access revoked. Please reconnect this server in your MCP client (e.g. Claude.ai → Settings → Connectors).';

export class GoogleRefreshTokenRevokedError extends Error {
  constructor() {
    super(GSC_ACCESS_REVOKED_MESSAGE);
    this.name = 'GoogleRefreshTokenRevokedError';
  }
}

export async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as Partial<GoogleTokenResponse>;
  if (!data.refresh_token) {
    throw new Error('Google did not return a refresh_token');
  }
  return data as GoogleTokenResponse;
}

export interface GoogleUserInfo {
  id: string;
  email: string;
  verified_email?: boolean;
}

export async function fetchGoogleUserInfo(
  accessToken: string,
): Promise<GoogleUserInfo> {
  const resp = await fetch(GOOGLE_USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Userinfo fetch failed: ${resp.status} ${text}`);
  }
  return (await resp.json()) as GoogleUserInfo;
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<{ access_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) {
    let parsedError: string | undefined;
    try {
      const errBody = (await resp.json()) as { error?: string };
      parsedError = errBody.error;
    } catch {
      // body was not JSON
    }
    if (parsedError === 'invalid_grant') {
      throw new GoogleRefreshTokenRevokedError();
    }
    throw new Error(`Failed to refresh Google access token: ${resp.status}`);
  }
  const data = (await resp.json()) as {
    access_token: string;
    expires_in: number;
  };
  return { access_token: data.access_token, expires_in: data.expires_in };
}

export interface SiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

export async function listSites(accessToken: string): Promise<SiteEntry[]> {
  const resp = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (resp.status === 401) {
    throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`List sites failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as { siteEntry?: SiteEntry[] };
  return data.siteEntry ?? [];
}

export type SearchDimension =
  | 'query'
  | 'page'
  | 'country'
  | 'device'
  | 'date'
  | 'searchAppearance';

export type SearchType =
  | 'web'
  | 'image'
  | 'video'
  | 'news'
  | 'discover'
  | 'googleNews';

export type AggregationType = 'auto' | 'byPage' | 'byProperty';

export type DataState = 'all' | 'final';

export type FilterDimension =
  | 'query'
  | 'page'
  | 'country'
  | 'device'
  | 'searchAppearance';

export type FilterOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'includingRegex'
  | 'excludingRegex';

export interface DimensionFilter {
  dimension: FilterDimension;
  operator: FilterOperator;
  expression: string;
}

export interface DimensionFilterGroup {
  groupType: 'and';
  filters: DimensionFilter[];
}

export interface SearchAnalyticsQuery {
  startDate: string;
  endDate: string;
  dimensions: SearchDimension[];
  rowLimit: number;
  startRow?: number;
  dataState?: DataState;
  type?: SearchType;
  aggregationType?: AggregationType;
  dimensionFilterGroups?: DimensionFilterGroup[];
}

export type PaginatedSearchAnalyticsQuery = Omit<
  SearchAnalyticsQuery,
  'rowLimit'
>;

export interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalyticsResponseMetadata {
  first_incomplete_date?: string;
  first_incomplete_hour?: string;
}

export interface SearchAnalyticsResponse {
  rows: SearchAnalyticsRow[];
  responseAggregationType?: string;
  metadata?: SearchAnalyticsResponseMetadata;
}

/** The maximum page size accepted by the Search Analytics API. */
export const SEARCH_ANALYTICS_PAGE_SIZE = 25_000;

/**
 * Limits each higher-level analysis source query to four API pages. This
 * bounds Worker runtime, memory, and Search Analytics quota use; it does not
 * make Search Console's internally limited results exhaustive.
 */
export const MAX_PAGINATED_SEARCH_ANALYTICS_ROWS = 100_000;

export interface PaginatedSearchAnalyticsResult {
  rows: SearchAnalyticsRow[];
  pagesFetched: number;
  localLimitReached: boolean;
}

interface SearchAnalyticsPaginationOptions {
  /** May lower the hard ceiling for a caller, but never raise it. */
  maxRows?: number;
}

export async function inspectUrl(
  accessToken: string,
  siteUrl: string,
  inspectionUrl: string,
  languageCode?: string,
): Promise<unknown> {
  const body: Record<string, string> = {
    inspectionUrl,
    siteUrl,
  };
  if (languageCode) body.languageCode = languageCode;
  const resp = await fetch(
    'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  if (resp.status === 401) {
    throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`URL inspection failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as { inspectionResult?: unknown };
  return data.inspectionResult ?? null;
}

export interface SitemapEntry {
  path: string;
  lastSubmitted?: string | null;
  isPending?: boolean | null;
  isSitemapsIndex?: boolean | null;
  type?: string | null;
  lastDownloaded?: string | null;
  warnings?: string | null;
  errors?: string | null;
  contents?: Array<{
    type: string;
    submitted: string;
  }> | null;
}

function normalizeSitemap(entry: SitemapEntry): SitemapEntry {
  if (!entry.contents) return entry;

  // Google marks contents[].indexed as deprecated. Do not expose that stale
  // field to MCP clients as an indexed-page count.
  return {
    ...entry,
    contents: entry.contents.map(({ type, submitted }) => ({ type, submitted })),
  };
}

export async function listSitemaps(
  accessToken: string,
  siteUrl: string,
): Promise<SitemapEntry[]> {
  const encoded = encodeURIComponent(siteUrl);
  const resp = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encoded}/sitemaps`,
    {
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  if (resp.status === 401) {
    throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`List sitemaps failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as { sitemap?: SitemapEntry[] };
  return (data.sitemap ?? []).map(normalizeSitemap);
}

export async function querySearchAnalytics(
  accessToken: string,
  siteUrl: string,
  body: SearchAnalyticsQuery,
): Promise<SearchAnalyticsResponse> {
  const encoded = encodeURIComponent(siteUrl);
  const resp = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  if (resp.status === 401) {
    throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Search analytics query failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as {
    rows?: SearchAnalyticsRow[];
    responseAggregationType?: string;
    metadata?: SearchAnalyticsResponseMetadata;
  };
  return {
    rows: data.rows ?? [],
    ...(data.responseAggregationType !== undefined
      ? { responseAggregationType: data.responseAggregationType }
      : {}),
    ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
  };
}

/**
 * Fetches Search Analytics rows in 25,000-row pages for higher-level tools.
 * A full final page conservatively reports localLimitReached because the API
 * can have more rows even when Search Console's own internal limits apply.
 */
export async function querySearchAnalyticsPaginated(
  accessToken: string,
  siteUrl: string,
  body: PaginatedSearchAnalyticsQuery,
  options: SearchAnalyticsPaginationOptions = {},
): Promise<PaginatedSearchAnalyticsResult> {
  const requestedMaximum = options.maxRows ?? MAX_PAGINATED_SEARCH_ANALYTICS_ROWS;
  const maximumRows = Math.min(requestedMaximum, MAX_PAGINATED_SEARCH_ANALYTICS_ROWS);
  if (!Number.isInteger(maximumRows) || maximumRows < 1) {
    throw new Error('maxRows must be a positive integer.');
  }

  const rows: SearchAnalyticsRow[] = [];
  let startRow = body.startRow ?? 0;
  let pagesFetched = 0;

  while (rows.length < maximumRows) {
    const requestedRows = Math.min(
      SEARCH_ANALYTICS_PAGE_SIZE,
      maximumRows - rows.length,
    );
    const page = await querySearchAnalytics(accessToken, siteUrl, {
      ...body,
      rowLimit: requestedRows,
      startRow,
    });
    pagesFetched += 1;

    const acceptedRows = page.rows.slice(0, requestedRows);
    rows.push(...acceptedRows);
    if (page.rows.length < requestedRows) {
      return { rows, pagesFetched, localLimitReached: false };
    }
    if (rows.length >= maximumRows || page.rows.length > requestedRows) {
      return { rows, pagesFetched, localLimitReached: true };
    }

    startRow += page.rows.length;
  }

  return { rows, pagesFetched, localLimitReached: true };
}

export async function addSite(
  accessToken: string,
  siteUrl: string,
): Promise<void> {
  const encoded = encodeURIComponent(siteUrl);
  const resp = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encoded}`,
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  if (resp.status === 401) {
    throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Add site failed: ${resp.status} ${text}`);
  }
}

export async function deleteSite(
  accessToken: string,
  siteUrl: string,
): Promise<void> {
  const encoded = encodeURIComponent(siteUrl);
  const resp = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encoded}`,
    {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  if (resp.status === 401) {
    throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Delete site failed: ${resp.status} ${text}`);
  }
}

export async function submitSitemap(
  accessToken: string,
  siteUrl: string,
  feedpath: string,
): Promise<void> {
  const encodedSite = encodeURIComponent(siteUrl);
  const encodedFeed = encodeURIComponent(feedpath);
  const resp = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodedSite}/sitemaps/${encodedFeed}`,
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  if (resp.status === 401) {
    throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Submit sitemap failed: ${resp.status} ${text}`);
  }
}

export async function deleteSitemap(
  accessToken: string,
  siteUrl: string,
  feedpath: string,
): Promise<void> {
  const encodedSite = encodeURIComponent(siteUrl);
  const encodedFeed = encodeURIComponent(feedpath);
  const resp = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodedSite}/sitemaps/${encodedFeed}`,
    {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  if (resp.status === 401) {
    throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Delete sitemap failed: ${resp.status} ${text}`);
  }
}

export async function getSitemap(
  accessToken: string,
  siteUrl: string,
  feedpath: string,
): Promise<SitemapEntry> {
  const encodedSite = encodeURIComponent(siteUrl);
  const encodedFeed = encodeURIComponent(feedpath);
  const resp = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodedSite}/sitemaps/${encodedFeed}`,
    {
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  if (resp.status === 401) {
    throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Get sitemap failed: ${resp.status} ${text}`);
  }
  return normalizeSitemap((await resp.json()) as SitemapEntry);
}

export interface QuickWinResult {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export function processQuickWins(
  rows: SearchAnalyticsRow[],
  minImpressions: number,
  minPosition: number,
  maxPosition: number,
): QuickWinResult[] {
  return rows
    .filter(
      (row) =>
        row.keys.length >= 2 &&
        row.position >= minPosition &&
        row.position <= maxPosition &&
        row.impressions >= minImpressions
    )
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 100)
    .map((row) => ({
      query: row.keys[0],
      page: row.keys[1],
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    }));
}

export interface CannibalizationPage {
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  impression_share: number;
}

export interface CannibalizationResult {
  query: string;
  total_clicks: number;
  total_impressions: number;
  pages: CannibalizationPage[];
}

export function processCannibalization(
  rows: SearchAnalyticsRow[],
  minImpressions: number,
  minPagePercentage: number,
): CannibalizationResult[] {
  const queryGroups = new Map<string, Array<{ page: string; clicks: number; impressions: number; ctr: number; position: number }>>();
  for (const row of rows) {
    if (row.keys.length < 2) continue;
    const query = row.keys[0];
    const page = row.keys[1];
    if (!queryGroups.has(query)) {
      queryGroups.set(query, []);
    }
    queryGroups.get(query)!.push({
      page,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    });
  }

  const cannibalizationCandidates: CannibalizationResult[] = [];

  for (const [query, pages] of queryGroups.entries()) {
    const totalImpressions = pages.reduce((sum, p) => sum + p.impressions, 0);
    const totalClicks = pages.reduce((sum, p) => sum + p.clicks, 0);

    const competingPages = pages
      .map((p) => ({
        ...p,
        impression_share: Math.round((p.impressions / totalImpressions) * 1000) / 10,
      }))
      .filter((p) => p.impressions >= minImpressions && p.impression_share >= minPagePercentage);

    if (competingPages.length >= 2) {
      cannibalizationCandidates.push({
        query,
        total_clicks: totalClicks,
        total_impressions: totalImpressions,
        pages: competingPages.sort((a, b) => b.impressions - a.impressions),
      });
    }
  }

  return cannibalizationCandidates
    .sort((a, b) => b.total_impressions - a.total_impressions)
    .slice(0, 100);
}

export interface DecayPageResult {
  page: string;
  previous_clicks: number;
  recent_clicks: number;
  click_difference: number;
  click_decay_percentage: number;
  previous_impressions: number;
  recent_impressions: number;
  impression_difference: number;
  previous_position: number;
  recent_position: number;
}

export function processContentDecay(
  recentRows: SearchAnalyticsRow[],
  previousRows: SearchAnalyticsRow[],
): DecayPageResult[] {
  const recentMap = new Map<string, { clicks: number; impressions: number; ctr: number; position: number }>();
  for (const row of recentRows) {
    if (row.keys.length < 1) continue;
    recentMap.set(row.keys[0], {
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    });
  }

  const decayCandidates: DecayPageResult[] = [];

  for (const row of previousRows) {
    if (row.keys.length < 1) continue;
    const page = row.keys[0];
    const prevClicks = row.clicks;
    const prevImps = row.impressions;
    const prevPos = row.position;

    const recent = recentMap.get(page);
    const recClicks = recent ? recent.clicks : 0;
    const recImps = recent ? recent.impressions : 0;
    const recPos = recent ? recent.position : 0;

    const clickDiff = recClicks - prevClicks;
    const impDiff = recImps - prevImps;

    if (clickDiff < 0) {
      decayCandidates.push({
        page,
        previous_clicks: prevClicks,
        recent_clicks: recClicks,
        click_difference: clickDiff,
        click_decay_percentage: prevClicks > 0 ? Math.round((Math.abs(clickDiff) / prevClicks) * 1000) / 10 : 0,
        previous_impressions: prevImps,
        recent_impressions: recImps,
        impression_difference: impDiff,
        previous_position: prevPos,
        recent_position: recPos,
      });
    }
  }

  return decayCandidates
    .sort((a, b) => a.click_difference - b.click_difference)
    .slice(0, 100);
}

// Google's Indexing API is not a general-purpose submission API. It is
// currently documented as supporting only job posting pages and livestream
// pages: https://developers.google.com/search/apis/indexing-api/v3/quickstart
const INDEXING_SCOPE_MESSAGE =
  "Google's Indexing API only accepts job posting pages (JobPosting structured data) " +
  'and livestream pages (BroadcastEvent structured data inside VideoObject). ' +
  'It is not available for general webpage submission.';

function collectSchemaTypes(node: unknown, types: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectSchemaTypes(item, types);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const type = obj['@type'];
  if (typeof type === 'string') types.add(type);
  else if (Array.isArray(type)) {
    for (const t of type) if (typeof t === 'string') types.add(t);
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === '@type') continue;
    collectSchemaTypes(value, types);
  }
}

/** True if `node` is (or contains, anywhere below it) a node typed BroadcastEvent. */
function containsBroadcastEvent(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(containsBroadcastEvent);
  if (!node || typeof node !== 'object') return false;
  const obj = node as Record<string, unknown>;
  const types = new Set<string>();
  const type = obj['@type'];
  if (typeof type === 'string') types.add(type);
  else if (Array.isArray(type)) {
    for (const t of type) if (typeof t === 'string') types.add(t);
  }
  if (types.has('BroadcastEvent')) return true;
  return Object.values(obj).some(containsBroadcastEvent);
}

/** True if `node` is (or contains, anywhere below it) a VideoObject with a nested BroadcastEvent. */
function hasEligibleVideoBroadcast(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasEligibleVideoBroadcast);
  if (!node || typeof node !== 'object') return false;
  const obj = node as Record<string, unknown>;
  const types = new Set<string>();
  const type = obj['@type'];
  if (typeof type === 'string') types.add(type);
  else if (Array.isArray(type)) {
    for (const t of type) if (typeof t === 'string') types.add(t);
  }
  if (types.has('VideoObject') && containsBroadcastEvent(obj)) return true;
  return Object.values(obj).some(hasEligibleVideoBroadcast);
}

export interface IndexingEligibility {
  eligible: boolean;
  reason?: string;
}

/**
 * JSON-LD can appear well after the document head, so eligibility checks scan
 * up to 1 MiB of HTML rather than assuming the first few kilobytes are enough.
 */
export const INDEXING_ELIGIBILITY_MAX_RESPONSE_BYTES = 1024 * 1024;
export const INDEXING_ELIGIBILITY_TIMEOUT_MS = 10_000;

interface IndexingEligibilityOptions {
  timeoutMs?: number;
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort after a rejected response.
  }
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > INDEXING_ELIGIBILITY_MAX_RESPONSE_BYTES) {
        throw new Error(
          `Response body exceeds the ${INDEXING_ELIGIBILITY_MAX_RESPONSE_BYTES}-byte eligibility limit.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // The stream may already have been cancelled or aborted.
      }
    }
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Checks whether `url` carries the structured data Google's Indexing API
 * currently supports (JobPosting, or BroadcastEvent nested in VideoObject),
 * by inspecting its JSON-LD. Best-effort: if the page can't be fetched or
 * parsed, eligibility can't be confirmed and the URL is treated as
 * ineligible rather than silently submitted.
 */
export async function checkIndexingEligibility(
  url: string,
  { timeoutMs = INDEXING_ELIGIBILITY_TIMEOUT_MS }: IndexingEligibilityOptions = {},
): Promise<IndexingEligibility> {
  if (!isHttpUrl(url)) {
    return {
      eligible: false,
      reason: `${url} must be a valid HTTP or HTTPS URL. ${INDEXING_SCOPE_MESSAGE}`,
    };
  }

  let html: string;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      // Reject redirects rather than following a caller-controlled chain.
      redirect: 'manual',
      headers: {
        'user-agent':
          'Mozilla/5.0 (compatible; DigestSEO-GSC-MCP/1.0; +https://github.com/AKzar1el/mcp-gsc)',
      },
    });
    if (!resp.ok) {
      await cancelResponseBody(resp);
      return {
        eligible: false,
        reason: `Could not fetch ${url} to check indexing eligibility (HTTP ${resp.status}). ${INDEXING_SCOPE_MESSAGE}`,
      };
    }

    const contentType = resp.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (
      contentType &&
      contentType !== 'text/html' &&
      contentType !== 'application/xhtml+xml'
    ) {
      await cancelResponseBody(resp);
      return {
        eligible: false,
        reason: `Could not fetch ${url} to check indexing eligibility (expected HTML, received ${contentType}). ${INDEXING_SCOPE_MESSAGE}`,
      };
    }

    const contentLength = Number(resp.headers.get('content-length'));
    if (
      Number.isFinite(contentLength) &&
      contentLength > INDEXING_ELIGIBILITY_MAX_RESPONSE_BYTES
    ) {
      await cancelResponseBody(resp);
      return {
        eligible: false,
        reason: `Could not fetch ${url} to check indexing eligibility (response exceeds the ${INDEXING_ELIGIBILITY_MAX_RESPONSE_BYTES}-byte limit). ${INDEXING_SCOPE_MESSAGE}`,
      };
    }

    html = await readBoundedResponseText(resp);
  } catch (err) {
    const detail = timedOut
      ? `timed out after ${timeoutMs}ms`
      : (err as Error).message;
    return {
      eligible: false,
      reason: `Could not fetch ${url} to check indexing eligibility (${detail}). ${INDEXING_SCOPE_MESSAGE}`,
    };
  } finally {
    clearTimeout(timeout);
  }

  const types = new Set<string>();
  let hasVideoBroadcast = false;
  const scriptPattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      collectSchemaTypes(parsed, types);
      if (hasEligibleVideoBroadcast(parsed)) hasVideoBroadcast = true;
    } catch {
      // Ignore malformed JSON-LD blocks and keep scanning the rest of the page.
    }
  }

  if (types.has('JobPosting') || hasVideoBroadcast) {
    return { eligible: true };
  }

  return {
    eligible: false,
    reason: `${url} does not appear to contain JobPosting structured data or a BroadcastEvent inside VideoObject. ${INDEXING_SCOPE_MESSAGE}`,
  };
}

export async function requestIndexing(
  accessToken: string,
  url: string,
): Promise<unknown> {
  const eligibility = await checkIndexingEligibility(url);
  if (!eligibility.eligible) {
    throw new Error(eligibility.reason);
  }

  const resp = await fetch(
    'https://indexing.googleapis.com/v3/urlNotifications:publish',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url,
        type: 'URL_UPDATED',
      }),
    },
  );
  if (resp.status === 401) {
    throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Request indexing failed: ${resp.status} ${text}`);
  }
  return await resp.json();
}

export interface PerformanceComparisonRow {
  key: string;
  period_a: { clicks: number; impressions: number; ctr: number; position: number };
  period_b: { clicks: number; impressions: number; ctr: number; position: number };
  diff: {
    clicks: number;
    clicks_percentage: number | null;
    impressions: number;
    impressions_percentage: number | null;
    ctr: number;
    position: number;
  };
}

function calculatePercentageChange(current: number, baseline: number): number | null {
  if (baseline === 0) {
    return current === 0 ? 0 : null;
  }

  return Math.round(((current - baseline) / baseline) * 1000) / 10;
}

export function processPerformanceComparison(
  rowsA: SearchAnalyticsRow[],
  rowsB: SearchAnalyticsRow[],
): PerformanceComparisonRow[] {
  const mapB = new Map<string, { clicks: number; impressions: number; ctr: number; position: number }>();
  for (const row of rowsB) {
    if (row.keys.length < 1) continue;
    mapB.set(row.keys[0], {
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    });
  }

  const comparison: PerformanceComparisonRow[] = [];

  for (const row of rowsA) {
    if (row.keys.length < 1) continue;
    const key = row.keys[0];
    const clicksA = row.clicks;
    const impsA = row.impressions;
    const ctrA = row.ctr;
    const posA = row.position;

    const b = mapB.get(key) || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
    const clicksB = b.clicks;
    const impsB = b.impressions;
    const ctrB = b.ctr;
    const posB = b.position;

    const clicksDiff = clicksA - clicksB;
    const impsDiff = impsA - impsB;

    comparison.push({
      key,
      period_a: { clicks: clicksA, impressions: impsA, ctr: ctrA, position: posA },
      period_b: { clicks: clicksB, impressions: impsB, ctr: ctrB, position: posB },
      diff: {
        clicks: clicksDiff,
        clicks_percentage: calculatePercentageChange(clicksA, clicksB),
        impressions: impsDiff,
        impressions_percentage: calculatePercentageChange(impsA, impsB),
        ctr: Math.round((ctrA - ctrB) * 1000) / 1000,
        position: Math.round((posA - posB) * 10) / 10,
      },
    });
  }

  const mapAKeys = new Set(rowsA.map((r) => r.keys[0]));
  for (const row of rowsB) {
    if (row.keys.length < 1) continue;
    const key = row.keys[0];
    if (mapAKeys.has(key)) continue;

    const clicksB = row.clicks;
    const impsB = row.impressions;
    const ctrB = row.ctr;
    const posB = row.position;

    comparison.push({
      key,
      period_a: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
      period_b: { clicks: clicksB, impressions: impsB, ctr: ctrB, position: posB },
      diff: {
        clicks: -clicksB,
        clicks_percentage: calculatePercentageChange(0, clicksB),
        impressions: -impsB,
        impressions_percentage: calculatePercentageChange(0, impsB),
        ctr: -ctrB,
        position: -posB,
      },
    });
  }

  return comparison.sort((a, b) => b.period_a.clicks - a.period_a.clicks);
}



