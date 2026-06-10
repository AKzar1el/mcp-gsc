import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import pkg from '../package.json';
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchGoogleUserInfo,
  GoogleRefreshTokenRevokedError,
  GSC_ACCESS_REVOKED_MESSAGE,
  inspectUrl,
  listSitemaps,
  listSites,
  querySearchAnalytics,
  refreshAccessToken,
} from './google';
import {
  deleteUser,
  getDecryptedRefreshToken,
  popPendingAuth,
  saveUser,
  stashPendingAuth,
} from './storage';

export interface Env {
  OAUTH_KV: KVNamespace;
  USER_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_PROVIDER: any;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
}

interface AgentProps extends Record<string, unknown> {
  google_id: string;
  email: string;
}

const SERVER_NAME = 'mcp-gsc';
const SERVER_VERSION = pkg.version;

const NOT_AUTHENTICATED_MESSAGE =
  'Not authenticated. Please reconnect this server in your MCP client (e.g. Claude.ai → Settings → Connectors).';

// Every tool talks to the Google Search Console API and never writes anything.
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: true,
} as const;

const SITE_URL_DESCRIPTION =
  "The Search Console property identifier, exactly as returned by list_sites. Two formats exist: domain properties use 'sc-domain:example.com'; URL-prefix properties use the full URL including protocol and trailing slash, e.g. 'https://www.example.com/'. Passing the wrong format returns a permission error even when the user owns the site — call list_sites first if unsure.";

// One-line summaries surfaced by get_capabilities. Keep in sync with the
// registerTool calls below (names are asserted by the smoke tests).
const TOOL_CATALOG = [
  {
    name: 'list_sites',
    description:
      'List the Google Search Console properties (sites) the connected Google account can access.',
  },
  {
    name: 'query_search_analytics',
    description:
      'Query Search Console search analytics (impressions, clicks, CTR, average position) over a date range, broken down by query, page, country, device, date, or search appearance. Supports filters and pagination.',
  },
  {
    name: 'inspect_url',
    description:
      "Inspect a single URL's index status in Google: indexed state, last crawl, mobile usability, and rich-results eligibility.",
  },
  {
    name: 'list_sitemaps',
    description:
      'List all sitemaps submitted for a property, with submission/processing status and warning and error counts.',
  },
  {
    name: 'get_capabilities',
    description:
      "List every tool this server exposes and report whether the user's Google Search Console connection is currently authenticated.",
  },
] as const;

export class GscMcpAgent extends McpAgent<Env, unknown, AgentProps> {
  server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  private accessTokenCache = new Map<
    string,
    { token: string; expires_at: number }
  >();

  private requireGoogleId(): string {
    const googleId = this.props?.google_id;
    if (!googleId) {
      throw new Error(NOT_AUTHENTICATED_MESSAGE);
    }
    return googleId;
  }

  private async getAccessToken(googleId: string): Promise<string> {
    const now = Date.now();
    const cached = this.accessTokenCache.get(googleId);
    if (cached && cached.expires_at > now + 60_000) {
      return cached.token;
    }
    const refreshToken = await getDecryptedRefreshToken(this.env, googleId);
    if (!refreshToken) {
      console.warn('No refresh token record for user', { google_id: googleId });
      throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
    }
    let tokens;
    try {
      tokens = await refreshAccessToken(
        refreshToken,
        this.env.GOOGLE_CLIENT_ID,
        this.env.GOOGLE_CLIENT_SECRET,
      );
    } catch (err) {
      if (err instanceof GoogleRefreshTokenRevokedError) {
        this.accessTokenCache.delete(googleId);
        await deleteUser(this.env, googleId);
        console.warn('Refresh token revoked, deleted user record', {
          google_id: googleId,
        });
      }
      throw err;
    }
    this.accessTokenCache.set(googleId, {
      token: tokens.access_token,
      expires_at: now + tokens.expires_in * 1000,
    });
    return tokens.access_token;
  }

  async init() {
    this.server.registerTool(
      'get_capabilities',
      {
        title: 'Get server capabilities and auth status',
        description:
          "List every tool this server exposes and report whether the user's Google Search Console connection is currently authenticated. Call this first if you're unsure what tools are available or whether the user is connected. Returns the tool catalog plus an auth status of `connected` or `not_connected`. Takes no arguments.",
        inputSchema: {},
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async () => {
        let authStatus: 'connected' | 'not_connected' | 'unknown';
        try {
          const googleId = this.props?.google_id;
          if (!googleId) {
            authStatus = 'not_connected';
          } else {
            const refreshToken = await getDecryptedRefreshToken(
              this.env,
              googleId,
            );
            authStatus = refreshToken ? 'connected' : 'not_connected';
          }
        } catch {
          authStatus = 'unknown';
        }
        const capabilities = {
          server: SERVER_NAME,
          version: SERVER_VERSION,
          auth_status: authStatus,
          tools: TOOL_CATALOG,
          hint: "If auth_status is not 'connected', the user should reconnect this server in their MCP client to sign in with Google.",
        };
        return {
          content: [
            { type: 'text', text: JSON.stringify(capabilities, null, 2) },
          ],
        };
      },
    );

    this.server.registerTool(
      'list_sites',
      {
        title: 'List Search Console properties',
        description:
          "List the Google Search Console properties (sites) the connected Google account has access to. Returns an array of { siteUrl, permissionLevel }. Call this when the user asks 'what sites do I have?' or 'what properties are connected?', or when the user asks about SEO for a site and hasn't specified which property. Also useful as a discovery step before calling other tools that require a site_url argument.",
        inputSchema: {},
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async () => {
        const googleId = this.requireGoogleId();
        const accessToken = await this.getAccessToken(googleId);
        const sites = await listSites(accessToken);
        return {
          content: [
            { type: 'text', text: JSON.stringify(sites, null, 2) },
          ],
        };
      },
    );

    this.server.registerTool(
      'inspect_url',
      {
        title: 'Inspect URL index status',
        description: `Inspect a single URL's index status in Google. Returns: whether the URL is indexed, last crawl date, indexing state, mobile usability, rich-results eligibility, and any AMP results. Use this when the user asks 'is X indexed?', 'why isn't X showing in Google?', or wants a deep look at one specific page. For bulk checks across many URLs, call this tool repeatedly — there is no batch endpoint — but note Google caps URL inspection at roughly 2,000 calls per property per day.`,
        inputSchema: {
          site_url: z.string().describe(SITE_URL_DESCRIPTION),
          inspection_url: z
            .string()
            .describe(
              'The fully-qualified URL to inspect. Must belong to the site_url property: same domain for sc-domain properties, same URL prefix for URL-prefix properties.',
            ),
          language_code: z
            .string()
            .default('en-US')
            .describe(
              "BCP-47 language code for translatable strings in the result, e.g. 'en-US' or 'de-DE'.",
            ),
        },
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, inspection_url, language_code }) => {
        const googleId = this.requireGoogleId();
        const accessToken = await this.getAccessToken(googleId);
        const result = await inspectUrl(
          accessToken,
          site_url,
          inspection_url,
          language_code,
        );
        return {
          content: [
            { type: 'text', text: JSON.stringify(result, null, 2) },
          ],
        };
      },
    );

    this.server.registerTool(
      'list_sitemaps',
      {
        title: 'List submitted sitemaps',
        description:
          'List all sitemaps submitted for a Search Console property. Returns sitemap URLs, last submitted/downloaded dates, indexed URL counts, warning and error counts, and sitemap status. Use this when the user asks about sitemap health, submission status, or wants to audit which sitemaps are working.',
        inputSchema: {
          site_url: z.string().describe(SITE_URL_DESCRIPTION),
        },
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url }) => {
        const googleId = this.requireGoogleId();
        const accessToken = await this.getAccessToken(googleId);
        const sitemaps = await listSitemaps(accessToken, site_url);
        return {
          content: [
            { type: 'text', text: JSON.stringify(sitemaps, null, 2) },
          ],
        };
      },
    );

    this.server.registerTool(
      'query_search_analytics',
      {
        title: 'Query search analytics',
        description: [
          'Query Google Search Console search analytics data. Returns',
          '{ row_count, start_row, rows } where each row has keys (dimension',
          'values), clicks, impressions, ctr, and position. When row_count',
          'equals row_limit, the response includes next_start_row — pass it',
          'back as start_row to fetch the next page.',
          '',
          'IMPORTANT BEHAVIORS — read before calling:',
          '- For SITE TOTALS (total impressions, total clicks, overall CTR,',
          '  overall average position), call with dimensions: []. This returns',
          '  a single row containing the true site-level totals. Do NOT call',
          '  with dimensions: ["query"] and sum the rows — Google omits',
          '  anonymized low-volume queries from per-dimension responses, so',
          '  summing per-query rows will undercount.',
          '- For TOP QUERIES / PAGES / COUNTRIES / DEVICES, call with the',
          '  matching dimension. Expect the returned rows to cover only a',
          '  subset of total impressions; this is normal Google behavior, not',
          '  a data error.',
          '- DATA FRESHNESS: Search Console data lags about 2-3 days behind',
          '  real time. If the user asks about "today" or "yesterday", expect',
          '  empty or partial rows for the most recent days; the latest',
          '  reliably-complete date is usually 3 days ago.',
          '- AVERAGE POSITION is impression-weighted. To compute an overall',
          '  position across multiple rows, use',
          '  sum(position * impressions) / sum(impressions). Never plain-average',
          '  the position column across rows.',
          '- CTR in the response is a 0–1 fraction. Multiply by 100 for percent.',
          '- Use search_type to query image/video/news/discover indexes',
          '  separately from web.',
          '- Use dimension_filter_groups to filter by country, device, query',
          '  content, page URL, or search feature. Filters with includingRegex',
          '  accept JavaScript regex syntax. For brand vs non-brand splits,',
          "  pass a single regex filter on the 'query' dimension.",
          "- data_state defaults to 'all' which matches the GSC dashboard.",
          "  Pass 'final' only when the user explicitly asks for stable,",
          '  non-preliminary data.',
        ].join('\n'),
        inputSchema: {
          site_url: z.string().describe(SITE_URL_DESCRIPTION),
          start_date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD format')
            .describe('Start date (inclusive) in YYYY-MM-DD format.'),
          end_date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD format')
            .describe(
              'End date (inclusive) in YYYY-MM-DD format. Note the 2-3 day data lag: the most recent complete date is usually 3 days ago.',
            ),
          dimensions: z
            .array(
              z.enum([
                'query',
                'page',
                'country',
                'device',
                'date',
                'searchAppearance',
              ]),
            )
            .default(['query'])
            .describe(
              'Dimensions to group rows by. Pass [] (empty array) to get a single row of true site-level totals.',
            ),
          row_limit: z
            .number()
            .int()
            .min(1)
            .max(25000)
            .default(100)
            .describe(
              'Maximum rows to return (1-25000). Defaults to 100, which is plenty for most questions; raise it only for bulk exports and page through with start_row.',
            ),
          start_row: z
            .number()
            .int()
            .min(0)
            .default(0)
            .describe(
              'Zero-based row offset for pagination. When a response contains next_start_row, pass it here to fetch the next page.',
            ),
          data_state: z
            .enum(['all', 'final'])
            .default('all')
            .describe(
              "'all' includes fresh (preliminary) data and matches the GSC dashboard; 'final' returns only finalized data.",
            ),
          search_type: z
            .enum(['web', 'image', 'video', 'news', 'discover', 'googleNews'])
            .default('web')
            .describe('Which search index to query. Defaults to web.'),
          aggregation_type: z
            .enum(['auto', 'byPage', 'byProperty'])
            .default('auto')
            .describe(
              "How Google aggregates metrics. Leave as 'auto' unless you specifically need byPage or byProperty semantics.",
            ),
          dimension_filter_groups: z
            .array(
              z.object({
                groupType: z.literal('and').default('and'),
                filters: z.array(
                  z.object({
                    dimension: z.enum([
                      'query',
                      'page',
                      'country',
                      'device',
                      'searchAppearance',
                    ]),
                    operator: z.enum([
                      'equals',
                      'notEquals',
                      'contains',
                      'notContains',
                      'includingRegex',
                      'excludingRegex',
                    ]),
                    expression: z.string(),
                  }),
                ),
              }),
            )
            .optional()
            .describe(
              "Optional filters ANDed together, e.g. [{ groupType: 'and', filters: [{ dimension: 'country', operator: 'equals', expression: 'usa' }] }]. Countries use ISO 3166-1 alpha-3 codes.",
            ),
        },
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({
        site_url,
        start_date,
        end_date,
        dimensions,
        row_limit,
        start_row,
        data_state,
        search_type,
        aggregation_type,
        dimension_filter_groups,
      }) => {
        const googleId = this.requireGoogleId();
        const accessToken = await this.getAccessToken(googleId);
        const rows = await querySearchAnalytics(accessToken, site_url, {
          startDate: start_date,
          endDate: end_date,
          dimensions,
          rowLimit: row_limit,
          startRow: start_row,
          dataState: data_state,
          type: search_type,
          aggregationType: aggregation_type,
          ...(dimension_filter_groups !== undefined
            ? { dimensionFilterGroups: dimension_filter_groups }
            : {}),
        });
        const payload: Record<string, unknown> = {
          row_count: rows.length,
          start_row,
          rows,
        };
        if (rows.length === row_limit) {
          payload.next_start_row = start_row + row_limit;
        }
        // Compact JSON on purpose: analytics responses are the largest this
        // server produces, and pretty-printing them costs ~3x the tokens.
        return {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
        };
      },
    );
  }
}

function googleRedirectUri(request: Request): string {
  return new URL('/google/callback', request.url).toString();
}

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      if (request.method !== 'GET') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: { Allow: 'GET' },
        });
      }
      return new Response(
        'mcp-gsc — Hosted MCP server for Google Search Console.\n' +
          'Connect this URL as a custom MCP connector in Claude.ai:\n' +
          `${url.origin}/mcp\n`,
        { headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }

    if (url.pathname === '/healthz' && request.method === 'GET') {
      return new Response('ok', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    if (url.pathname === '/authorize') {
      let claudeAuthRequest;
      try {
        claudeAuthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      } catch (err) {
        console.warn('Invalid /authorize request', {
          message: (err as Error).message,
        });
        return new Response(
          'Invalid OAuth authorization request. This endpoint is called by MCP clients during the connection flow, not directly in a browser.',
          {
            status: 400,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          },
        );
      }
      const nonce = crypto.randomUUID();
      await stashPendingAuth(env, nonce, claudeAuthRequest);
      const redirectUri = googleRedirectUri(request);
      const googleUrl = buildAuthUrl(env.GOOGLE_CLIENT_ID, redirectUri, nonce);
      return Response.redirect(googleUrl, 302);
    }

    if (url.pathname === '/google/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const googleError = url.searchParams.get('error');

      if (googleError) {
        console.error('Google OAuth returned error', { error: googleError });
        return new Response(`Google OAuth error: ${googleError}`, {
          status: 400,
        });
      }

      if (!code || !state) {
        console.error('Missing code or state on /google/callback', {
          has_code: !!code,
          has_state: !!state,
        });
        return new Response('Missing code or state', { status: 400 });
      }

      const pending = await popPendingAuth(env, state);
      if (!pending) {
        console.error('Pending auth not found or expired', { state });
        return new Response('Auth request expired or invalid', { status: 400 });
      }

      const redirectUri = googleRedirectUri(request);

      let tokens;
      try {
        tokens = await exchangeCodeForTokens(
          code,
          env.GOOGLE_CLIENT_ID,
          env.GOOGLE_CLIENT_SECRET,
          redirectUri,
        );
      } catch (err) {
        console.error('Token exchange failed', {
          message: (err as Error).message,
        });
        return new Response('Token exchange failed', { status: 500 });
      }

      let userinfo;
      try {
        userinfo = await fetchGoogleUserInfo(tokens.access_token);
      } catch (err) {
        console.error('Userinfo fetch failed', {
          message: (err as Error).message,
        });
        return new Response('Userinfo fetch failed', { status: 500 });
      }

      try {
        await saveUser(env, userinfo.id, userinfo.email, tokens.refresh_token);
      } catch (err) {
        console.error('Save user failed', {
          google_id: userinfo.id,
          message: (err as Error).message,
        });
        return new Response('Save user failed', { status: 500 });
      }

      const claudeAuthReq = pending.claudeAuthRequest as any;
      let redirectTo: string;
      try {
        ({ redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: claudeAuthReq,
          userId: userinfo.id,
          metadata: { email: userinfo.email },
          scope: claudeAuthReq.scope,
          props: { google_id: userinfo.id, email: userinfo.email },
        }));
      } catch (err) {
        console.error('completeAuthorization failed', {
          google_id: userinfo.id,
          message: (err as Error).message,
        });
        return new Response('Failed to complete authorization', {
          status: 500,
        });
      }
      return Response.redirect(redirectTo, 302);
    }

    return new Response('Not found', { status: 404 });
  },
};

export default new OAuthProvider({
  apiHandlers: {
    '/mcp': GscMcpAgent.serve('/mcp'),
  },
  defaultHandler: defaultHandler as any,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
});
