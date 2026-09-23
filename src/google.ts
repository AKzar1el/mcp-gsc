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

export const MCP_RECONNECT_INSTRUCTION =
  "Please reconnect this server from your MCP client's connector or app settings.";

export const GSC_ACCESS_REVOKED_MESSAGE =
  `Google access revoked. ${MCP_RECONNECT_INSTRUCTION}`;

export class GoogleRefreshTokenRevokedError extends Error {
  constructor() {
    super(GSC_ACCESS_REVOKED_MESSAGE);
    this.name = 'GoogleRefreshTokenRevokedError';
  }
}

const GOOGLE_READ_RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const GOOGLE_READ_RETRYABLE_403_REASONS = new Set([
  'concurrentLimitExceeded',
  'rateLimitExceeded',
  'servingLimitExceeded',
  'userRateLimitExceeded',
]);
const GOOGLE_READ_MAX_ATTEMPTS = 3;
const GOOGLE_READ_BASE_DELAY_MS = 1_000;
const GOOGLE_READ_MAX_DELAY_MS = 5_000;

function googleErrorReasonsFromText(text: string): string[] {
  try {
    const data = JSON.parse(text) as {
      error?: { errors?: Array<{ reason?: unknown }> };
    };
    return (data.error?.errors ?? [])
      .map((entry) => entry.reason)
      .filter((reason): reason is string => typeof reason === 'string');
  } catch {
    return [];
  }
}

async function isGoogleReadRetryableResponse(response: Response): Promise<boolean> {
  if (GOOGLE_READ_RETRYABLE_STATUSES.has(response.status)) return true;
  if (response.status !== 403) return false;

  try {
    const data = (await response.clone().json()) as {
      error?: { errors?: Array<{ reason?: unknown }> };
    };
    return data.error?.errors?.some(
      (entry) =>
        typeof entry.reason === 'string' &&
        GOOGLE_READ_RETRYABLE_403_REASONS.has(entry.reason),
    ) ?? false;
  } catch {
    return false;
  }
}

function googleReadRetryDelayMs(response: Response, retryNumber: number): number | null {
  const retryAfter = response.headers.get('retry-after')?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const requestedDelay = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1_000)
      : Math.max(0, Date.parse(retryAfter) - Date.now());
    if (Number.isFinite(requestedDelay)) {
      return requestedDelay <= GOOGLE_READ_MAX_DELAY_MS ? requestedDelay : null;
    }
  }

  const exponentialDelay = GOOGLE_READ_BASE_DELAY_MS * 2 ** (retryNumber - 1);
  const jitterMs = Math.floor(Math.random() * 250);
  return Math.min(exponentialDelay + jitterMs, GOOGLE_READ_MAX_DELAY_MS);
}

async function fetchGoogleRead(url: string, init?: RequestInit): Promise<Response> {
  let lastNetworkError: unknown;

  for (let attempt = 1; attempt <= GOOGLE_READ_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, init);
      const retryable = await isGoogleReadRetryableResponse(response);
      if (!retryable || attempt === GOOGLE_READ_MAX_ATTEMPTS) {
        return response;
      }

      const delayMs = googleReadRetryDelayMs(response, attempt);
      if (delayMs === null) return response;
      try {
        await response.body?.cancel();
      } catch {
        // Best-effort cleanup before retrying a transient provider response.
      }
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    } catch (error) {
      lastNetworkError = error;
      if (attempt === GOOGLE_READ_MAX_ATTEMPTS) throw error;
      const delayMs = Math.min(
        GOOGLE_READ_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250),
        GOOGLE_READ_MAX_DELAY_MS,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastNetworkError;
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
  const resp = await fetchGoogleRead(GOOGLE_USERINFO_URL, {
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
  const resp = await fetchGoogleRead('https://www.googleapis.com/webmasters/v3/sites', {
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

export async function getSite(
  accessToken: string,
  siteUrl: string,
): Promise<SiteEntry> {
  const encoded = encodeURIComponent(siteUrl);
  const resp = await fetchGoogleRead(
    `https://www.googleapis.com/webmasters/v3/sites/${encoded}`,
    {
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  if (resp.status === 401) {
    throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Get site failed: ${resp.status} ${text}`);
  }
  return (await resp.json()) as SiteEntry;
}

export type SearchDimension =
  | 'query'
  | 'page'
  | 'country'
  | 'device'
  | 'date'
  | 'hour'
  | 'searchAppearance';

export type SearchType =
  | 'web'
  | 'image'
  | 'video'
  | 'news'
  | 'discover'
  | 'googleNews';

export type AggregationType =
  | 'auto'
  | 'byNewsShowcasePanel'
  | 'byPage'
  | 'byProperty';

export type DataState = 'all' | 'final' | 'hourly_all';

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

function inclusiveCalendarDayCount(startDate: string, endDate: string): number {
  const [startYear, startMonth, startDay] = startDate.split('-').map(Number);
  const [endYear, endMonth, endDay] = endDate.split('-').map(Number);
  const startUtc = Date.UTC(startYear, startMonth - 1, startDay);
  const endUtc = Date.UTC(endYear, endMonth - 1, endDay);
  return Math.floor((endUtc - startUtc) / 86_400_000) + 1;
}

export function assertSearchAnalyticsQueryCompatible(body: SearchAnalyticsQuery): void {
  if (new Set(body.dimensions).size !== body.dimensions.length) {
    throw new Error('Search Analytics dimensions must not contain duplicates.');
  }

  if (body.dimensions.includes('searchAppearance') && body.dimensions.length > 1) {
    throw new Error(
      'Search Analytics searchAppearance must be the only grouping dimension. Discover an appearance value with dimensions ["searchAppearance"], then filter by that value in a separate query when grouping by page, query, country, device, date, or hour.',
    );
  }

  const hasHourDimension = body.dimensions.includes('hour');
  const usesHourlyData = body.dataState === 'hourly_all';
  if (hasHourDimension && !usesHourlyData) {
    throw new Error('Search Analytics hour dimension requires dataState hourly_all.');
  }
  if (hasHourDimension && inclusiveCalendarDayCount(body.startDate, body.endDate) > 10) {
    throw new Error('Search Analytics hourly queries support at most 10 inclusive calendar days.');
  }

  const filters = body.dimensionFilterGroups?.flatMap((group) => group.filters) ?? [];
  const hasPageGroupingOrFilter =
    body.dimensions.includes('page') || filters.some((filter) => filter.dimension === 'page');
  const hasQueryGroupingOrFilter =
    body.dimensions.includes('query') || filters.some((filter) => filter.dimension === 'query');

  for (const filter of filters) {
    if (filter.expression.length > 4096) {
      throw new Error('Search Analytics filter expressions must be at most 4096 characters.');
    }
  }

  if (body.aggregationType === 'byPage' && hasPageGroupingOrFilter) {
    throw new Error(
      'Search Analytics aggregationType byPage cannot be combined with page grouping or filtering; use auto instead.',
    );
  }

  if (body.aggregationType === 'byProperty') {
    if (hasPageGroupingOrFilter) {
      throw new Error(
        'Search Analytics aggregationType byProperty cannot be combined with page grouping or filtering.',
      );
    }
    if (body.type === 'discover' || body.type === 'googleNews') {
      throw new Error(
        'Search Analytics aggregationType byProperty is not supported for discover or googleNews.',
      );
    }
  }

  if ((body.type === 'discover' || body.type === 'googleNews') && hasQueryGroupingOrFilter) {
    const surfaceName = body.type === 'discover' ? 'Google Discover' : 'Google News';
    throw new Error(
      `${surfaceName} does not support the query dimension or query filters in Search Analytics.`,
    );
  }

  if (body.aggregationType === 'byNewsShowcasePanel') {
    if (body.type !== 'discover' && body.type !== 'googleNews') {
      throw new Error(
        'Search Analytics aggregationType byNewsShowcasePanel requires type discover or googleNews.',
      );
    }
    if (hasPageGroupingOrFilter) {
      throw new Error(
        'Search Analytics aggregationType byNewsShowcasePanel cannot be combined with page grouping or filtering.',
      );
    }

    const searchAppearanceFilters = filters.filter(
      (filter) => filter.dimension === 'searchAppearance',
    );
    const hasRequiredNewsShowcaseFilter = searchAppearanceFilters.some(
      (filter) => filter.operator === 'equals' && filter.expression === 'NEWS_SHOWCASE',
    );
    const hasOtherSearchAppearanceFilter = searchAppearanceFilters.some(
      (filter) => filter.operator !== 'equals' || filter.expression !== 'NEWS_SHOWCASE',
    );
    if (!hasRequiredNewsShowcaseFilter || hasOtherSearchAppearanceFilter) {
      throw new Error(
        'Search Analytics aggregationType byNewsShowcasePanel requires exactly the NEWS_SHOWCASE searchAppearance filter and no other searchAppearance filter.',
      );
    }
  }
}

export type PaginatedSearchAnalyticsQuery = Omit<
  SearchAnalyticsQuery,
  'rowLimit'
>;

export interface SearchAnalyticsRow {
  /**
   * Dimension values returned by Google. Aggregate queries with
   * dimensions: [] legitimately omit this field.
   */
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  /**
   * Average position when Google records it. Search Console does not record
   * position for Discover or the Google News app/news.google.com, so those
   * Search Analytics rows can legitimately omit this field.
   */
  position?: number;
}

export type PositionedSearchAnalyticsRow = SearchAnalyticsRow & { position: number };

export function hasRecordedPosition(
  row: SearchAnalyticsRow,
): row is PositionedSearchAnalyticsRow {
  return row.position !== undefined;
}

export interface SearchAnalyticsResponseMetadata {
  first_incomplete_date?: string;
  first_incomplete_hour?: string;
}

interface GoogleSearchAnalyticsResponseMetadata {
  firstIncompleteDate?: string;
  firstIncompleteHour?: string;
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
  const resp = await fetchGoogleRead(
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

export interface UrlInspectionBatchResult {
  inspectionUrl: string;
  inspectionResult?: unknown;
  error?: string;
}

export const URL_INSPECTION_BATCH_CONCURRENCY = 3;

export async function inspectUrlsBoundedConcurrently(
  accessToken: string,
  siteUrl: string,
  inspectionUrls: readonly string[],
  languageCode?: string,
): Promise<UrlInspectionBatchResult[]> {
  const results: UrlInspectionBatchResult[] = [];

  for (
    let offset = 0;
    offset < inspectionUrls.length;
    offset += URL_INSPECTION_BATCH_CONCURRENCY
  ) {
    const chunk = inspectionUrls.slice(offset, offset + URL_INSPECTION_BATCH_CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (inspectionUrl): Promise<UrlInspectionBatchResult | Error> => {
        try {
          return {
            inspectionUrl,
            inspectionResult: await inspectUrl(
              accessToken,
              siteUrl,
              inspectionUrl,
              languageCode,
            ),
          };
        } catch (error) {
          if (error instanceof Error && error.message === GSC_ACCESS_REVOKED_MESSAGE) {
            return error;
          }
          return {
            inspectionUrl,
            error: error instanceof Error ? error.message : 'URL inspection failed.',
          };
        }
      }),
    );

    const accessRevoked = chunkResults.find((result): result is Error => result instanceof Error);
    if (accessRevoked) {
      throw accessRevoked;
    }
    results.push(
      ...chunkResults.filter(
        (result): result is UrlInspectionBatchResult => !(result instanceof Error),
      ),
    );
  }

  return results;
}

// Kept for compatibility with callers that imported the original helper directly.
export const inspectUrlsSequentially = inspectUrlsBoundedConcurrently;

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
  sitemapIndex?: string,
): Promise<SitemapEntry[]> {
  const encoded = encodeURIComponent(siteUrl);
  const query = sitemapIndex
    ? `?sitemapIndex=${encodeURIComponent(sitemapIndex)}`
    : '';
  const resp = await fetchGoogleRead(
    `https://www.googleapis.com/webmasters/v3/sites/${encoded}/sitemaps${query}`,
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
  assertSearchAnalyticsQueryCompatible(body);
  const encoded = encodeURIComponent(siteUrl);
  const resp = await fetchGoogleRead(
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
    const reasons = googleErrorReasonsFromText(text);
    if (resp.status === 403 && reasons.includes('quotaExceeded')) {
      throw new Error(
        'Search Analytics load quota exceeded. Google recommends waiting about 15 minutes before retrying a short-term load-quota failure. If the error persists, reduce expensive page/query grouping or filtering, shorten the date range, and avoid repeatedly requesting the same data.',
      );
    }
    throw new Error(`Search analytics query failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as {
    rows?: SearchAnalyticsRow[];
    responseAggregationType?: string;
    metadata?: GoogleSearchAnalyticsResponseMetadata;
  };
  const metadata: SearchAnalyticsResponseMetadata | undefined =
    data.metadata === undefined
      ? undefined
      : {
          ...(data.metadata.firstIncompleteDate !== undefined
            ? { first_incomplete_date: data.metadata.firstIncompleteDate }
            : {}),
          ...(data.metadata.firstIncompleteHour !== undefined
            ? { first_incomplete_hour: data.metadata.firstIncompleteHour }
            : {}),
        };
  return {
    rows: data.rows ?? [],
    ...(data.responseAggregationType !== undefined
      ? { responseAggregationType: data.responseAggregationType }
      : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/**
 * Fetches Search Analytics rows in 25,000-row pages for higher-level tools.
 * Google's documented pagination contract uses an explicit empty response as
 * the terminal page, so a short non-empty page is not treated as exhaustion.
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
    if (page.rows.length === 0) {
      return { rows, pagesFetched, localLimitReached: false };
    }
    if (rows.length >= maximumRows || page.rows.length > requestedRows) {
      return { rows, pagesFetched, localLimitReached: true };
    }

    startRow += requestedRows;
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
  const resp = await fetchGoogleRead(
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
    .filter(hasRecordedPosition)
    .filter(
      (row) =>
        (row.keys?.length ?? 0) >= 2 &&
        row.position >= minPosition &&
        row.position <= maxPosition &&
        row.impressions >= minImpressions
    )
    .sort(
      (a, b) =>
        b.impressions - a.impressions ||
        a.position - b.position ||
        (a.keys?.[0] ?? '').localeCompare(b.keys?.[0] ?? '') ||
        (a.keys?.[1] ?? '').localeCompare(b.keys?.[1] ?? ''),
    )
    .map((row) => ({
      query: row.keys![0],
      page: row.keys![1],
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
  aggregation_scope: 'observed_query_page_rows';
  pages: CannibalizationPage[];
}

export function processCannibalization(
  rows: SearchAnalyticsRow[],
  minImpressions: number,
  minPagePercentage: number,
): CannibalizationResult[] {
  const queryGroups = new Map<string, Array<{ page: string; clicks: number; impressions: number; ctr: number; position: number }>>();
  for (const row of rows) {
    if ((row.keys?.length ?? 0) < 2 || row.position === undefined) continue;
    const query = row.keys![0];
    const page = row.keys![1];
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
        aggregation_scope: 'observed_query_page_rows',
        pages: competingPages.sort(
          (a, b) => b.impressions - a.impressions || a.page.localeCompare(b.page),
        ),
      });
    }
  }

  return cannibalizationCandidates
    .sort(
      (a, b) =>
        b.total_impressions - a.total_impressions ||
        a.query.localeCompare(b.query),
    );
}

export type ContentDecayClassification =
  | 'likely_decay'
  | 'weak_insufficient_evidence'
  | 'improving_visibility_with_click_volatility';

export interface DecayPageResult {
  page: string;
  classification: ContentDecayClassification;
  evidence: string;
  previous_clicks: number;
  recent_clicks: number;
  click_difference: number;
  click_decay_percentage: number;
  previous_impressions: number;
  recent_impressions: number;
  impression_difference: number;
  impression_change_percentage: number | null;
  previous_position: number;
  recent_position: number;
  position_change: number | null;
}

function percentageChange(current: number, baseline: number): number | null {
  if (baseline === 0) return current === 0 ? 0 : null;
  return Math.round(((current - baseline) / baseline) * 1000) / 10;
}

function classifyContentDecay(input: {
  previousClicks: number;
  recentClicks: number;
  previousImpressions: number;
  recentImpressions: number;
  previousPosition: number;
  recentPosition: number;
}): { classification: ContentDecayClassification; evidence: string } {
  const {
    previousClicks,
    recentClicks,
    previousImpressions,
    recentImpressions,
    previousPosition,
    recentPosition,
  } = input;
  const clickDrop = previousClicks - recentClicks;
  const clickDropPercentage =
    previousClicks > 0 ? (clickDrop / previousClicks) * 100 : 0;
  const impressionGrowth =
    previousImpressions > 0
      ? ((recentImpressions - previousImpressions) / previousImpressions) * 100
      : 0;
  const impressionDrop =
    previousImpressions > 0
      ? ((previousImpressions - recentImpressions) / previousImpressions) * 100
      : 0;
  const positionImprovement =
    previousPosition > 0 && recentPosition > 0
      ? previousPosition - recentPosition
      : 0;
  const positionWorsening =
    previousPosition > 0 && recentPosition > 0
      ? recentPosition - previousPosition
      : 0;

  const lowClickSample = previousClicks < 10 && clickDrop < 5;
  const improvingVisibility =
    impressionGrowth >= 10 && positionImprovement >= 2;

  if (lowClickSample && improvingVisibility) {
    return {
      classification: 'improving_visibility_with_click_volatility',
      evidence:
        'The click decline is small in absolute terms while impressions grew at least 10% and average position improved by at least 2 positions.',
    };
  }

  const meaningfulClickDecline =
    previousClicks >= 10 && clickDrop >= 5 && clickDropPercentage >= 20;
  const corroboratingVisibilityDecline =
    impressionDrop >= 10 || positionWorsening >= 2;

  if (meaningfulClickDecline && corroboratingVisibilityDecline) {
    return {
      classification: 'likely_decay',
      evidence:
        'Clicks fell by at least 5 from a baseline of at least 10, the decline was at least 20%, and impressions or average position also deteriorated materially.',
    };
  }

  return {
    classification: 'weak_insufficient_evidence',
    evidence:
      'Clicks declined, but the absolute sample or supporting impression/position signals are not strong enough to label the page as likely content decay.',
  };
}

export function processContentDecay(
  recentRows: SearchAnalyticsRow[],
  previousRows: SearchAnalyticsRow[],
): DecayPageResult[] {
  const recentMap = new Map<string, { clicks: number; impressions: number; ctr: number; position: number }>();
  for (const row of recentRows) {
    if ((row.keys?.length ?? 0) < 1 || row.position === undefined) continue;
    recentMap.set(row.keys![0], {
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    });
  }

  const decayCandidates: DecayPageResult[] = [];

  for (const row of previousRows) {
    if ((row.keys?.length ?? 0) < 1 || row.position === undefined) continue;
    const page = row.keys![0];
    const prevClicks = row.clicks;
    const prevImps = row.impressions;
    const prevPos = row.position;

    const recent = recentMap.get(page);
    if (!recent) continue;
    const recClicks = recent.clicks;
    const recImps = recent.impressions;
    const recPos = recent.position;

    const clickDiff = recClicks - prevClicks;
    const impDiff = recImps - prevImps;

    if (clickDiff < 0) {
      const { classification, evidence } = classifyContentDecay({
        previousClicks: prevClicks,
        recentClicks: recClicks,
        previousImpressions: prevImps,
        recentImpressions: recImps,
        previousPosition: prevPos,
        recentPosition: recPos,
      });
      decayCandidates.push({
        page,
        classification,
        evidence,
        previous_clicks: prevClicks,
        recent_clicks: recClicks,
        click_difference: clickDiff,
        click_decay_percentage: prevClicks > 0 ? Math.round((Math.abs(clickDiff) / prevClicks) * 1000) / 10 : 0,
        previous_impressions: prevImps,
        recent_impressions: recImps,
        impression_difference: impDiff,
        impression_change_percentage: percentageChange(recImps, prevImps),
        previous_position: prevPos,
        recent_position: recPos,
        position_change:
          prevPos > 0 && recPos > 0
            ? Math.round((recPos - prevPos) * 10) / 10
            : null,
      });
    }
  }

  const classificationOrder: Record<ContentDecayClassification, number> = {
    likely_decay: 0,
    weak_insufficient_evidence: 1,
    improving_visibility_with_click_volatility: 2,
  };
  return decayCandidates.sort(
    (a, b) =>
      classificationOrder[a.classification] -
        classificationOrder[b.classification] ||
      a.click_difference - b.click_difference ||
      a.page.localeCompare(b.page),
  );
}

// Google's Indexing API is not a general-purpose submission API. It is
// currently documented as supporting only job posting pages and livestream
// pages: https://developers.google.com/search/apis/indexing-api/v3/quickstart
const INDEXING_SCOPE_MESSAGE =
  "Google's Indexing API only accepts job posting pages (JobPosting structured data) " +
  'and livestream pages (BroadcastEvent structured data inside VideoObject). ' +
  'It is not available for general webpage submission.';

function normalizeSchemaType(value: string): string {
  const trimmed = value.trim().replace(/[\/#]+$/, '');
  const schemaUrl = trimmed.match(
    /^https?:\/\/(?:www\.)?schema\.org\/([^/?#\s]+)$/i,
  );
  if (schemaUrl) return schemaUrl[1];
  return trimmed;
}

function collectSchemaTypes(node: unknown, types: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectSchemaTypes(item, types);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const type = obj['@type'];
  if (typeof type === 'string') types.add(normalizeSchemaType(type));
  else if (Array.isArray(type)) {
    for (const t of type) {
      if (typeof t === 'string') types.add(normalizeSchemaType(t));
    }
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
  if (typeof type === 'string') types.add(normalizeSchemaType(type));
  else if (Array.isArray(type)) {
    for (const t of type) {
      if (typeof t === 'string') types.add(normalizeSchemaType(t));
    }
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
  if (typeof type === 'string') types.add(normalizeSchemaType(type));
  else if (Array.isArray(type)) {
    for (const t of type) {
      if (typeof t === 'string') types.add(normalizeSchemaType(t));
    }
  }
  if (types.has('VideoObject') && containsBroadcastEvent(obj)) return true;
  return Object.values(obj).some(hasEligibleVideoBroadcast);
}

const VOID_HTML_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function htmlAttribute(attributes: string, name: string): string | undefined {
  const pattern = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`,
    'i',
  );
  const match = pattern.exec(attributes);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function isSchemaVocabulary(value: string | undefined): boolean {
  return Boolean(value && /^https?:\/\/(?:www\.)?schema\.org\/?$/i.test(value.trim()));
}

function explicitSchemaType(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^https?:\/\/(?:www\.)?schema\.org\//i.test(trimmed)) {
    return normalizeSchemaType(trimmed);
  }
  return undefined;
}

function htmlStructuredTypes(
  attributes: string,
  schemaVocabularyInScope: boolean,
): Set<string> {
  const types = new Set<string>();

  const itemType = htmlAttribute(attributes, 'itemtype');
  if (itemType) {
    for (const token of itemType.split(/\s+/)) {
      const normalized = explicitSchemaType(token);
      if (normalized) types.add(normalized);
    }
  }

  const rdfaType = htmlAttribute(attributes, 'typeof');
  if (rdfaType) {
    for (const token of rdfaType.split(/\s+/)) {
      const explicit = explicitSchemaType(token);
      if (explicit) types.add(explicit);
      else if (schemaVocabularyInScope && token.trim()) {
        types.add(normalizeSchemaType(token));
      }
    }
  }

  return types;
}

/**
 * Recognize static Microdata/RDFa eligibility without turning this preflight
 * into a general-purpose HTML validator. The stack is only used to enforce
 * Google's VideoObject -> BroadcastEvent nesting requirement.
 */
function hasEligibleHtmlStructuredData(html: string): boolean {
  const staticMarkup = html
    .replace(/<!--(?:[\s\S]*?)-->/g, '')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const stack: Array<{
    tag: string;
    schemaVocabulary: boolean;
    videoObjectInScope: boolean;
  }> = [];
  const tagPattern = /<\s*(\/?)\s*([a-zA-Z][\w:-]*)([^>]*)>/g;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(staticMarkup)) !== null) {
    const closing = match[1] === '/';
    const tag = match[2].toLowerCase();
    const attributes = match[3];

    if (closing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].tag === tag) {
          stack.length = index;
          break;
        }
      }
      continue;
    }

    const parent = stack.at(-1);
    const schemaVocabulary =
      isSchemaVocabulary(htmlAttribute(attributes, 'vocab')) ||
      parent?.schemaVocabulary === true;
    const types = htmlStructuredTypes(attributes, schemaVocabulary);
    if (types.has('JobPosting')) return true;

    const videoObjectInScope =
      types.has('VideoObject') || parent?.videoObjectInScope === true;
    if (types.has('BroadcastEvent') && videoObjectInScope) return true;

    const selfClosing = /\/\s*$/.test(attributes);
    if (!selfClosing && !VOID_HTML_TAGS.has(tag)) {
      stack.push({ tag, schemaVocabulary, videoObjectInScope });
    }
  }

  return false;
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
 * by inspecting static JSON-LD, Microdata, and RDFa markup. Best-effort: if
 * the page can't be fetched or parsed, eligibility can't be confirmed and the
 * URL is treated as ineligible rather than silently submitted.
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
  const scriptPattern =
    /<script\b[^>]*\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/gi;
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

  if (
    types.has('JobPosting') ||
    hasVideoBroadcast ||
    hasEligibleHtmlStructuredData(html)
  ) {
    return { eligible: true };
  }

  return {
    eligible: false,
    reason: `${url} does not appear to contain JobPosting structured data or a BroadcastEvent inside VideoObject. ${INDEXING_SCOPE_MESSAGE}`,
  };
}

function hasRobotsNoindexMeta(html: string): boolean {
  // HTML permits an omitted </head>, so stop at </head>, <body>, or EOF.
  const head = /<head\b[^>]*>([\s\S]*?)(?:<\/head\s*>|<body\b|$)/i.exec(html)?.[1];
  if (!head) return false;

  const metaPattern = /<meta\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = metaPattern.exec(head)) !== null) {
    const name = htmlAttribute(match[1], 'name')?.trim().toLowerCase();
    if (name !== 'robots') continue;
    const content = htmlAttribute(match[1], 'content')?.trim().toLowerCase();
    if (!content) continue;
    const directives = content.split(/[\s,]+/).filter(Boolean);
    if (directives.includes('noindex')) return true;
  }

  return false;
}

const INDEXING_REMOVAL_REQUIREMENT_MESSAGE =
  'Before requesting removal, Google requires the URL to return HTTP 404 or 410, or the page to contain a robots noindex meta directive.';

/**
 * Verifies Google's documented precondition for an Indexing API URL_DELETED
 * notification without requiring the page to keep its former structured data.
 */
export async function checkIndexingRemovalEligibility(
  url: string,
  { timeoutMs = INDEXING_ELIGIBILITY_TIMEOUT_MS }: IndexingEligibilityOptions = {},
): Promise<IndexingEligibility> {
  if (!isHttpUrl(url)) {
    return {
      eligible: false,
      reason: `${url} must be a valid HTTP or HTTPS URL. ${INDEXING_REMOVAL_REQUIREMENT_MESSAGE}`,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        'user-agent':
          'Mozilla/5.0 (compatible; DigestSEO-GSC-MCP/1.0; +https://github.com/AKzar1el/mcp-gsc)',
      },
    });

    if (resp.status === 404 || resp.status === 410) {
      await cancelResponseBody(resp);
      return { eligible: true };
    }

    if (!resp.ok) {
      await cancelResponseBody(resp);
      return {
        eligible: false,
        reason: `Could not confirm indexing-removal eligibility for ${url} (HTTP ${resp.status}). ${INDEXING_REMOVAL_REQUIREMENT_MESSAGE}`,
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
        reason: `Could not confirm indexing-removal eligibility for ${url} (expected HTML, received ${contentType}). ${INDEXING_REMOVAL_REQUIREMENT_MESSAGE}`,
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
        reason: `Could not confirm indexing-removal eligibility for ${url} (response exceeds the ${INDEXING_ELIGIBILITY_MAX_RESPONSE_BYTES}-byte limit). ${INDEXING_REMOVAL_REQUIREMENT_MESSAGE}`,
      };
    }

    const html = await readBoundedResponseText(resp);
    if (hasRobotsNoindexMeta(html)) return { eligible: true };

    return {
      eligible: false,
      reason: `${url} does not currently return HTTP 404/410 and does not expose a robots noindex meta directive. ${INDEXING_REMOVAL_REQUIREMENT_MESSAGE}`,
    };
  } catch (err) {
    const detail = timedOut
      ? `timed out after ${timeoutMs}ms`
      : (err as Error).message;
    return {
      eligible: false,
      reason: `Could not confirm indexing-removal eligibility for ${url} (${detail}). ${INDEXING_REMOVAL_REQUIREMENT_MESSAGE}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function publishIndexingNotification(
  accessToken: string,
  url: string,
  type: 'URL_UPDATED' | 'URL_DELETED',
  actionLabel: string,
): Promise<unknown> {
  const resp = await fetch(
    'https://indexing.googleapis.com/v3/urlNotifications:publish',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ url, type }),
    },
  );
  if (resp.status === 401) {
    throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${actionLabel} failed: ${resp.status} ${text}`);
  }
  return await resp.json();
}

export async function requestIndexing(
  accessToken: string,
  url: string,
): Promise<unknown> {
  const eligibility = await checkIndexingEligibility(url);
  if (!eligibility.eligible) {
    throw new Error(eligibility.reason);
  }
  return publishIndexingNotification(accessToken, url, 'URL_UPDATED', 'Request indexing');
}

export async function requestIndexingRemoval(
  accessToken: string,
  url: string,
): Promise<unknown> {
  const eligibility = await checkIndexingRemovalEligibility(url);
  if (!eligibility.eligible) {
    throw new Error(eligibility.reason);
  }
  return publishIndexingNotification(
    accessToken,
    url,
    'URL_DELETED',
    'Request indexing removal',
  );
}

export interface IndexingNotification {
  url?: string;
  type?: 'URL_UPDATED' | 'URL_DELETED' | string;
  notifyTime?: string;
}

export interface IndexingNotificationMetadata {
  url?: string;
  latestUpdate?: IndexingNotification;
  latestRemove?: IndexingNotification;
}

export async function getIndexingNotificationMetadata(
  accessToken: string,
  url: string,
): Promise<IndexingNotificationMetadata> {
  const endpoint = new URL(
    'https://indexing.googleapis.com/v3/urlNotifications/metadata',
  );
  endpoint.searchParams.set('url', url);

  const resp = await fetchGoogleRead(endpoint.toString(), {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (resp.status === 401) {
    throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Get indexing notification status failed: ${resp.status} ${text}`,
    );
  }
  return (await resp.json()) as IndexingNotificationMetadata;
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
    if ((row.keys?.length ?? 0) < 1 || row.position === undefined) continue;
    mapB.set(row.keys![0], {
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    });
  }

  const comparison: PerformanceComparisonRow[] = [];

  for (const row of rowsA) {
    if ((row.keys?.length ?? 0) < 1 || row.position === undefined) continue;
    const key = row.keys![0];
    const clicksA = row.clicks;
    const impsA = row.impressions;
    const ctrA = row.ctr;
    const posA = row.position;

    const b = mapB.get(key);
    if (!b) continue;
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

  return comparison.sort(
    (a, b) =>
      Math.abs(b.diff.clicks) - Math.abs(a.diff.clicks) ||
      Math.abs(b.diff.impressions) - Math.abs(a.diff.impressions) ||
      a.key.localeCompare(b.key),
  );
}



