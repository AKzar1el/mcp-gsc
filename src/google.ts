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

function assertGoogleAccessTokenResponse(
  value: unknown,
): asserts value is { access_token: string; expires_in: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Google token response missing a valid access_token.');
  }
  const token = value as Record<string, unknown>;
  if (typeof token.access_token !== 'string' || !token.access_token.trim()) {
    throw new Error('Google token response missing a valid access_token.');
  }
  if (
    typeof token.expires_in !== 'number' ||
    !Number.isFinite(token.expires_in) ||
    token.expires_in <= 0
  ) {
    throw new Error('Google token response missing a valid expires_in.');
  }
}

export const MCP_RECONNECT_INSTRUCTION =
  "Please reconnect this server from your MCP client's connector or app settings.";

// Google invalid_grant and API 401 do not by themselves prove user revocation.
export const GSC_ACCESS_REVOKED_MESSAGE =
  `Google authorization has expired, been revoked, or requires reauthentication. ${MCP_RECONNECT_INSTRUCTION}`;

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

function googleErrorDetailsFromText(text: string): {
  reasons: string[];
  message?: string;
  status?: string;
  quotaMetrics?: string[];
} {
  try {
    const data = JSON.parse(text) as {
      error?: {
        message?: unknown;
        status?: unknown;
        errors?: Array<{ reason?: unknown }>;
        details?: Array<{
          '@type'?: unknown;
          reason?: unknown;
          metadata?: { quota_metric?: unknown };
          violations?: Array<{ quotaMetric?: unknown; quota_metric?: unknown }>;
        }>;
      };
    };
    const legacyReasons = Array.isArray(data.error?.errors)
      ? data.error.errors.map((entry) => entry?.reason)
      : [];
    // Modern Google errors may carry quota reasons in google.rpc.ErrorInfo.
    const structuredReasons = Array.isArray(data.error?.details)
      ? data.error.details
        .filter((entry) => entry?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo')
        .map((entry) => entry.reason)
      : [];
    const quotaMetrics = Array.isArray(data.error?.details)
      ? data.error.details
        .flatMap((entry) => {
          if (entry?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo') {
            return [entry.metadata?.quota_metric];
          }
          if (entry?.['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure' &&
              Array.isArray(entry.violations)) {
            return entry.violations.map((violation) =>
              violation?.quotaMetric ?? violation?.quota_metric);
          }
          return [];
        })
        .filter((metric): metric is string => typeof metric === 'string')
      : [];
    return {
      reasons: [...legacyReasons, ...structuredReasons]
        .filter((reason): reason is string => typeof reason === 'string'),
      ...(typeof data.error?.message === 'string' ? { message: data.error.message } : {}),
      ...(typeof data.error?.status === 'string' ? { status: data.error.status } : {}),
      ...(quotaMetrics.length > 0 ? { quotaMetrics } : {}),
    };
  } catch {
    return { reasons: [] };
  }
}

const GOOGLE_ERROR_MAX_BYTES = 16_384;

async function readBoundedGoogleError(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const buffer = new Uint8Array(GOOGLE_ERROR_MAX_BYTES + 1);
  let received = 0;
  let completed = false;
  try {
    while (received < buffer.length) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      const toCopy = Math.min(value.byteLength, buffer.length - received);
      buffer.set(value.subarray(0, toCopy), received);
      received += toCopy;
    }
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // The upstream response may already be closed.
      }
    }
    reader.releaseLock();
  }

  const truncated = received > GOOGLE_ERROR_MAX_BYTES;
  const text = new TextDecoder().decode(
    buffer.subarray(0, Math.min(received, GOOGLE_ERROR_MAX_BYTES)),
  );
  return truncated ? `${text} [Google error body truncated]` : text;
}

async function classifyGoogleReadResponse(
  response: Response,
): Promise<{ response: Response; retryable: boolean }> {
  if (GOOGLE_READ_RETRYABLE_STATUSES.has(response.status)) {
    return { response, retryable: true };
  }
  if (response.status !== 403) return { response, retryable: false };

  // Consume the original 403 body once; cloning and parsing the whole stream
  // before error handling bypasses the diagnostic limit.
  const text = await readBoundedGoogleError(response);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  const boundedResponse = new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  const { reasons } = googleErrorDetailsFromText(text);
  return {
    response: boundedResponse,
    retryable: reasons.some((reason) => GOOGLE_READ_RETRYABLE_403_REASONS.has(reason)),
  };
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

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'name' in error && error.name === 'AbortError';
}

async function fetchGoogleRead(
  url: string,
  init?: RequestInit,
  beforeRetry?: () => Promise<void>,
): Promise<Response> {
  let lastNetworkError: unknown;

  for (let attempt = 1; attempt <= GOOGLE_READ_MAX_ATTEMPTS; attempt += 1) {
    // The caller must reserve quota before a second or later upstream attempt.
    // Keep this outside the fetch catch so a denied reservation is never retried.
    if (attempt > 1) await beforeRetry?.();
    try {
      const providerResponse = await fetch(url, init);
      const { response, retryable } = await classifyGoogleReadResponse(providerResponse);
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
      // Cancellation is not a transient network failure. Retrying a canceled
      // request wastes time and charges additional shared quota reservations.
      if (isAbortError(error) || init?.signal?.aborted) throw error;
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
    const text = await readBoundedGoogleError(resp);
    throw new Error(`Token exchange failed: ${resp.status} ${text}`);
  }
  const data: unknown = await readBoundedGoogleSuccessJson(resp, 'OAuth');
  assertGoogleAccessTokenResponse(data);
  if (
    !('refresh_token' in data) ||
    typeof data.refresh_token !== 'string' ||
    !data.refresh_token.trim()
  ) {
    throw new Error('Google did not return a valid refresh_token');
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
    const text = await readBoundedGoogleError(resp);
    throw new Error(`Userinfo fetch failed: ${resp.status} ${text}`);
  }
  const profile: unknown = await readBoundedGoogleSuccessJson(resp, 'OAuth');
  if (
    !profile ||
    typeof profile !== 'object' ||
    Array.isArray(profile) ||
    !('id' in profile) ||
    typeof profile.id !== 'string' ||
    !profile.id.trim() ||
    !('email' in profile) ||
    typeof profile.email !== 'string' ||
    !profile.email.trim()
  ) {
    // The Google ID keys the encrypted refresh-token record and OAuth tenant.
    // An unchecked/undefined ID could collapse distinct sign-ins into one KV key.
    throw new Error('Google userinfo response missing a valid account ID or email.');
  }
  return profile as GoogleUserInfo;
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
      const errBody = JSON.parse(await readBoundedGoogleError(resp)) as { error?: string };
      parsedError = errBody.error;
    } catch {
      // body was not JSON
    }
    if (parsedError === 'invalid_grant') {
      throw new GoogleRefreshTokenRevokedError();
    }
    throw new Error(`Failed to refresh Google access token: ${resp.status}`);
  }
  const data: unknown = await readBoundedGoogleSuccessJson(resp, 'OAuth');
  assertGoogleAccessTokenResponse(data);
  return { access_token: data.access_token, expires_in: data.expires_in };
}

// Successful Google JSON payloads are not inherently small: an upstream
// response without Content-Length must not be fully materialized by .json().
const GOOGLE_SUCCESS_JSON_MAX_BYTES = 2 * 1024 * 1024;
// Search Analytics may legitimately return thousands of rows; retain a larger
// bounded budget without exposing the Worker to unbounded provider JSON.
const GOOGLE_ANALYTICS_SUCCESS_JSON_MAX_BYTES = 16 * 1024 * 1024;

async function readBoundedGoogleSuccessJson<T>(
  response: Response,
  context: 'metadata' | 'URL Inspection' | 'OAuth' | 'Search Analytics' = 'metadata',
): Promise<T> {
  const description = context === 'metadata' ? 'metadata response'
    : context === 'OAuth' ? 'OAuth response'
      : context === 'Search Analytics' ? 'Search Analytics response' : 'URL Inspection response';
  const service = context === 'OAuth' ? 'Google' : 'Google Search Console';
  const maxBytes = context === 'Search Analytics'
    ? GOOGLE_ANALYTICS_SUCCESS_JSON_MAX_BYTES
    : GOOGLE_SUCCESS_JSON_MAX_BYTES;
  const sizeError =
    `${service} ${description} exceeds the ${maxBytes / (1024 * 1024)} MiB byte limit.` +
    (context === 'Search Analytics' ? ' Reduce row_limit or group by fewer dimensions.' : '');
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      // The size-limit error remains authoritative even if cleanup fails.
    }
    throw new Error(sizeError);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${service} ${description} body is empty.`);

  const chunks: Uint8Array[] = [];
  let size = 0;
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      if (value.byteLength > maxBytes - size) {
        throw new Error(sizeError);
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    if (!finished) {
      try {
        await reader.cancel();
      } catch {
        // The upstream response may already be closed.
      }
    }
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export interface SiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

function isSiteEntry(value: unknown): value is SiteEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.siteUrl === 'string' && entry.siteUrl.trim().length > 0 &&
    typeof entry.permissionLevel === 'string' && entry.permissionLevel.trim().length > 0
  );
}

export async function listSites(
  accessToken: string,
  beforeRetry?: () => Promise<void>,
): Promise<SiteEntry[]> {
  const resp = await fetchGoogleRead('https://www.googleapis.com/webmasters/v3/sites', {
    headers: { authorization: `Bearer ${accessToken}` },
  }, beforeRetry);
  if (resp.status === 401) {
    throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
  }
  if (!resp.ok) {
    const text = await readBoundedGoogleError(resp);
    throw new Error(`List sites failed: ${resp.status} ${text}`);
  }
  const data: unknown = await readBoundedGoogleSuccessJson(resp);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Google Search Console sites.list response contains invalid siteEntry data.');
  }
  const entries = (data as { siteEntry?: unknown }).siteEntry;
  if (entries == null) return [];
  if (!Array.isArray(entries) || !entries.every(isSiteEntry)) {
    throw new Error('Google Search Console sites.list response contains invalid siteEntry data.');
  }
  return entries;
}

export async function getSite(
  accessToken: string,
  siteUrl: string,
  beforeRetry?: () => Promise<void>,
): Promise<SiteEntry> {
  const encoded = encodeURIComponent(siteUrl);
  const resp = await fetchGoogleRead(
    `https://www.googleapis.com/webmasters/v3/sites/${encoded}`,
    {
      headers: { authorization: `Bearer ${accessToken}` },
    },
    beforeRetry,
  );
  if (resp.status === 401) {
    throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
  }
  if (!resp.ok) {
    const text = await readBoundedGoogleError(resp);
    throw new Error(`Get site failed: ${resp.status} ${text}`);
  }
  const data: unknown = await readBoundedGoogleSuccessJson(resp);
  if (!isSiteEntry(data)) {
    throw new Error('Google Search Console sites.get response contains invalid property data.');
  }
  return data;
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

export function assertSearchAnalyticsFilterCompatible(
  filter: DimensionFilter,
): void {
  if (filter.operator !== 'equals' && filter.operator !== 'notEquals') return;

  if (filter.dimension === 'country' && !/^[A-Za-z]{3}$/.test(filter.expression)) {
    throw new Error(
      'Search Analytics exact country filters must use a three-letter ISO 3166-1 alpha-3 code.',
    );
  }

  if (
    filter.dimension === 'device' &&
    !['DESKTOP', 'MOBILE', 'TABLET'].includes(filter.expression.toUpperCase())
  ) {
    throw new Error(
      'Search Analytics exact device filters must use DESKTOP, MOBILE, or TABLET.',
    );
  }
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
    assertSearchAnalyticsFilterCompatible(filter);
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

export interface SearchAnalyticsResponse {
  rows: SearchAnalyticsRow[];
  responseAggregationType?: string;
  metadata?: SearchAnalyticsResponseMetadata;
}

function validSearchAnalyticsMetric(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validSearchAnalyticsRow(
  value: unknown,
  expectedDimensionCount: number,
): value is SearchAnalyticsRow {
  const row = asUnknownRecord(value);
  return row !== undefined &&
    (expectedDimensionCount === 0 && row.keys === undefined ||
      (Array.isArray(row.keys) &&
        row.keys.length === expectedDimensionCount &&
        row.keys.every((key) => typeof key === 'string'))) &&
    validSearchAnalyticsMetric(row.clicks) &&
    validSearchAnalyticsMetric(row.impressions) &&
    validSearchAnalyticsMetric(row.ctr) &&
    (row.position === undefined || validSearchAnalyticsMetric(row.position));
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
  beforeRetry?: () => Promise<void>;
}

export async function inspectUrl(
  accessToken: string,
  siteUrl: string,
  inspectionUrl: string,
  languageCode?: string,
  beforeRetry?: () => Promise<void>,
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
    beforeRetry,
  );
  if (resp.status === 401) {
    throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
  }
  if (!resp.ok) {
    const text = await readBoundedGoogleError(resp);
    throw new Error(`URL inspection failed: ${resp.status} ${text}`);
  }
  const data = asUnknownRecord(await readBoundedGoogleSuccessJson<unknown>(resp, 'URL Inspection'));
  const inspectionResult = data?.inspectionResult;
  const result = asUnknownRecord(inspectionResult);
  const nestedResults = ['indexStatusResult', 'ampResult', 'mobileUsabilityResult', 'richResultsResult'] as const;
  const malformedNestedResult = result && nestedResults.some((field) =>
    result[field] != null && !asUnknownRecord(result[field]));
  if (!data || (inspectionResult != null && !result) ||
      (result?.inspectionResultLink != null && typeof result.inspectionResultLink !== 'string') ||
      malformedNestedResult) {
    throw new Error('URL Inspection response contains invalid inspection data.');
  }
  return inspectionResult ?? null;
}

export type UrlInspectionIndexedState = 'indexed' | 'not_indexed' | 'unknown';

export interface UrlInspectionIndexStatusSummary {
  indexed_state: UrlInspectionIndexedState;
  verdict?: string;
  coverage_state?: string;
  robots_txt_state?: string;
  indexing_state?: string;
  last_crawl_time?: string;
  page_fetch_state?: string;
  google_canonical?: string;
  user_canonical?: string;
  crawled_as?: string;
}

function asUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalStringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function summarizeUrlInspectionIndexStatus(
  inspectionResult: unknown,
): UrlInspectionIndexStatusSummary {
  const result = asUnknownRecord(inspectionResult);
  const indexStatus = asUnknownRecord(result?.indexStatusResult);
  const verdict = optionalStringField(indexStatus, 'verdict');
  const coverageState = optionalStringField(indexStatus, 'coverageState');
  const robotsTxtState = optionalStringField(indexStatus, 'robotsTxtState');
  const indexingState = optionalStringField(indexStatus, 'indexingState');
  const lastCrawlTime = optionalStringField(indexStatus, 'lastCrawlTime');
  const pageFetchState = optionalStringField(indexStatus, 'pageFetchState');
  const googleCanonical = optionalStringField(indexStatus, 'googleCanonical');
  const userCanonical = optionalStringField(indexStatus, 'userCanonical');
  const crawledAs = optionalStringField(indexStatus, 'crawledAs');
  const indexedState: UrlInspectionIndexedState =
    verdict === 'PASS'
      ? 'indexed'
      : verdict === 'FAIL' || verdict === 'NEUTRAL'
        ? 'not_indexed'
        : 'unknown';

  return {
    indexed_state: indexedState,
    ...(verdict !== undefined ? { verdict } : {}),
    ...(coverageState !== undefined ? { coverage_state: coverageState } : {}),
    ...(robotsTxtState !== undefined ? { robots_txt_state: robotsTxtState } : {}),
    ...(indexingState !== undefined ? { indexing_state: indexingState } : {}),
    ...(lastCrawlTime !== undefined ? { last_crawl_time: lastCrawlTime } : {}),
    ...(pageFetchState !== undefined ? { page_fetch_state: pageFetchState } : {}),
    ...(googleCanonical !== undefined ? { google_canonical: googleCanonical } : {}),
    ...(userCanonical !== undefined ? { user_canonical: userCanonical } : {}),
    ...(crawledAs !== undefined ? { crawled_as: crawledAs } : {}),
  };
}

export interface UrlInspectionBatchResult {
  inspectionUrl: string;
  inspectionResult?: unknown;
  error?: string;
}

// Retained for consumers of the former concurrent helper; requests are now serial.
export const URL_INSPECTION_BATCH_CONCURRENCY = 1;

export async function inspectUrlsSequentially(
  accessToken: string,
  siteUrl: string,
  inspectionUrls: readonly string[],
  languageCode?: string,
  beforeRetry?: () => Promise<void>,
): Promise<UrlInspectionBatchResult[]> {
  const results: UrlInspectionBatchResult[] = [];
  let quotaExhausted = false;

  for (const inspectionUrl of inspectionUrls) {
    if (quotaExhausted) {
      results.push({
        inspectionUrl,
        error: 'Not inspected because Google URL Inspection reported a quota or rate-limit error earlier in this batch.',
      });
      continue;
    }
    try {
      results.push({
        inspectionUrl,
        inspectionResult: await inspectUrl(
          accessToken,
          siteUrl,
          inspectionUrl,
          languageCode,
          beforeRetry,
        ),
      });
    } catch (error) {
      // A canceled batch must not inspect further URLs or consume their quotas.
      if (isAbortError(error) ||
          (error instanceof Error && error.message === GSC_ACCESS_REVOKED_MESSAGE)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'URL inspection failed.';
      results.push({ inspectionUrl, error: message });
      // A provider-wide quota failure makes subsequent inspections waste calls.
      // Keep ordinary 403 permission failures scoped to the current URL.
      const google403Prefix = 'URL inspection failed: 403 ';
      const google403 = message.startsWith(google403Prefix)
        ? googleErrorDetailsFromText(message.slice(google403Prefix.length))
        : undefined;
      const isQuota403 = google403 !== undefined &&
        (google403.status === 'RESOURCE_EXHAUSTED' ||
          google403.reasons.some(
            (reason) => GOOGLE_READ_RETRYABLE_403_REASONS.has(reason) ||
              reason === 'quotaExceeded' || reason === 'RATE_LIMIT_EXCEEDED',
          ));
      if (/^URL inspection failed: 429(?:\s|$)/.test(message) || isQuota403) {
        quotaExhausted = true;
      }
    }
  }

  return results;
}

// Kept for compatibility with callers that imported the original helper directly.
export const inspectUrlsBoundedConcurrently = inspectUrlsSequentially;

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

function isSitemapEntry(value: unknown): value is SitemapEntry {
  const entry = asUnknownRecord(value);
  if (!entry || typeof entry.path !== 'string' || !entry.path.trim()) {
    return false;
  }
  for (const field of ['lastSubmitted', 'type', 'lastDownloaded', 'warnings', 'errors']) {
    const fieldValue = entry[field];
    if (fieldValue != null && typeof fieldValue !== 'string') return false;
  }
  for (const field of ['isPending', 'isSitemapsIndex']) {
    const fieldValue = entry[field];
    if (fieldValue != null && typeof fieldValue !== 'boolean') return false;
  }
  if (entry.contents == null) return true;
  return Array.isArray(entry.contents) && entry.contents.every((item) => {
    const content = asUnknownRecord(item);
    return content !== undefined &&
      typeof content.type === 'string' &&
      typeof content.submitted === 'string';
  });
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
  beforeRetry?: () => Promise<void>,
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
    beforeRetry,
  );
  if (resp.status === 401) {
    throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
  }
  if (!resp.ok) {
    const text = await readBoundedGoogleError(resp);
    throw new Error(`List sitemaps failed: ${resp.status} ${text}`);
  }
  const data = asUnknownRecord(await readBoundedGoogleSuccessJson(resp));
  const entries = data?.sitemap;
  if (!data || (entries != null && (!Array.isArray(entries) || !entries.every(isSitemapEntry)))) {
    throw new Error('Google Search Console sitemaps.list response contains invalid sitemap data.');
  }
  return (entries ?? []).map(normalizeSitemap);
}

export async function querySearchAnalytics(
  accessToken: string,
  siteUrl: string,
  body: SearchAnalyticsQuery,
  beforeRetry?: () => Promise<void>,
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
    beforeRetry,
  );
  if (resp.status === 401) {
    throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
  }
  if (!resp.ok) {
    const text = await readBoundedGoogleError(resp);
    const { message, quotaMetrics } = googleErrorDetailsFromText(text);
    // Search Console also sends load-quota errors with a message but no legacy
    // error.errors[] reason. Do not misclassify unrelated permission denials.
    const loadQuotaMessage = message !== undefined &&
      /Search Analytics load quota exceeded|quota exceeded for quota metric SearchAnalyticsLoad(?![\w./-])/i.test(message);
    const structuredLoadQuota = quotaMetrics?.some(
      (metric) => /(?:^|\/)SearchAnalyticsLoad$/i.test(metric),
    );
    if (resp.status === 403 && (loadQuotaMessage || structuredLoadQuota)) {
      throw new Error(
        'Search Analytics load quota exceeded. Google recommends waiting about 15 minutes before retrying a short-term load-quota failure. If the error persists, reduce expensive page/query grouping or filtering, shorten the date range, and avoid repeatedly requesting the same data.',
      );
    }
    throw new Error(`Search analytics query failed: ${resp.status} ${text}`);
  }
  const payload = await readBoundedGoogleSuccessJson<unknown>(resp, 'Search Analytics');
  const data = asUnknownRecord(payload);
  if (!data) {
    throw new Error('Search Analytics response contains invalid metadata.');
  }
  const rows = data.rows === undefined ? [] : data.rows;
  if (!Array.isArray(rows) || !rows.every((row) => validSearchAnalyticsRow(row, body.dimensions.length))) {
    throw new Error('Search Analytics response contains invalid rows.');
  }
  if (rows.length > body.rowLimit) {
    throw new Error('Search Analytics response contains invalid rows: requested rowLimit exceeded.');
  }
  const rawMetadata = data.metadata === undefined ? undefined : asUnknownRecord(data.metadata);
  if ((data.metadata !== undefined && !rawMetadata) ||
      (data.responseAggregationType !== undefined && typeof data.responseAggregationType !== 'string') ||
      (rawMetadata && (['firstIncompleteDate', 'firstIncompleteHour'] as const).some(
        (key) => rawMetadata[key] !== undefined && typeof rawMetadata[key] !== 'string'
      ))) {
    throw new Error('Search Analytics response contains invalid metadata.');
  }
  const metadata: SearchAnalyticsResponseMetadata | undefined =
    rawMetadata === undefined
      ? undefined
      : {
          ...(rawMetadata.firstIncompleteDate !== undefined
            ? { first_incomplete_date: rawMetadata.firstIncompleteDate as string }
            : {}),
          ...(rawMetadata.firstIncompleteHour !== undefined
            ? { first_incomplete_hour: rawMetadata.firstIncompleteHour as string }
            : {}),
        };
  return {
    rows,
    ...(data.responseAggregationType !== undefined
      ? { responseAggregationType: data.responseAggregationType as string }
      : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/**
 * Fetches Search Analytics rows in 25,000-row pages for higher-level tools.
 * Google's documented pagination contract treats a response shorter than the
 * requested rowLimit as exhausted. An exactly full final page still requires
 * a following empty-page probe unless the local safety ceiling is reached.
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
    }, options.beforeRetry);
    pagesFetched += 1;

    const acceptedRows = page.rows.slice(0, requestedRows);
    rows.push(...acceptedRows);
    if (page.rows.length < requestedRows) {
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
    const text = await readBoundedGoogleError(resp);
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
    const text = await readBoundedGoogleError(resp);
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
    const text = await readBoundedGoogleError(resp);
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
    const text = await readBoundedGoogleError(resp);
    throw new Error(`Delete sitemap failed: ${resp.status} ${text}`);
  }
}

export async function getSitemap(
  accessToken: string,
  siteUrl: string,
  feedpath: string,
  beforeRetry?: () => Promise<void>,
): Promise<SitemapEntry> {
  const encodedSite = encodeURIComponent(siteUrl);
  const encodedFeed = encodeURIComponent(feedpath);
  const resp = await fetchGoogleRead(
    `https://www.googleapis.com/webmasters/v3/sites/${encodedSite}/sitemaps/${encodedFeed}`,
    {
      headers: { authorization: `Bearer ${accessToken}` },
    },
    beforeRetry,
  );
  if (resp.status === 401) {
    throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
  }
  if (!resp.ok) {
    const text = await readBoundedGoogleError(resp);
    throw new Error(`Get sitemap failed: ${resp.status} ${text}`);
  }
  const entry: unknown = await readBoundedGoogleSuccessJson(resp);
  if (!isSitemapEntry(entry)) {
    throw new Error('Google Search Console sitemaps.get response contains invalid sitemap data.');
  }
  return normalizeSitemap(entry);
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

type JsonLdSchemaContext = {
  vocabulary: string | null;
  terms: Record<string, string | null>;
};

const EMPTY_JSON_LD_CONTEXT: JsonLdSchemaContext = {
  vocabulary: null,
  terms: Object.create(null) as Record<string, string | null>,
};

/**
 * Resolve only inline contexts. Fetching arbitrary remote JSON-LD context URLs
 * would make a security-sensitive eligibility preflight network-dependent.
 */
function resolveJsonLdContext(
  inherited: JsonLdSchemaContext,
  local: unknown,
): JsonLdSchemaContext {
  if (Array.isArray(local)) {
    return local.reduce<JsonLdSchemaContext>(
      (context, entry) => resolveJsonLdContext(context, entry),
      inherited,
    );
  }
  if (typeof local === 'string') {
    return {
      vocabulary: isSchemaVocabulary(local) ? 'https://schema.org/' : null,
      terms: Object.create(null) as Record<string, string | null>,
    };
  }
  if (!local || typeof local !== 'object') return EMPTY_JSON_LD_CONTEXT;
  const definitions = local as Record<string, unknown>;
  // Null-prototype maps prevent JSON-LD terms such as constructor/__proto__
  // from resolving against or mutating JavaScript object prototypes.
  const terms = Object.assign(
    Object.create(null) as Record<string, string | null>,
    inherited.terms,
  );
  let vocabulary = inherited.vocabulary;
  if (Object.prototype.hasOwnProperty.call(definitions, '@vocab')) {
    vocabulary =
      typeof definitions['@vocab'] === 'string' &&
      isSchemaVocabulary(definitions['@vocab'])
        ? 'https://schema.org/'
        : null;
  }
  for (const [term, definition] of Object.entries(definitions)) {
    if (term.startsWith('@')) continue;
    const identifier = typeof definition === 'string'
      ? definition
      : definition && typeof definition === 'object' && !Array.isArray(definition)
        ? (definition as Record<string, unknown>)['@id']
        : undefined;
    if (typeof identifier === 'string') terms[term] = identifier;
    else terms[term] = null;
  }
  return { vocabulary, terms };
}

function schemaTypeInContext(
  type: string,
  context: JsonLdSchemaContext,
): string | undefined {
  const trimmed = type.trim();
  const explicit = explicitSchemaType(trimmed);
  if (explicit) return explicit;
  // A local null/invalid term definition disables the term even if @vocab
  // otherwise points to schema.org.
  if (Object.prototype.hasOwnProperty.call(context.terms, trimmed)) {
    const mapped = context.terms[trimmed];
    return typeof mapped === 'string' ? explicitSchemaType(mapped) : undefined;
  }
  if (context.vocabulary && /^[A-Za-z][\w-]*$/.test(trimmed)) return trimmed;
  return undefined;
}

function schemaTypesInNode(
  node: Record<string, unknown>,
  context: JsonLdSchemaContext,
): Set<string> {
  const types = new Set<string>();
  const raw = node['@type'];
  for (const type of Array.isArray(raw) ? raw : [raw]) {
    if (typeof type !== 'string') continue;
    const resolved = schemaTypeInContext(type, context);
    if (resolved) types.add(resolved);
  }
  return types;
}

function collectSchemaTypes(
  node: unknown,
  types: Set<string>,
  inherited: JsonLdSchemaContext = EMPTY_JSON_LD_CONTEXT,
): void {
  if (Array.isArray(node)) {
    for (const item of node) collectSchemaTypes(item, types, inherited);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  // Context declarations and typed literals are never eligible entities.
  if (Object.prototype.hasOwnProperty.call(obj, '@value')) return;
  const context = Object.prototype.hasOwnProperty.call(obj, '@context')
    ? resolveJsonLdContext(inherited, obj['@context'])
    : inherited;
  for (const type of schemaTypesInNode(obj, context)) types.add(type);
  for (const [key, value] of Object.entries(obj)) {
    if (key === '@type' || key === '@context') continue;
    collectSchemaTypes(value, types, context);
  }
}

function isSchemaPublicationProperty(
  property: string,
  context: JsonLdSchemaContext,
): boolean {
  return schemaTypeInContext(property, context) === 'publication';
}

/** Only a schema.org VideoObject.publication BroadcastEvent establishes a livestream. */
function isBroadcastPublication(
  node: unknown,
  inherited: JsonLdSchemaContext,
): boolean {
  if (Array.isArray(node)) {
    return node.some((item) => isBroadcastPublication(item, inherited));
  }
  if (!node || typeof node !== 'object') return false;
  const obj = node as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, '@value')) return false;
  const context = Object.prototype.hasOwnProperty.call(obj, '@context')
    ? resolveJsonLdContext(inherited, obj['@context'])
    : inherited;
  return schemaTypesInNode(obj, context).has('BroadcastEvent');
}

/** Preserve each node's effective context across JSON-LD graphs and nesting. */
function hasEligibleVideoBroadcast(
  node: unknown,
  inherited: JsonLdSchemaContext = EMPTY_JSON_LD_CONTEXT,
): boolean {
  if (Array.isArray(node)) {
    return node.some((item) => hasEligibleVideoBroadcast(item, inherited));
  }
  if (!node || typeof node !== 'object') return false;
  const obj = node as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, '@value')) return false;
  const context = Object.prototype.hasOwnProperty.call(obj, '@context')
    ? resolveJsonLdContext(inherited, obj['@context'])
    : inherited;
  if (schemaTypesInNode(obj, context).has('VideoObject')) {
    for (const [key, value] of Object.entries(obj)) {
      if (isSchemaPublicationProperty(key, context) &&
          isBroadcastPublication(value, context)) return true;
    }
  }
  return Object.entries(obj).some(
    ([key, value]) => key !== '@context' && hasEligibleVideoBroadcast(value, context),
  );
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
  // Match complete attribute names, not suffixes such as data-name or
  // name= text embedded in another quoted attribute value.
  const pattern = /(?:^|\s)([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'\x60=<>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(attributes)) !== null) {
    if (match[1].toLowerCase() === name.toLowerCase()) {
      // A valueless HTML boolean attribute is present, not absent.
      return match[2] ?? match[3] ?? match[4] ?? '';
    }
  }
  return undefined;
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

  // HTML Microdata only creates an item when itemscope is present. An
  // itemtype on its own is not an eligible schema.org entity.
  const itemType = htmlAttribute(attributes, 'itemscope') !== undefined
    ? htmlAttribute(attributes, 'itemtype')
    : undefined;
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
  const staticMarkup = stripInertHtml(html);
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

    // Google models a livestream as the publication of a VideoObject. Mere
    // nesting under an unrelated relationship does not establish eligibility.
    const relationTokens = [
      ...(htmlAttribute(attributes, 'itemprop') ?? '').split(/\s+/),
      ...(htmlAttribute(attributes, 'property') ?? '').split(/\s+/),
    ];
    const isPublication = relationTokens.some((token) =>
      token === 'publication' || /^https?:\/\/(?:www\.)?schema\.org\/publication\/?$/i.test(token));
    if (types.has('BroadcastEvent') && parent?.videoObjectInScope && isPublication) {
      return true;
    }
    // An anonymous Microdata item has its own scope even without itemtype.
    const videoObjectInScope = types.has('VideoObject') ||
      (types.size === 0 && htmlAttribute(attributes, 'itemscope') === undefined &&
        parent?.videoObjectInScope === true);

    const selfClosing = /\/\s*$/.test(attributes);
    if (!selfClosing && !VOID_HTML_TAGS.has(tag)) {
      stack.push({ tag, schemaVocabulary, videoObjectInScope });
    }
  }

  return false;
}

/**
 * Keep literal angle brackets inside attributes from becoming active markup.
 * Scan only actual start tags: script-like raw text and HTML comments can
 * contain arbitrary fake tags and must not affect later document parsing.
 */
function neutralizeQuotedAttributeAngles(html: string): string {
  const output = html.split('');
  const rawTextTags = new Set([
    'script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes',
  ]);
  const scanTagEnd = (from: number): number | undefined => {
    let quote = '';
    for (let cursor = from; cursor < html.length; cursor += 1) {
      const ch = html[cursor];
      if (quote) {
        if (ch === quote) quote = '';
        else if (ch === '<' || ch === '>') output[cursor] = ' ';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '<') {
        output[cursor] = ' ';
      } else if (ch === '>') {
        return cursor + 1;
      }
    }
    return undefined;
  };
  let index = 0;
  while (index < html.length) {
    const start = html.indexOf('<', index);
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    let cursor = start + 1;
    const closing = html[cursor] === '/';
    if (closing) cursor += 1;
    if (!/[a-z]/i.test(html[cursor] ?? '')) {
      index = start + 1;
      continue;
    }
    const nameStart = cursor;
    while (cursor < html.length && /[\w:-]/.test(html[cursor])) cursor += 1;
    const tag = html.slice(nameStart, cursor).toLowerCase();

    const tagEnd = scanTagEnd(cursor);
    index = tagEnd ?? html.length;
    if (tagEnd !== undefined && !closing && rawTextTags.has(tag)) {
      // HTML ignores attributes on raw-text end tags, including quoted '>'.
      // Normalize only the matching real closer, keeping the remaining text inert.
      const closingTag = new RegExp(`</${tag}(?=[\\s/>])`, 'gi');
      closingTag.lastIndex = tagEnd;
      const end = closingTag.exec(html);
      if (end) {
        const attributesStart = closingTag.lastIndex;
        const closeEnd = scanTagEnd(attributesStart);
        if (closeEnd !== undefined) {
          for (let i = attributesStart; i < closeEnd - 1; i += 1) output[i] = ' ';
          index = closeEnd;
        } else {
          index = html.length;
        }
      } else {
        // An unclosed raw-text element makes all remaining content inert.
        index = html.length;
      }
    }
  }
  return output.join('');
}

function stripHtmlComments(html: string): string {
  // Comment markers in raw-text/RCDATA elements are text, not HTML comments.
  // Consume those elements first so a literal "<!--" cannot hide later markup.
  return html.replace(
    /<(script|style|textarea|title|xmp|iframe|noembed|noframes)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<!--[\s\S]*?(?:-->|$)/gi,
    (token) => token.startsWith('<!--') ? '' : token,
  );
}

function stripTemplateContents(html: string): string {
  // An outer <template> stays inert after an inner template closes. Match
  // raw-text elements as units so literal template tags cannot affect depth.
  const tokens = /<(script|style|textarea|title|xmp|iframe|noembed|noframes)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<\/?template\b[^>]*>/gi;
  const visible: string[] = [];
  let depth = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(html)) !== null) {
    if (depth === 0) visible.push(html.slice(consumed, match.index));
    if (/^<\/template\b/i.test(match[0])) {
      if (depth > 0) depth -= 1;
      else visible.push(match[0]);
    } else if (/^<template\b/i.test(match[0])) {
      depth += 1;
    } else if (depth === 0) {
      visible.push(match[0]);
    }
    consumed = tokens.lastIndex;
  }
  // An unclosed template is not evidence of active structured data.
  if (depth === 0) visible.push(html.slice(consumed));
  return visible.join('');
}

function stripNonScriptRawTextContainers(html: string): string {
  // HTML parsers treat markup-looking text here as text, not active elements.
  // Keep scripts for the separate JSON-LD scan, but discard these samples.
  return html.replace(
    /<(textarea|title|xmp|iframe|noembed|noframes)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
    '',
  );
}

function stripInertHtml(html: string): string {
  return stripNonScriptRawTextContainers(stripTemplateContents(stripHtmlComments(html))).replace(
    /<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
    '',
  );
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

  // A script in a comment or inert template is not page structured data.
  const activeHtml = stripNonScriptRawTextContainers(stripTemplateContents(stripHtmlComments(neutralizeQuotedAttributeAngles(html))));
  const types = new Set<string>();
  let hasVideoBroadcast = false;
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(activeHtml)) !== null) {
    if (htmlAttribute(match[1], 'type')?.trim().toLowerCase() !== 'application/ld+json') {
      continue;
    }
    try {
      const parsed = JSON.parse(match[2]);
      collectSchemaTypes(parsed, types);
      if (hasEligibleVideoBroadcast(parsed)) hasVideoBroadcast = true;
    } catch {
      // Ignore malformed JSON-LD blocks and keep scanning the rest of the page.
    }
  }

  if (
    types.has('JobPosting') ||
    hasVideoBroadcast ||
    hasEligibleHtmlStructuredData(activeHtml)
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
  const head = /<head\b[^>]*>([\s\S]*?)(?:<\/head\s*>|<body\b|$)/i.exec(
    stripInertHtml(html),
  )?.[1];
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
    if (hasRobotsNoindexMeta(neutralizeQuotedAttributeAngles(html))) return { eligible: true };

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
    const text = await readBoundedGoogleError(resp);
    throw new Error(`${actionLabel} failed: ${resp.status} ${text}`);
  }
  const unverifiedReceipt = {
    receipt_status: 'unverified',
    provider_http_status: resp.status,
    note: 'Google returned HTTP success but the Indexing notification receipt was malformed or unreadable. Verify notification metadata before considering a new submission.',
  };
  let receipt: unknown;
  try {
    receipt = await readBoundedGoogleSuccessJson(resp);
  } catch (error) {
    if (!(error instanceof SyntaxError) &&
        !(error instanceof Error && error.message.endsWith('body is empty.'))) {
      // Preserve established byte-limit and transport error handling.
      throw error;
    }
    // Even a truncated or invalid HTTP-success receipt must not imply that the
    // already-accepted publish request is safe to resubmit automatically.
    return unverifiedReceipt;
  }
  const root = asUnknownRecord(receipt);
  const metadata = asUnknownRecord(root?.urlNotificationMetadata);
  // Preserve the direct UrlNotification shape accepted by existing clients.
  const directNotification = root &&
    typeof root.url === 'string' && root.url.trim().length > 0 &&
    typeof root.type === 'string' && root.type.trim().length > 0 &&
    (root.notifyTime == null || typeof root.notifyTime === 'string');
  if (directNotification) return receipt;
  if (metadata &&
      (metadata.url == null || typeof metadata.url === 'string') &&
      isOptionalIndexingNotification(metadata.latestUpdate) &&
      isOptionalIndexingNotification(metadata.latestRemove)) {
    return receipt;
  }
  // The POST already received HTTP success. Do not imply that it failed and
  // invite a duplicate write merely because Google's receipt is malformed.
  return unverifiedReceipt;
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

function isOptionalIndexingNotification(value: unknown): boolean {
  if (value == null) return true;
  const notification = asUnknownRecord(value);
  return !!notification && ['url', 'type', 'notifyTime'].every((field) =>
    notification[field] == null || typeof notification[field] === 'string');
}

export async function getIndexingNotificationMetadata(
  accessToken: string,
  url: string,
  beforeRetry?: () => Promise<void>,
): Promise<IndexingNotificationMetadata> {
  const endpoint = new URL(
    'https://indexing.googleapis.com/v3/urlNotifications/metadata',
  );
  endpoint.searchParams.set('url', url);

  const resp = await fetchGoogleRead(endpoint.toString(), {
    headers: { authorization: `Bearer ${accessToken}` },
  }, beforeRetry);
  if (resp.status === 401) {
    throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
  }
  if (!resp.ok) {
    const text = await readBoundedGoogleError(resp);
    throw new Error(
      `Get indexing notification status failed: ${resp.status} ${text}`,
    );
  }
  const data: unknown = await readBoundedGoogleSuccessJson(resp);
  const metadata = asUnknownRecord(data);
  if (!metadata ||
      (metadata.url != null && typeof metadata.url !== 'string') ||
      !isOptionalIndexingNotification(metadata.latestUpdate) ||
      !isOptionalIndexingNotification(metadata.latestRemove)) {
    throw new Error('Google Indexing metadata response contains invalid notification data.');
  }
  return data as IndexingNotificationMetadata;
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



