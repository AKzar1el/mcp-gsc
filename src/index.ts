import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { DurableObject } from 'cloudflare:workers';
import { createMcpHandler, getMcpAuthContext } from 'agents/mcp/server';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import pkg from '../package.json';
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchGoogleUserInfo,
  GoogleRefreshTokenRevokedError,
  GSC_ACCESS_REVOKED_MESSAGE,
  MCP_RECONNECT_INSTRUCTION,
  inspectUrl,
  inspectUrlsSequentially,
  listSitemaps,
  listSites,
  getSite,
  querySearchAnalytics,
  querySearchAnalyticsPaginated,
  addSite,
  deleteSite,
  submitSitemap,
  deleteSitemap,
  getSitemap,
  processQuickWins,
  processCannibalization,
  processContentDecay,
  requestIndexing,
  processPerformanceComparison,
  type PaginatedSearchAnalyticsResult,
} from './google';
import {
  getDecryptedRefreshToken,
  saveUser,
} from './storage';
import { GoogleAccessTokenLifecycle } from './access-token-lifecycle';
import {
  consumePendingAuth,
  PendingAuthStateStore,
  stashPendingAuth,
} from './pending-auth-state';
import { enforceToolRateLimit, type RateLimitedToolName } from './tool-rate-limit';
export { ToolRateLimiter } from './tool-rate-limiter-do';
import { generateWeeklyDigest, resolveWeeklyDigestEndDate } from './digest';
import {
  CANNIBALIZATION_MIN_IMPRESSIONS_SCHEMA,
  CANNIBALIZATION_MIN_PAGE_PERCENTAGE_SCHEMA,
} from './cannibalization-schema';
import {
  assertDateNotInFuture,
  assertDateRange,
  getSearchConsoleCalendarDate,
  SEARCH_CONSOLE_DATE_SCHEMA,
} from './date-validation';
import { CONTENT_DECAY_COMPARE_DAYS_SCHEMA } from './content-decay-schema';
import { resolveIndexedPagesDateRange } from './indexed-pages-range';
import { createQuickWinsInputSchema } from './quick-wins-schema';
import { WRITE_TOOL_ANNOTATIONS } from './write-tool-annotations';
import {
  getToolCatalogForAccessMode,
  resolveGscAccessMode,
  type GscAccessMode,
} from './access-mode';
import {
  assertIndexingRequestUrl,
  assertIndexingUrlAuthorized,
} from './indexing-property-authorization';
import {
  DEFAULT_ANALYSIS_RESULT_LIMIT,
  MAX_ANALYSIS_RESULT_LIMIT,
  MAX_DIRECT_SOURCE_ROWS,
  resultPageMetadata,
  takeBoundedItems,
} from './result-bounds';

export interface Env {
  OAUTH_KV: KVNamespace;
  USER_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  PENDING_AUTH_STATE: DurableObjectNamespace;
  TOOL_RATE_LIMITER: DurableObjectNamespace;
  OAUTH_PROVIDER: any;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  GSC_ACCESS_MODE?: string;
}

export interface AgentProps extends Record<string, unknown> {
  google_id: string;
  email: string;
}

const SERVER_NAME = 'mcp-gsc';
const SERVER_VERSION = pkg.version;

const NOT_AUTHENTICATED_MESSAGE =
  `Not authenticated. ${MCP_RECONNECT_INSTRUCTION}`;

// Annotation utilities for read-only vs write actions.
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: true,
} as const;

const SITE_URL_DESCRIPTION =
  "The Search Console property identifier, exactly as returned by sites.list. Two formats exist: domain properties use 'sc-domain:example.com'; URL-prefix properties use the full URL including protocol and trailing slash, e.g. 'https://www.example.com/'. Passing the wrong format returns a permission error even when the user owns the site — call sites.list first if unsure.";

const METRIC_OUTPUT_SCHEMA = {
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  position: z.number(),
};

const SEARCH_ROW_OUTPUT_SCHEMA = {
  keys: z
    .array(z.string())
    .optional()
    .describe(
      'Dimension values returned by Google. Aggregate queries with dimensions: [] may legitimately omit this field.',
    ),
  ...METRIC_OUTPUT_SCHEMA,
};

const SITE_OUTPUT_SCHEMA = {
  siteUrl: z.string(),
  permissionLevel: z.string(),
};

const SITEMAP_OUTPUT_SCHEMA = z
  .object({
    path: z.string(),
    lastSubmitted: z.string().nullable().optional(),
    isPending: z.boolean().nullable().optional(),
    isSitemapsIndex: z.boolean().nullable().optional(),
    type: z.string().nullable().optional(),
    lastDownloaded: z.string().nullable().optional(),
    warnings: z.string().nullable().optional(),
    errors: z.string().nullable().optional(),
    contents: z
      .array(
        z.object({
          type: z.string(),
          submitted: z.string(),
        }),
      )
      .nullable()
      .optional(),
  });

const CAPABILITIES_OUTPUT_SCHEMA = {
  server: z.string(),
  version: z.string(),
  access_mode: z.enum(['readonly', 'readwrite']),
  auth_status: z.enum(['connected', 'not_connected', 'unknown']),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
    }),
  ),
  hint: z.string(),
};

const SITES_OUTPUT_SCHEMA = {
  sites: z.array(z.object(SITE_OUTPUT_SCHEMA)),
};

const SITE_DETAIL_OUTPUT_SCHEMA = {
  site: z.object(SITE_OUTPUT_SCHEMA),
};

const INSPECTION_OUTPUT_SCHEMA = {
  inspection_result: z.unknown(),
};

const INSPECTION_BATCH_OUTPUT_SCHEMA = {
  requested_count: z.number().int().positive(),
  succeeded_count: z.number().int().nonnegative(),
  failed_count: z.number().int().nonnegative(),
  results: z.array(
    z.object({
      inspection_url: z.string(),
      inspection_result: z.unknown().optional(),
      error: z.string().optional(),
    }),
  ),
};

const SITEMAPS_OUTPUT_SCHEMA = {
  sitemaps: z.array(SITEMAP_OUTPUT_SCHEMA),
};

const SEARCH_ANALYTICS_OUTPUT_SCHEMA = {
  row_count: z.number().int().nonnegative(),
  start_row: z.number().int().nonnegative(),
  rows: z.array(z.object(SEARCH_ROW_OUTPUT_SCHEMA)),
  next_start_row: z.number().int().nonnegative().optional(),
  has_more: z.boolean(),
  truncated: z.boolean(),
  byte_limit_reached: z.boolean(),
  response_aggregation_type: z
    .string()
    .optional()
    .describe('Google response aggregation type, included only when returned by Google.'),
  metadata: z.object({
    first_incomplete_date: z
      .string()
      .optional()
      .describe('First incomplete date, included only when returned by Google.'),
    first_incomplete_hour: z
      .string()
      .optional()
      .describe('First incomplete hour, included only when returned by Google.'),
  })
    .optional()
    .describe('Google data-completeness metadata, included only when returned by Google.'),
};

const MESSAGE_OUTPUT_SCHEMA = {
  message: z.string(),
};

const SEARCH_ANALYTICS_PAGINATION_OUTPUT_SCHEMA = z.object({
  rows_fetched: z.number().int().nonnegative(),
  pages_fetched: z.number().int().positive(),
  local_limit_reached: z.boolean(),
});

const RESULT_PAGE_OUTPUT_SCHEMA = z.object({
  start_row: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  returned_count: z.number().int().nonnegative(),
  total_count: z.number().int().nonnegative().optional(),
  has_more: z.boolean(),
  truncated: z.boolean(),
  byte_limit_reached: z.boolean(),
  next_start_row: z.number().int().nonnegative().optional(),
});

const ANALYSIS_RESULT_LIMIT_SCHEMA = z
  .number()
  .int()
  .min(1)
  .max(MAX_ANALYSIS_RESULT_LIMIT)
  .default(DEFAULT_ANALYSIS_RESULT_LIMIT)
  .describe(
    `Maximum ranked results to return in this response (1-${MAX_ANALYSIS_RESULT_LIMIT}). Responses are also byte-bounded for MCP structured-content safety.`,
  );

const RESULT_START_ROW_SCHEMA = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe('Zero-based offset into the deterministically ranked result list.');

const QUICK_WIN_OUTPUT_SCHEMA = {
  note: z.string(),
  quick_wins: z.array(
    z.object({
      query: z.string(),
      page: z.string(),
      ...METRIC_OUTPUT_SCHEMA,
    }),
  ),
  pagination: SEARCH_ANALYTICS_PAGINATION_OUTPUT_SCHEMA,
  result_page: RESULT_PAGE_OUTPUT_SCHEMA,
};

const PAGE_QUERIES_OUTPUT_SCHEMA = {
  page: z.string(),
  queries: z.array(
    z.object({
      query: z.string(),
      ...METRIC_OUTPUT_SCHEMA,
    }),
  ),
  pagination: SEARCH_ANALYTICS_PAGINATION_OUTPUT_SCHEMA,
  result_page: RESULT_PAGE_OUTPUT_SCHEMA,
};

const QUERY_PAGES_OUTPUT_SCHEMA = {
  query: z.string(),
  pages: z.array(
    z.object({
      page: z.string(),
      ...METRIC_OUTPUT_SCHEMA,
    }),
  ),
  pagination: SEARCH_ANALYTICS_PAGINATION_OUTPUT_SCHEMA,
  result_page: RESULT_PAGE_OUTPUT_SCHEMA,
};

const CANNIBALIZATION_OUTPUT_SCHEMA = {
  candidates: z.array(
    z.object({
      query: z.string(),
      total_clicks: z.number().describe(
        'Sum of clicks across the observed query/page Search Analytics rows for this query. This is not a separately queried query-level aggregate.',
      ),
      total_impressions: z.number().describe(
        'Sum of impressions across the observed query/page Search Analytics rows for this query. This can exceed the query-level property aggregate when multiple pages appear for the same search, and it can be incomplete when source pagination is truncated.',
      ),
      aggregation_scope: z.literal('observed_query_page_rows').describe(
        'Makes explicit that total_clicks, total_impressions, and impression_share are calculated from observed query/page rows rather than true query-level Search Console totals.',
      ),
      page_count: z.number().int().nonnegative(),
      pages_truncated: z.boolean(),
      pages: z.array(
        z.object({
          page: z.string(),
          ...METRIC_OUTPUT_SCHEMA,
          impression_share: z.number().describe(
            'Percentage of the observed query/page impression sum represented by this page; not a share of unique searches or the true query-level property aggregate.',
          ),
        }),
      ),
    }),
  ),
  pagination: SEARCH_ANALYTICS_PAGINATION_OUTPUT_SCHEMA,
  result_page: RESULT_PAGE_OUTPUT_SCHEMA,
};

const CONTENT_DECAY_OUTPUT_SCHEMA = {
  comparison_periods: z.object({
    recent: z.object({ start: z.string(), end: z.string() }),
    previous: z.object({ start: z.string(), end: z.string() }),
  }),
  decay_count: z.number().int().nonnegative(),
  assessment_count: z.number().int().nonnegative(),
  decay_results: z.array(
    z.object({
      page: z.string(),
      classification: z.enum([
        'likely_decay',
        'weak_insufficient_evidence',
        'improving_visibility_with_click_volatility',
      ]),
      evidence: z.string(),
      previous_clicks: z.number(),
      recent_clicks: z.number(),
      click_difference: z.number(),
      click_decay_percentage: z.number(),
      previous_impressions: z.number(),
      recent_impressions: z.number(),
      impression_difference: z.number(),
      impression_change_percentage: z.number().nullable(),
      previous_position: z.number(),
      recent_position: z.number(),
      position_change: z.number().nullable(),
    }),
  ),
  pagination: z.object({
    recent: SEARCH_ANALYTICS_PAGINATION_OUTPUT_SCHEMA,
    previous: SEARCH_ANALYTICS_PAGINATION_OUTPUT_SCHEMA,
  }),
  result_page: RESULT_PAGE_OUTPUT_SCHEMA,
};

const INDEXING_OUTPUT_SCHEMA = {
  result: z.unknown(),
  note: z.string(),
};

const INDEXED_PAGES_OUTPUT_SCHEMA = {
  pages: z.array(z.object({ page: z.string(), ...METRIC_OUTPUT_SCHEMA })),
  note: z.string(),
  result_page: RESULT_PAGE_OUTPUT_SCHEMA,
};

const SEARCH_VISIBLE_PAGES_DESCRIPTION =
  'List pages that produced Search Console impressions in the requested period. This is performance data, not an index-coverage inventory: a URL can be indexed even when it is absent here, and Search Analytics can omit some page-level detail. Use urls.inspect or urls.inspect_many for URL-level index status.';

const SEARCH_VISIBLE_PAGES_NOTE =
  'These are Search Analytics performance rows for pages with recorded impressions in the requested period, not a complete list of indexed URLs. Absence does not mean a URL is unindexed. Use urls.inspect or urls.inspect_many for URL-level index status.';

const PERFORMANCE_COMPARISON_OUTPUT_SCHEMA = {
  comparisons: z.array(
    z.object({
      key: z.string(),
      period_a: z.object(METRIC_OUTPUT_SCHEMA),
      period_b: z.object(METRIC_OUTPUT_SCHEMA),
      diff: z.object({
        clicks: z.number(),
        clicks_percentage: z
          .number()
          .nullable()
          .describe('Percentage change from period_b clicks. Null when period_b is zero and period_a differs; zero when both are zero.'),
        impressions: z.number(),
        impressions_percentage: z
          .number()
          .nullable()
          .describe('Percentage change from period_b impressions. Null when period_b is zero and period_a differs; zero when both are zero.'),
        ctr: z.number(),
        position: z.number(),
      }),
    }),
  ),
  pagination: z.object({
    period_a: SEARCH_ANALYTICS_PAGINATION_OUTPUT_SCHEMA,
    period_b: SEARCH_ANALYTICS_PAGINATION_OUTPUT_SCHEMA,
  }),
  result_page: RESULT_PAGE_OUTPUT_SCHEMA,
};

const WEEKLY_DIGEST_OUTPUT_SCHEMA = {
  markdown: z.string(),
};

function toolResponse<T extends Record<string, unknown>>(
  text: string,
  structuredContent: T,
) {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent,
  };
}

function paginationMetadata(result: PaginatedSearchAnalyticsResult) {
  return {
    rows_fetched: result.rows.length,
    pages_fetched: result.pagesFetched,
    local_limit_reached: result.localLimitReached,
  };
}

function windowKnownResults<T>(
  items: readonly T[],
  startRow: number,
  limit: number,
) {
  const requested = items.slice(startRow, startRow + limit);
  const bounded = takeBoundedItems(requested, limit);
  const returnedCount = bounded.items.length;
  const hasMore =
    startRow + returnedCount < items.length || bounded.byteLimitReached;
  return {
    items: bounded.items,
    resultPage: resultPageMetadata({
      startRow,
      limit,
      returnedCount,
      totalCount: items.length,
      hasMore,
      byteLimitReached: bounded.byteLimitReached,
    }),
  };
}

function windowSourceRows<T>(
  items: readonly T[],
  sourceStartRow: number,
  requestedLimit: number,
  sourceMayHaveMore: boolean,
) {
  const bounded = takeBoundedItems(items, requestedLimit);
  const returnedCount = bounded.items.length;
  const hasMore =
    bounded.byteLimitReached ||
    returnedCount < items.length ||
    sourceMayHaveMore;
  return {
    items: bounded.items,
    resultPage: resultPageMetadata({
      startRow: sourceStartRow,
      limit: requestedLimit,
      returnedCount,
      hasMore,
      byteLimitReached: bounded.byteLimitReached,
    }),
  };
}

function toolError(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

// One-line summaries surfaced by get_capabilities. Keep in sync with the
// registerTool calls below (names are asserted by the smoke tests).
const TOOL_CATALOG = [
  {
    name: 'sites.list',
    description:
      'List the Google Search Console properties (sites) the connected Google account can access.',
  },
  {
    name: 'sites.get',
    description:
      'Get one exact Search Console property and the connected account\'s permission level for it.',
  },
  {
    name: 'sites.add',
    description:
      'Add a new website property to your Google Search Console account.',
  },
  {
    name: 'sites.delete',
    description:
      'Remove an existing website property from your Google Search Console account.',
  },
  {
    name: 'analytics.query',
    description:
      'Query Search Console search analytics (impressions, clicks, CTR, average position) over a date range, broken down by query, page, country, device, date, or search appearance. Supports filters and pagination.',
  },
  {
    name: 'insights.page_queries',
    description:
      'For one exact page URL, list the Search Console queries that produced impressions for it, with clicks, impressions, CTR, average position, search type, and bounded pagination.',
  },
  {
    name: 'insights.query_pages',
    description:
      'For one exact search query, list the site pages that received impressions for it, with clicks, impressions, CTR, average position, search type, and bounded pagination.',
  },
  {
    name: 'urls.inspect',
    description:
      "Inspect a single URL's index status in Google: indexed state, last crawl, mobile usability, and rich-results eligibility. Use urls.inspect_many for 2-10 URLs.",
  },
  {
    name: 'urls.inspect_many',
    description:
      'Inspect up to 10 URLs sequentially in one MCP call while charging the same URL Inspection safety budget per URL.',
  },
  {
    name: 'sitemaps.list',
    description:
      'List all sitemaps submitted for a property, with submission/processing status, submitted URL counts, and warning/error counts. Google\'s deprecated sitemap indexed count is intentionally omitted.',
  },
  {
    name: 'sitemaps.submit',
    description:
      'Submit a new sitemap to your Google Search Console account.',
  },
  {
    name: 'sitemaps.delete',
    description:
      'Remove/delete a submitted sitemap from your Google Search Console account.',
  },
  {
    name: 'sitemaps.get',
    description:
      'Get status and details of a single sitemap submitted to Google Search Console.',
  },
  {
    name: 'insights.quick_wins',
    description:
      'Find observed query/page Search Analytics rows with at least the requested impressions whose average position falls in a configurable opportunity range (8-20 by default). Average position is an aggregate metric, not a literal current rank; CTR is context, not an eligibility filter.',
  },
  {
    name: 'insights.cannibalization',
    description:
      'Analyze query/page Search Analytics for queries surfaced by multiple pages. Candidate totals and impression shares are explicitly scoped to observed query/page rows, not true query-level property totals.',
  },
  {
    name: 'insights.content_decay',
    description:
      'Assess page-level click declines across two contiguous periods and distinguish likely decay from weak evidence or improving visibility with click volatility.',
  },
  {
    name: 'indexing.request',
    description:
      'Request Google to index or update a URL using the Google Indexing API.',
  },
  {
    name: 'indexing.list_pages',
    description: SEARCH_VISIBLE_PAGES_DESCRIPTION,
  },
  {
    name: 'analytics.compare',
    description:
      'Compare Search Console performance metrics (clicks, impressions, CTR, average position) between two distinct date ranges (Period A vs Period B) for a selected dimension.',
  },
  {
    name: 'reports.weekly_digest',
    description:
      'Generate a plain-language weekly SEO report for one Google Search Console property.',
  },
  {
    name: 'server.capabilities',
    description:
      "List every tool this server exposes and report whether the user's Google Search Console connection is currently authenticated.",
  },
] as const;

class GscMcpRuntime {
  server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  constructor(
    private readonly env: Env,
    private readonly props?: AgentProps,
    private readonly accessTokens = getSharedAccessTokenLifecycle(env),
  ) {}

  private requireGoogleId(): string {
    const googleId = this.props?.google_id;
    if (!googleId) {
      throw new Error(NOT_AUTHENTICATED_MESSAGE);
    }
    return googleId;
  }

  private async rateLimitError(
    googleId: string,
    toolName: RateLimitedToolName,
    units = 1,
  ) {
    const result = await enforceToolRateLimit(this.env, googleId, toolName, units);
    if (result.allowed) return null;

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((result.retry_after_ms ?? 0) / 1000),
    );
    return toolError(
      `Rate limit reached for ${toolName}. Retry after ${retryAfterSeconds} seconds.`,
    );
  }

  private async getAccessToken(googleId: string): Promise<string> {
    return this.getAccessTokenLifecycle().getAccessToken(googleId);
  }

  private getAccessTokenLifecycle(): GoogleAccessTokenLifecycle {
    return this.accessTokens;
  }

  async init() {
    const accessMode = resolveGscAccessMode(this.env.GSC_ACCESS_MODE);

    this.server.registerTool(
      'server.capabilities',
      {
        title: 'Get server capabilities and auth status',
        description:
          "List every tool this server exposes, its configured access mode, and whether the user's Google Search Console connection is currently authenticated. Call this first if you're unsure what tools are available, whether the deployment is read-only, or whether the user is connected. Returns the tool catalog plus an access mode and auth status. Takes no arguments.",
        inputSchema: {},
        outputSchema: CAPABILITIES_OUTPUT_SCHEMA,
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
          access_mode: accessMode,
          auth_status: authStatus,
          tools: getToolCatalogForAccessMode(TOOL_CATALOG, accessMode),
          hint: "If auth_status is not 'connected', the user should reconnect this server in their MCP client to sign in with Google.",
        };
        return toolResponse(JSON.stringify(capabilities, null, 2), capabilities);
      },
    );

    this.server.registerTool(
      'sites.list',
      {
        title: 'List Search Console properties',
        description:
          "List the Google Search Console properties (sites) the connected Google account has access to. Returns an array of { siteUrl, permissionLevel }. Call this when the user asks 'what sites do I have?' or 'what properties are connected?', or when the user asks about SEO for a site and hasn't specified which property. Also useful as a discovery step before calling other tools that require a site_url argument.",
        inputSchema: {},
        outputSchema: SITES_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async () => {
        const googleId = this.requireGoogleId();
        const accessToken = await this.getAccessToken(googleId);
        const sites = await listSites(accessToken);
        return toolResponse(JSON.stringify(sites, null, 2), { sites });
      },
    );

    this.server.registerTool(
      'sites.get',
      {
        title: 'Get Search Console property',
        description:
          "Retrieve one exact Google Search Console property and the connected account's permission level for it. Use this when the user has already named a property and you need to confirm that exact property or its access level without listing every property first.",
        inputSchema: {
          site_url: z.string().describe(SITE_URL_DESCRIPTION),
        },
        outputSchema: SITE_DETAIL_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url }) => {
        const googleId = this.requireGoogleId();
        const accessToken = await this.getAccessToken(googleId);
        const site = await getSite(accessToken, site_url);
        return toolResponse(JSON.stringify(site, null, 2), { site });
      },
    );

    this.server.registerTool(
      'urls.inspect',
      {
        title: 'Inspect URL index status',
        description: `Inspect a single URL's index status in Google. Returns: whether the URL is indexed, last crawl date, indexing state, mobile usability, rich-results eligibility, and any AMP results. Use this when the user asks 'is X indexed?', 'why isn't X showing in Google?', or wants a deep look at one specific page. For a bounded group of 2-10 URLs, prefer urls.inspect_many; Google still processes one URL Inspection request per URL and applies the same quota semantics.`,
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
        outputSchema: INSPECTION_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, inspection_url, language_code }) => {
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'urls.inspect');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        const result = await inspectUrl(
          accessToken,
          site_url,
          inspection_url,
          language_code,
        );
        return toolResponse(JSON.stringify(result, null, 2), {
          inspection_result: result,
        });
      },
    );

    this.server.registerTool(
      'urls.inspect_many',
      {
        title: 'Inspect multiple URLs',
        description: `Inspect up to 10 URLs from one Search Console property in a single MCP call. Google still processes one URL Inspection request per URL, so every requested URL consumes one quota unit and one unit of this server's shared URL-inspection safety budget. Requests are sent sequentially to avoid unnecessary bursts. Use this for a small group of important, recently changed, or debugging-target URLs; do not use it to crawl an entire site.`,
        inputSchema: {
          site_url: z.string().describe(SITE_URL_DESCRIPTION),
          inspection_urls: z
            .array(z.string().url())
            .min(1)
            .max(10)
            .describe(
              'Between 1 and 10 fully-qualified URLs to inspect. Each URL must belong to the site_url property.',
            ),
          language_code: z
            .string()
            .default('en-US')
            .describe(
              "BCP-47 language code for translatable strings in the results, e.g. 'en-US' or 'de-DE'.",
            ),
        },
        outputSchema: INSPECTION_BATCH_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, inspection_urls, language_code }) => {
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(
          googleId,
          'urls.inspect_many',
          inspection_urls.length,
        );
        if (rateLimitError) return rateLimitError;

        const accessToken = await this.getAccessToken(googleId);
        const batchResults = await inspectUrlsSequentially(
          accessToken,
          site_url,
          inspection_urls,
          language_code,
        );
        const results = batchResults.map((result) => ({
          inspection_url: result.inspectionUrl,
          ...(result.inspectionResult !== undefined
            ? { inspection_result: result.inspectionResult }
            : {}),
          ...(result.error !== undefined ? { error: result.error } : {}),
        }));

        const succeededCount = results.filter(
          (result) => result.inspection_result !== undefined,
        ).length;
        const payload = {
          requested_count: inspection_urls.length,
          succeeded_count: succeededCount,
          failed_count: results.length - succeededCount,
          results,
        };
        return toolResponse(JSON.stringify(payload, null, 2), payload);
      },
    );

    this.server.registerTool(
      'sitemaps.list',
      {
        title: 'List submitted sitemaps',
        description:
          'List sitemaps submitted for a Search Console property. Optionally filter to entries included by one sitemap index. Returns sitemap URLs, last submitted/downloaded dates, submitted URL counts, warning and error counts, and sitemap status. Google\'s deprecated sitemap indexed count is intentionally omitted. Use this when the user asks about sitemap health, submission status, wants to audit which sitemaps are working, or needs the child sitemaps belonging to a specific sitemap index.',
        inputSchema: {
          site_url: z.string().describe(SITE_URL_DESCRIPTION),
          sitemap_index: z
            .string()
            .url()
            .optional()
            .describe(
              'Optional sitemap index URL. When supplied, Google returns sitemap entries included in that index.',
            ),
        },
        outputSchema: SITEMAPS_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, sitemap_index }) => {
        const googleId = this.requireGoogleId();
        const accessToken = await this.getAccessToken(googleId);
        const sitemaps = await listSitemaps(accessToken, site_url, sitemap_index);
        return toolResponse(JSON.stringify(sitemaps, null, 2), { sitemaps });
      },
    );

    this.server.registerTool(
      'analytics.query',
      {
        title: 'Query search analytics',
        description: [
          'Query Google Search Console search analytics data. Returns',
          '{ row_count, start_row, rows, has_more, truncated, byte_limit_reached }',
          'where dimensioned rows have keys plus clicks, impressions, ctr, and',
          'position. Aggregate rows from dimensions: [] may omit keys because',
          'Google itself omits that field. When has_more is true, the response',
          'includes next_start_row — pass it back as start_row to fetch the next',
          'safe page. Large requested row_limit values are automatically split',
          'into bounded MCP responses rather than failing structured output.',
          'When Google provides',
          'them, response_aggregation_type and metadata are also included;',
          'metadata may identify the first incomplete date or hour.',
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
          '- Google Discover does not support query grouping/filtering or',
          '  average position. For Discover, use page/country/device/date/',
          '  searchAppearance dimensions and interpret clicks, impressions,',
          '  and CTR; query dimensions/filters are rejected before the API call.',
          '- News Showcase panel reporting: set aggregation_type to',
          '  "byNewsShowcasePanel", use search_type "discover" or',
          '  "googleNews", and include a searchAppearance equals',
          '  "NEWS_SHOWCASE" filter. Do not group/filter by page or add',
          '  another searchAppearance filter for that aggregation mode.',
          '- For hourly breakdowns, include "hour" in dimensions and set',
          '  data_state to "hourly_all". Hourly data is preliminary.',
          '- Use dimension_filter_groups to filter by country, device, query',
          '  content, page URL, or search feature. includingRegex and',
          '  excludingRegex use RE2 syntax. For brand vs non-brand splits,',
          "  pass a single regex filter on the 'query' dimension.",
          "- data_state defaults to 'all' which matches the GSC dashboard.",
          "  Pass 'final' only when the user explicitly asks for stable,",
          '  non-preliminary data.',
        ].join('\n'),
        inputSchema: {
          site_url: z.string().describe(SITE_URL_DESCRIPTION),
          start_date: SEARCH_CONSOLE_DATE_SCHEMA.describe('Start date (inclusive) in YYYY-MM-DD format.'),
          end_date: SEARCH_CONSOLE_DATE_SCHEMA.describe(
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
                'hour',
                'searchAppearance',
              ]),
            )
            .default(['query'])
            .describe(
              'Dimensions to group rows by. Pass [] (empty array) to get a single row of true site-level totals. Google Discover does not support the query dimension.',
            ),
          row_limit: z
            .number()
            .int()
            .min(1)
            .max(25000)
            .default(100)
            .describe(
              `Maximum rows requested for this logical page (1-25000). Defaults to 100. MCP responses are additionally capped to at most ${MAX_DIRECT_SOURCE_ROWS} source rows and a structured-content byte budget; use next_start_row while has_more is true for bulk exports.`,
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
            .enum(['all', 'final', 'hourly_all'])
            .default('all')
            .describe(
              "'all' includes fresh (preliminary) data and matches the GSC dashboard; 'final' returns only finalized data; 'hourly_all' returns hourly preliminary data and should be paired with the 'hour' dimension.",
            ),
          search_type: z
            .enum(['web', 'image', 'video', 'news', 'discover', 'googleNews'])
            .default('web')
            .describe('Which search index to query. Defaults to web. Google Discover does not support query grouping/filtering or average position.'),
          aggregation_type: z
            .enum(['auto', 'byNewsShowcasePanel', 'byPage', 'byProperty'])
            .default('auto')
            .describe(
              "How Google aggregates metrics. Leave as 'auto' unless specific semantics are needed. 'byProperty' cannot be used with page grouping/filtering or search_type discover/googleNews. 'byNewsShowcasePanel' requires search_type discover/googleNews plus a searchAppearance equals NEWS_SHOWCASE filter, and cannot be combined with page grouping/filtering or another searchAppearance filter.",
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
                    expression: z.string().max(4096),
                  }),
                ),
              }),
            )
            .optional()
            .describe(
              "Optional filters ANDed together, e.g. [{ groupType: 'and', filters: [{ dimension: 'country', operator: 'equals', expression: 'usa' }] }]. Countries use ISO 3166-1 alpha-3 codes. Query filters are not supported when search_type is discover.",
            ),
        },
        outputSchema: SEARCH_ANALYTICS_OUTPUT_SCHEMA,
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
        assertDateRange(start_date, end_date);
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'analytics.query');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        const sourceRowLimit = Math.min(row_limit, MAX_DIRECT_SOURCE_ROWS);
        const response = await querySearchAnalytics(accessToken, site_url, {
          startDate: start_date,
          endDate: end_date,
          dimensions,
          rowLimit: sourceRowLimit,
          startRow: start_row,
          dataState: data_state,
          type: search_type,
          aggregationType: aggregation_type,
          ...(dimension_filter_groups !== undefined
            ? { dimensionFilterGroups: dimension_filter_groups }
            : {}),
        });
        const sourceMayHaveMore =
          dimensions.length > 0 && response.rows.length === sourceRowLimit;
        const bounded = windowSourceRows(
          response.rows,
          start_row,
          row_limit,
          sourceMayHaveMore,
        );
        const payload: Record<string, unknown> = {
          row_count: bounded.items.length,
          start_row,
          rows: bounded.items,
          has_more: bounded.resultPage.has_more,
          truncated: bounded.resultPage.truncated,
          byte_limit_reached: bounded.resultPage.byte_limit_reached,
        };
        if (response.responseAggregationType !== undefined) {
          payload.response_aggregation_type = response.responseAggregationType;
        }
        if (response.metadata !== undefined) {
          payload.metadata = response.metadata;
        }
        if (bounded.resultPage.next_start_row !== undefined) {
          payload.next_start_row = bounded.resultPage.next_start_row;
        }
        // Compact JSON on purpose: analytics responses are the largest this
        // server produces, and pretty-printing them costs ~3x the tokens.
        return toolResponse(JSON.stringify(payload), payload);
      },
    );

    this.server.registerTool(
      'insights.page_queries',
      {
        title: 'Find queries for a page',
        description: 'For one exact page URL, return the Search Console queries that produced impressions for it over a date range. This wraps an exact page dimension filter so agents do not need to construct analytics.query filter groups manually. Exact page matching is case-sensitive in Search Console. Use row_limit and start_row to page through bounded results; Search Console can still omit anonymized queries. Google Discover is intentionally unavailable because Discover does not expose query data.',
        inputSchema: {
          site_url: z.string().describe(SITE_URL_DESCRIPTION),
          page_url: z.string().url().describe('Exact fully-qualified page URL to filter on, e.g. https://example.com/guides/seo/. Search Console exact page filters are case-sensitive.'),
          start_date: SEARCH_CONSOLE_DATE_SCHEMA.describe('Start date (inclusive) in YYYY-MM-DD format.'),
          end_date: SEARCH_CONSOLE_DATE_SCHEMA.describe('End date (inclusive) in YYYY-MM-DD format. Note the 2-3 day GSC data lag.'),
          search_type: z
            .enum(['web', 'image', 'video', 'news', 'googleNews'])
            .default('web')
            .describe('Which search index to query. Defaults to web. Discover is not supported because this tool groups by query.'),
          row_limit: z
            .number()
            .int()
            .min(1)
            .max(25000)
            .default(100)
            .describe('Maximum query rows requested for this response. Continue with result_page.next_start_row while result_page.has_more is true.'),
          start_row: z
            .number()
            .int()
            .min(0)
            .default(0)
            .describe('Zero-based Search Analytics row offset for pagination.'),
        },
        outputSchema: PAGE_QUERIES_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, page_url, start_date, end_date, search_type, row_limit = 100, start_row = 0 }) => {
        assertDateRange(start_date, end_date);
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'insights.page_queries');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        const sourceRowLimit = Math.min(row_limit, MAX_DIRECT_SOURCE_ROWS);
        const source = await querySearchAnalyticsPaginated(accessToken, site_url, {
          startDate: start_date,
          endDate: end_date,
          dimensions: ['query'],
          startRow: start_row,
          type: search_type,
          dimensionFilterGroups: [
            {
              groupType: 'and',
              filters: [
                { dimension: 'page', operator: 'equals', expression: page_url },
              ],
            },
          ],
        }, { maxRows: sourceRowLimit });
        const rows = source.rows
          .filter((row) => (row.keys?.length ?? 0) > 0)
          .map((row) => ({
            query: row.keys![0],
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
          }));
        const bounded = windowSourceRows(
          rows,
          start_row,
          row_limit,
          source.localLimitReached,
        );
        const payload = {
          page: page_url,
          queries: bounded.items,
          pagination: paginationMetadata(source),
          result_page: bounded.resultPage,
        };
        return toolResponse(JSON.stringify(payload), payload);
      },
    );

    this.server.registerTool(
      'insights.query_pages',
      {
        title: 'Find pages for a query',
        description: 'For one exact search query, return the site pages that received impressions for it over a date range. This wraps an exact query dimension filter so agents do not need to construct analytics.query filter groups manually. Exact query matching is case-sensitive in Search Console. Use row_limit and start_row to page through bounded results and verify which URL Google is surfacing before diagnosing cannibalization or content targeting. Google Discover is intentionally unavailable because Discover does not expose query data.',
        inputSchema: {
          site_url: z.string().describe(SITE_URL_DESCRIPTION),
          query: z.string().min(1).describe('Exact Search Console query text to filter on. Exact query filters are case-sensitive.'),
          start_date: SEARCH_CONSOLE_DATE_SCHEMA.describe('Start date (inclusive) in YYYY-MM-DD format.'),
          end_date: SEARCH_CONSOLE_DATE_SCHEMA.describe('End date (inclusive) in YYYY-MM-DD format. Note the 2-3 day GSC data lag.'),
          search_type: z
            .enum(['web', 'image', 'video', 'news', 'googleNews'])
            .default('web')
            .describe('Which search index to query. Defaults to web. Discover is not supported because this tool filters by query.'),
          row_limit: z
            .number()
            .int()
            .min(1)
            .max(25000)
            .default(100)
            .describe('Maximum page rows requested for this response. Continue with result_page.next_start_row while result_page.has_more is true.'),
          start_row: z
            .number()
            .int()
            .min(0)
            .default(0)
            .describe('Zero-based Search Analytics row offset for pagination.'),
        },
        outputSchema: QUERY_PAGES_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, query, start_date, end_date, search_type, row_limit = 100, start_row = 0 }) => {
        assertDateRange(start_date, end_date);
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'insights.query_pages');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        const sourceRowLimit = Math.min(row_limit, MAX_DIRECT_SOURCE_ROWS);
        const source = await querySearchAnalyticsPaginated(accessToken, site_url, {
          startDate: start_date,
          endDate: end_date,
          dimensions: ['page'],
          startRow: start_row,
          type: search_type,
          dimensionFilterGroups: [
            {
              groupType: 'and',
              filters: [
                { dimension: 'query', operator: 'equals', expression: query },
              ],
            },
          ],
        }, { maxRows: sourceRowLimit });
        const rows = source.rows
          .filter((row) => (row.keys?.length ?? 0) > 0)
          .map((row) => ({
            page: row.keys![0],
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
          }));
        const bounded = windowSourceRows(
          rows,
          start_row,
          row_limit,
          source.localLimitReached,
        );
        const payload = {
          query,
          pages: bounded.items,
          pagination: paginationMetadata(source),
          result_page: bounded.resultPage,
        };
        return toolResponse(JSON.stringify(payload), payload);
      },
    );

    if (accessMode === 'readwrite') {
      this.server.registerTool(
      'sites.add',
      {
        title: 'Add Search Console property',
        description: 'Add a new website property to your Google Search Console account. Note: Domain properties require sc-domain prefix (e.g., sc-domain:example.com), URL-prefix properties require full URL (e.g., https://example.com/).',
        inputSchema: {
          site_url: z.string().describe(SITE_URL_DESCRIPTION),
        },
        outputSchema: MESSAGE_OUTPUT_SCHEMA,
        annotations: WRITE_TOOL_ANNOTATIONS['sites.add'],
      },
      async ({ site_url }) => {
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'sites.add');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        await addSite(accessToken, site_url);
        const message = `Successfully added site property: ${site_url}`;
        return toolResponse(message, { message });
      },
    );

      this.server.registerTool(
      'sites.delete',
      {
        title: 'Delete Search Console property',
        description: 'Remove an existing website property from your Google Search Console account.',
        inputSchema: {
          site_url: z.string().describe(SITE_URL_DESCRIPTION),
        },
        outputSchema: MESSAGE_OUTPUT_SCHEMA,
        annotations: WRITE_TOOL_ANNOTATIONS['sites.delete'],
      },
      async ({ site_url }) => {
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'sites.delete');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        await deleteSite(accessToken, site_url);
        const message = `Successfully deleted site property: ${site_url}`;
        return toolResponse(message, { message });
      },
    );

      this.server.registerTool(
      'sitemaps.submit',
      {
        title: 'Submit sitemap',
        description: 'Submit a new sitemap to your Google Search Console account.',
        inputSchema: {
          site_url: z.string().describe(SITE_URL_DESCRIPTION),
          feedpath: z.string().describe('The full URL of the sitemap file to submit, e.g. https://example.com/sitemap.xml'),
        },
        outputSchema: MESSAGE_OUTPUT_SCHEMA,
        annotations: WRITE_TOOL_ANNOTATIONS['sitemaps.submit'],
      },
      async ({ site_url, feedpath }) => {
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'sitemaps.submit');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        await submitSitemap(accessToken, site_url, feedpath);
        const message = `Successfully submitted sitemap: ${feedpath} for site: ${site_url}`;
        return toolResponse(message, { message });
      },
    );

      this.server.registerTool(
      'sitemaps.delete',
      {
        title: 'Delete sitemap',
        description: 'Remove/delete a submitted sitemap from your Google Search Console account.',
        inputSchema: {
          site_url: z.string().describe(SITE_URL_DESCRIPTION),
          feedpath: z.string().describe('The full URL of the sitemap file to delete, e.g. https://example.com/sitemap.xml'),
        },
        outputSchema: MESSAGE_OUTPUT_SCHEMA,
        annotations: WRITE_TOOL_ANNOTATIONS['sitemaps.delete'],
      },
      async ({ site_url, feedpath }) => {
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'sitemaps.delete');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        await deleteSitemap(accessToken, site_url, feedpath);
        const message = `Successfully deleted sitemap: ${feedpath} for site: ${site_url}`;
        return toolResponse(message, { message });
      },
      );
    }

    this.server.registerTool(
      'sitemaps.get',
      {
        title: 'Get sitemap details',
        description: 'Get status and details of a single sitemap submitted to Google Search Console.',
        inputSchema: {
          site_url: z.string().describe(SITE_URL_DESCRIPTION),
          feedpath: z.string().describe('The full URL of the sitemap file, e.g. https://example.com/sitemap.xml'),
        },
        outputSchema: { sitemap: SITEMAP_OUTPUT_SCHEMA },
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, feedpath }) => {
        const googleId = this.requireGoogleId();
        const accessToken = await this.getAccessToken(googleId);
        const details = await getSitemap(accessToken, site_url, feedpath);
        return toolResponse(JSON.stringify(details, null, 2), { sitemap: details });
      },
    );

    this.server.registerTool(
      'insights.quick_wins',
      {
        title: 'Identify SEO Quick Wins',
        description: 'Find observed query/page Search Analytics rows with at least the requested impressions whose average position falls in a configurable opportunity range (8-20 by default). Average position is an aggregate Search Console metric, not a literal current rank; CTR is returned for context and is not an eligibility filter. Results are ordered deterministically by impressions, then bounded with limit/start_row and explicit result_page metadata. Source pagination separately flags the local 100,000-row safety ceiling.',
        inputSchema: createQuickWinsInputSchema(SITE_URL_DESCRIPTION),
        outputSchema: z.object(QUICK_WIN_OUTPUT_SCHEMA),
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, start_date, end_date, min_impressions, min_position, max_position, limit = DEFAULT_ANALYSIS_RESULT_LIMIT, start_row = 0 }) => {
        assertDateRange(start_date, end_date);
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'insights.quick_wins');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        const source = await querySearchAnalyticsPaginated(accessToken, site_url, {
          startDate: start_date,
          endDate: end_date,
          dimensions: ['query', 'page'],
        });

        const quickWins = processQuickWins(source.rows, min_impressions, min_position, max_position);
        const bounded = windowKnownResults(quickWins, start_row, limit);
        const payload = {
          note: 'Candidates are observed query/page rows selected by Search Console average position, not proof of a stable or current rank. CTR is reported for context and does not affect eligibility.',
          quick_wins: bounded.items,
          pagination: paginationMetadata(source),
          result_page: bounded.resultPage,
        };
        return toolResponse(JSON.stringify(payload), payload);
      },
    );

    this.server.registerTool(
      'insights.cannibalization',
      {
        title: 'Detect Keyword Cannibalization',
        description: 'Analyze query/page Search Analytics to find queries split across multiple pages. Candidates are ranked deterministically by the observed query/page impression sum, each candidate bounds its page list, and limit/start_row plus result_page provide safe pagination. total_clicks, total_impressions, and impression_share are calculated from observed query/page rows and are not true query-level property aggregates; multiple pages can make that row sum exceed the query-level Search Console total. Multiple ranking URLs can also reflect legitimate locale or intent differences, so treat candidates as evidence to investigate rather than proof of harmful cannibalization.',
        inputSchema: {
          site_url: z.string().describe(SITE_URL_DESCRIPTION),
          start_date: SEARCH_CONSOLE_DATE_SCHEMA.describe('Start date (inclusive) in YYYY-MM-DD format.'),
          end_date: SEARCH_CONSOLE_DATE_SCHEMA.describe('End date (inclusive) in YYYY-MM-DD format. Note the 2-3 day GSC data lag.'),
          min_impressions: CANNIBALIZATION_MIN_IMPRESSIONS_SCHEMA,
          min_page_percentage: CANNIBALIZATION_MIN_PAGE_PERCENTAGE_SCHEMA,
          limit: ANALYSIS_RESULT_LIMIT_SCHEMA,
          start_row: RESULT_START_ROW_SCHEMA,
        },
        outputSchema: CANNIBALIZATION_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, start_date, end_date, min_impressions, min_page_percentage, limit = DEFAULT_ANALYSIS_RESULT_LIMIT, start_row = 0 }) => {
        assertDateRange(start_date, end_date);
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'insights.cannibalization');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        const source = await querySearchAnalyticsPaginated(accessToken, site_url, {
          startDate: start_date,
          endDate: end_date,
          dimensions: ['query', 'page'],
        });

        const cannibalizationCandidates = processCannibalization(
          source.rows,
          min_impressions,
          min_page_percentage,
        ).map((candidate) => {
          const boundedPages = takeBoundedItems(candidate.pages, 10, 12_000);
          return {
            ...candidate,
            page_count: candidate.pages.length,
            pages_truncated:
              boundedPages.byteLimitReached ||
              boundedPages.items.length < candidate.pages.length,
            pages: boundedPages.items,
          };
        });
        const bounded = windowKnownResults(
          cannibalizationCandidates,
          start_row,
          limit,
        );
        const payload = {
          candidates: bounded.items,
          pagination: paginationMetadata(source),
          result_page: bounded.resultPage,
        };
        return toolResponse(JSON.stringify(payload), payload);
      },
    );

    this.server.registerTool(
      'insights.content_decay',
      {
        title: 'Detect Content Decay',
        description: 'Assess page-level click declines across two contiguous periods without treating every small click change as content decay. Each result is classified as likely_decay, weak_insufficient_evidence, or improving_visibility_with_click_volatility using deterministic click-volume, impression, and average-position signals. This is a heuristic assessment, not statistical proof. Results are bounded with limit/start_row; source pagination is reported separately.',
        inputSchema: {
          site_url: z.string().describe(SITE_URL_DESCRIPTION),
          compare_days: CONTENT_DECAY_COMPARE_DAYS_SCHEMA,
          limit: ANALYSIS_RESULT_LIMIT_SCHEMA,
          start_row: RESULT_START_ROW_SCHEMA,
        },
        outputSchema: CONTENT_DECAY_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, compare_days, limit = DEFAULT_ANALYSIS_RESULT_LIMIT, start_row = 0 }) => {
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'insights.content_decay');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);

        const formatDate = (d: Date) => d.toISOString().split('T')[0];

        const today = getSearchConsoleCalendarDate();
        const endRecentDate = new Date(`${today}T00:00:00Z`);
        endRecentDate.setUTCDate(endRecentDate.getUTCDate() - 3);
        const startRecentDate = new Date(endRecentDate.getTime() - (compare_days - 1) * 24 * 60 * 60 * 1000);

        const endPreviousDate = new Date(startRecentDate.getTime() - 24 * 60 * 60 * 1000);
        const startPreviousDate = new Date(endPreviousDate.getTime() - (compare_days - 1) * 24 * 60 * 60 * 1000);

        const recentStart = formatDate(startRecentDate);
        const recentEnd = formatDate(endRecentDate);
        const previousStart = formatDate(startPreviousDate);
        const previousEnd = formatDate(endPreviousDate);

        const recentSource = await querySearchAnalyticsPaginated(accessToken, site_url, {
          startDate: recentStart,
          endDate: recentEnd,
          dimensions: ['page'],
        });

        const previousSource = await querySearchAnalyticsPaginated(accessToken, site_url, {
          startDate: previousStart,
          endDate: previousEnd,
          dimensions: ['page'],
        });

        const decayResults = processContentDecay(
          recentSource.rows,
          previousSource.rows,
        );
        const bounded = windowKnownResults(decayResults, start_row, limit);

        const payload = {
          comparison_periods: {
            recent: { start: recentStart, end: recentEnd },
            previous: { start: previousStart, end: previousEnd },
          },
          decay_count: decayResults.filter(
            (result) => result.classification === 'likely_decay',
          ).length,
          assessment_count: decayResults.length,
          decay_results: bounded.items,
          pagination: {
            recent: paginationMetadata(recentSource),
            previous: paginationMetadata(previousSource),
          },
          result_page: bounded.resultPage,
        };
        return toolResponse(JSON.stringify(payload), payload);
      },
    );

    if (accessMode === 'readwrite') {
      this.server.registerTool(
      'indexing.request',
      {
        title: 'Request Indexing',
        description: "Requests indexing through Google's Indexing API for a URL within an owner-level Search Console property accessible to the connected Google account. Google currently restricts this API to pages containing JobPosting structured data or livestream pages containing BroadcastEvent inside VideoObject. It is not available for general webpage submission.",
        inputSchema: {
          site_url: z.string().describe(`${SITE_URL_DESCRIPTION} The connected Google account must be an owner of this property.`),
          url: z.string().superRefine((value, ctx) => {
            try {
              assertIndexingRequestUrl(value);
            } catch (error) {
              ctx.addIssue({
                code: 'custom',
                message: (error as Error).message,
              });
            }
          }).describe('The fully qualified HTTP/HTTPS URL to submit. It must fall within site_url and contain JobPosting structured data, or be a livestream page with BroadcastEvent inside VideoObject.'),
        },
        outputSchema: INDEXING_OUTPUT_SCHEMA,
        annotations: WRITE_TOOL_ANNOTATIONS['indexing.request'],
      },
      async ({ site_url, url }) => {
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'indexing.request');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        const sites = await listSites(accessToken);
        assertIndexingUrlAuthorized(url, site_url, sites);
        const result = await requestIndexing(accessToken, url);
        const payload = {
          result,
          note: "Google accepting this notification does not guarantee the URL will be indexed. Indexing remains at Google's discretion.",
        };
        return toolResponse(JSON.stringify(payload, null, 2), payload);
      },
      );
    }

    this.server.registerTool(
      'indexing.list_pages',
      {
        title: 'List Search-Visible Pages',
        description: `${SEARCH_VISIBLE_PAGES_DESCRIPTION} When one date boundary is omitted, the server derives the other to target an inclusive 30-day range; generated end dates are capped at the latest complete date. Responses are bounded and pageable with row_limit/start_row.`,
        inputSchema: {
          site_url: z.string().describe(SITE_URL_DESCRIPTION),
          start_date: SEARCH_CONSOLE_DATE_SCHEMA.optional().describe('Start date (inclusive) in YYYY-MM-DD format. If end_date is omitted, the generated end date is 29 days later, capped at the latest complete date.'),
          end_date: SEARCH_CONSOLE_DATE_SCHEMA.optional().describe('End date (inclusive) in YYYY-MM-DD format. If start_date is omitted, the generated start date is 29 days earlier. Defaults to 3 days ago. Note the 2-3 day data lag.'),
          row_limit: z.number().int().min(1).max(25000).default(1000).describe(`Maximum pages requested for this logical response (1-25000). Output is safely bounded; continue with result_page.next_start_row while result_page.has_more is true.`),
          start_row: z.number().int().min(0).default(0).describe('Zero-based page-row offset for pagination.'),
        },
        outputSchema: INDEXED_PAGES_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, start_date, end_date, row_limit, start_row = 0 }) => {
        const { startDate, endDate } = resolveIndexedPagesDateRange(
          start_date,
          end_date,
          getSearchConsoleCalendarDate(),
        );
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'indexing.list_pages');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);

        const sourceRowLimit = Math.min(row_limit, MAX_DIRECT_SOURCE_ROWS);
        const response = await querySearchAnalytics(accessToken, site_url, {
          startDate,
          endDate,
          dimensions: ['page'],
          rowLimit: sourceRowLimit,
          startRow: start_row,
        });

        const pages = response.rows
          .filter((row) => (row.keys?.length ?? 0) > 0)
          .map((row) => ({
            page: row.keys![0],
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
          }));
        const bounded = windowSourceRows(
          pages,
          start_row,
          row_limit,
          response.rows.length === sourceRowLimit,
        );

        const payload = {
          pages: bounded.items,
          result_page: bounded.resultPage,
          note: SEARCH_VISIBLE_PAGES_NOTE,
        };
        return toolResponse(JSON.stringify(payload), payload);
      },
    );

    this.server.registerTool(
      'analytics.compare',
      {
        title: 'Compare Performance Between Periods',
        description: 'Compare Search Console performance metrics (clicks, impressions, CTR, average position) between two distinct date ranges (Period A vs Period B) for a selected dimension (query, page, country, device). Apply the same search type and optional dimension filters to both periods. Results are ranked by largest absolute click change, then impression change, and safely paged with limit/start_row. Percentage change is null when the baseline is zero and the comparison value differs. Discover is intentionally unavailable because this comparison contract includes average position, which the Discover report does not support.',
        inputSchema: {
          site_url: z.string().describe(SITE_URL_DESCRIPTION),
          start_date_a: SEARCH_CONSOLE_DATE_SCHEMA.describe('Start date of Period A (recent, YYYY-MM-DD)'),
          end_date_a: SEARCH_CONSOLE_DATE_SCHEMA.describe('End date of Period A (recent, YYYY-MM-DD)'),
          start_date_b: SEARCH_CONSOLE_DATE_SCHEMA.describe('Start date of Period B (previous, YYYY-MM-DD)'),
          end_date_b: SEARCH_CONSOLE_DATE_SCHEMA.describe('End date of Period B (previous, YYYY-MM-DD)'),
          dimension: z.enum(['query', 'page', 'country', 'device']).default('query').describe('The dimension to compare performance for. Defaults to query.'),
          search_type: z
            .enum(['web', 'image', 'video', 'news', 'googleNews'])
            .default('web')
            .describe('Which Search Console search index to compare. The same search type is used for both periods. Discover is excluded because this tool returns average-position comparisons.'),
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
              "Optional Search Console filters applied identically to both periods. Use query regex filters for brand/non-brand comparisons; countries use ISO 3166-1 alpha-3 codes.",
            ),
          limit: ANALYSIS_RESULT_LIMIT_SCHEMA,
          start_row: RESULT_START_ROW_SCHEMA,
        },
        outputSchema: PERFORMANCE_COMPARISON_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({
        site_url,
        start_date_a,
        end_date_a,
        start_date_b,
        end_date_b,
        dimension,
        search_type,
        dimension_filter_groups,
        limit = DEFAULT_ANALYSIS_RESULT_LIMIT,
        start_row = 0,
      }) => {
        assertDateRange(start_date_a, end_date_a, 'start_date_a', 'end_date_a');
        assertDateRange(start_date_b, end_date_b, 'start_date_b', 'end_date_b');
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'analytics.compare');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);

        const sourceA = await querySearchAnalyticsPaginated(accessToken, site_url, {
          startDate: start_date_a,
          endDate: end_date_a,
          dimensions: [dimension],
          type: search_type,
          ...(dimension_filter_groups !== undefined
            ? { dimensionFilterGroups: dimension_filter_groups }
            : {}),
        });

        const sourceB = await querySearchAnalyticsPaginated(accessToken, site_url, {
          startDate: start_date_b,
          endDate: end_date_b,
          dimensions: [dimension],
          type: search_type,
          ...(dimension_filter_groups !== undefined
            ? { dimensionFilterGroups: dimension_filter_groups }
            : {}),
        });

        const comparison = processPerformanceComparison(sourceA.rows, sourceB.rows);
        const bounded = windowKnownResults(comparison, start_row, limit);
        const payload = {
          comparisons: bounded.items,
          pagination: {
            period_a: paginationMetadata(sourceA),
            period_b: paginationMetadata(sourceB),
          },
          result_page: bounded.resultPage,
        };
        return toolResponse(JSON.stringify(payload), payload);
      },
    );

    this.server.registerTool(
      'reports.weekly_digest',
      {
        title: 'Weekly GSC Performance Digest',
        description:
          'Generate a plain-language weekly SEO report for one Google Search Console property. Returns a markdown digest covering the 7 days ending on end_date, with week-over-week comparison, top pages, queries gaining or losing traction, and one specific action item. Defaults end_date to 3 days ago so the report uses the latest usually-complete Search Console data; pass end_date explicitly to include fresher preliminary data.',
        inputSchema: {
          site_url: z.string().describe(SITE_URL_DESCRIPTION),
          end_date: SEARCH_CONSOLE_DATE_SCHEMA
            .optional()
            .describe('End date (inclusive) in YYYY-MM-DD format. Defaults to 3 days ago, which is usually the latest complete Search Console date. Pass a more recent date explicitly to include preliminary data.'),
        },
        outputSchema: WEEKLY_DIGEST_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, end_date }) => {
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'reports.weekly_digest');
        if (rateLimitError) return rateLimitError;
        const today = getSearchConsoleCalendarDate();
        const resolvedEndDate = resolveWeeklyDigestEndDate(end_date, today);
        assertDateNotInFuture(resolvedEndDate, today);

        try {
          const markdown = await generateWeeklyDigest(
            this.getAccessTokenLifecycle(),
            googleId,
            site_url,
            resolvedEndDate,
          );
          return toolResponse(markdown, { markdown });
        } catch (err) {
          if (err instanceof GoogleRefreshTokenRevokedError) {
            throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
          }
          throw err;
        }
      },
    );
  }
}

let sharedAccessTokens: GoogleAccessTokenLifecycle | undefined;

function getSharedAccessTokenLifecycle(env: Env): GoogleAccessTokenLifecycle {
  sharedAccessTokens ??= new GoogleAccessTokenLifecycle(env);
  return sharedAccessTokens;
}

function currentAgentProps(): AgentProps | undefined {
  const props = getMcpAuthContext()?.props;
  if (!props) return undefined;
  if (typeof props.google_id !== 'string' || typeof props.email !== 'string') {
    return undefined;
  }
  return { google_id: props.google_id, email: props.email };
}

export async function createGscMcpServer(
  env: Env,
  props: AgentProps | undefined = currentAgentProps(),
  accessTokens = getSharedAccessTokenLifecycle(env),
): Promise<McpServer> {
  const runtime = new GscMcpRuntime(env, props, accessTokens);
  await runtime.init();
  return runtime.server;
}

export const mcpApiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const handler = createMcpHandler(() => createGscMcpServer(env), {
      route: '/mcp',
    });
    return handler(request, env, ctx);
  },
};

/**
 * Compatibility shell for the existing Durable Object binding. The MCP
 * transport no longer routes through this class, but retaining the class and
 * binding avoids a destructive Durable Object deletion migration.
 */
export class GscMcpAgent extends DurableObject<Env> {
  fetch(): Response {
    return new Response('Legacy MCP transport is no longer routed here.', {
      status: 410,
    });
  }
}

/**
 * OAuth nonces are addressed one Durable Object per nonce. Extending the
 * platform base class is required for the store/consume methods to be exposed
 * through Durable Object RPC.
 */
export class PendingAuthState extends DurableObject<Env> {
  private readonly pending = new PendingAuthStateStore(this.ctx.storage);

  store(claudeAuthRequest: unknown): Promise<void> {
    return this.pending.store(claudeAuthRequest);
  }

  consume() {
    return this.pending.consume();
  }

  alarm(): Promise<void> {
    return this.pending.alarm();
  }
}

function googleRedirectUri(request: Request): string {
  return new URL('/google/callback', request.url).toString();
}

export const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ping' && request.method === 'GET') {
      return new Response('pong', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

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
      let accessMode: GscAccessMode;
      try {
        accessMode = resolveGscAccessMode(env.GSC_ACCESS_MODE);
      } catch {
        return new Response(
          'Server configuration error: GSC_ACCESS_MODE must be "readonly" or "readwrite".',
          { status: 500 },
        );
      }
      const nonce = crypto.randomUUID();
      await stashPendingAuth(env, nonce, claudeAuthRequest);
      const redirectUri = googleRedirectUri(request);
      const googleUrl = buildAuthUrl(
        env.GOOGLE_CLIENT_ID,
        redirectUri,
        nonce,
        accessMode,
      );
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

      const pending = await consumePendingAuth(env, state);
      if (!pending) {
        console.error('Pending auth not found or expired');
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
    '/mcp': mcpApiHandler,
  },
  defaultHandler: defaultHandler as any,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientIdMetadataDocumentEnabled: true,
  clientRegistrationEndpoint: '/register',
});
