export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

export const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/webmasters.readonly',
];

export function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
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
  'Google access revoked. Please reconnect this connector in Claude.ai.';

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
    throw new Error(`Token exchange failed: ${resp.status}`);
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
  dataState?: DataState;
  type?: SearchType;
  aggregationType?: AggregationType;
  dimensionFilterGroups?: DimensionFilterGroup[];
}

export interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
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
  lastSubmitted?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  lastDownloaded?: string;
  warnings?: string;
  errors?: string;
  contents?: Array<{
    type: string;
    submitted: string;
    indexed: string;
  }>;
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
  return data.sitemap ?? [];
}

export async function querySearchAnalytics(
  accessToken: string,
  siteUrl: string,
  body: SearchAnalyticsQuery,
): Promise<SearchAnalyticsRow[]> {
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
  const data = (await resp.json()) as { rows?: SearchAnalyticsRow[] };
  return data.rows ?? [];
}
