import { OAuthProvider, type AuthRequest } from '@cloudflare/workers-oauth-provider';
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
  summarizeUrlInspectionIndexStatus,
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
  hasRecordedPosition,
  processQuickWins,
  processCannibalization,
  processContentDecay,
  requestIndexing,
  requestIndexingRemoval,
  getIndexingNotificationMetadata,
  processPerformanceComparison,
  assertSearchAnalyticsFilterCompatible,
  assertSearchAnalyticsQueryCompatible,
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
import {
  enforceToolRateLimit,
  getToolRateLimitUnits,
  type RateLimitedToolName,
} from './tool-rate-limit';
export { ToolRateLimiter } from './tool-rate-limiter-do';
import {
  generateWeeklyDigest,
  resolveWeeklyDigestEndDate,
  weeklyDigestAnalyticsRequestCount,
} from './digest';
import {
  CANNIBALIZATION_MIN_IMPRESSIONS_SCHEMA,
  CANNIBALIZATION_MIN_PAGE_PERCENTAGE_SCHEMA,
  CANNIBALIZATION_PAGE_CONTAINS_SCHEMA,
  CANNIBALIZATION_QUERY_CONTAINS_SCHEMA,
} from './cannibalization-schema';
import {
  assertDateNotInFuture,
  assertDateRange,
  getSearchConsoleCalendarDate,
  SEARCH_CONSOLE_DATE_SCHEMA,
  searchConsoleDateDescription,
} from './date-validation';
import {
  CONTENT_DECAY_COMPARE_DAYS_SCHEMA,
  CONTENT_DECAY_COUNTRY_SCHEMA,
  CONTENT_DECAY_PAGE_CONTAINS_SCHEMA,
  CONTENT_DECAY_QUERY_CONTAINS_SCHEMA,
} from './content-decay-schema';
import { INDEXED_PAGES_START_ROW_SCHEMA, resolveIndexedPagesDateRange } from './indexed-pages-range';
import { createQuickWinsInputSchema } from './quick-wins-schema';
import { SITEMAP_URL_SCHEMA } from './sitemap-url-schema';
import { URL_INSPECTION_LANGUAGE_CODE_SCHEMA } from './url-inspection-language-schema';
import {
  classifySearchConsolePropertyIdentifier,
  SEARCH_CONSOLE_PROPERTY_DESCRIPTION,
  SEARCH_CONSOLE_PROPERTY_SCHEMA,
} from './search-console-property-schema';
import { WRITE_TOOL_ANNOTATIONS } from './write-tool-annotations';
import {
  getToolCatalogForAccessMode,
  getGoogleOAuthScopes,
  resolveGscAccessMode,
  type GscAccessMode,
} from './access-mode';
import {
  assertIndexingRequestUrl,
  assertIndexingUrlAuthorized,
  assertUrlWithinSearchConsoleProperty,
} from './indexing-property-authorization';
import {
  DEFAULT_ANALYSIS_RESULT_LIMIT,
  MAX_ANALYSIS_RESULT_LIMIT,
  MAX_DIRECT_SOURCE_ROWS,
  SEARCH_ANALYTICS_START_ROW_SCHEMA,
  STRUCTURED_RESULT_BYTE_BUDGET,
  resultPageMetadata,
  takeBoundedItems,
  windowSourceRows,
  mapSourceRows,
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
const SERVER_INSTRUCTIONS =
  'If the exact Search Console site_url is unknown, call sites.list before property-scoped tools. Search Analytics can omit rows: page while has_more is true, and never treat a row missing from one bounded period as zero traffic. indexing.list_pages reports Search performance visibility, not index coverage; use urls.inspect or urls.inspect_many for indexed-state evidence. The Indexing API is restricted to eligible JobPosting/livestream pages; a receipt is not proof of indexing or removal.';

const NOT_AUTHENTICATED_MESSAGE =
  `Not authenticated. ${MCP_RECONNECT_INSTRUCTION}`;

// Annotation utilities for read-only vs write actions.
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: true,
} as const;

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
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  position: z
    .number()
    .optional()
    .describe(
      'Average position when Google records it. Omitted for Discover and Google News, where Search Console does not record position.',
    ),
};

const SEARCH_ANALYTICS_FILTER_SCHEMA = z
  .object({
    dimension: z.enum([
      'query',
      'page',
      'country',
      'device',
      'searchAppearance',
    ]),
    operator: z
      .enum([
        'equals',
        'notEquals',
        'contains',
        'notContains',
        'includingRegex',
        'excludingRegex',
      ])
      .default('equals'),
    expression: z.string().max(4096),
  })
  .superRefine((filter, ctx) => {
    try {
      assertSearchAnalyticsFilterCompatible(filter);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: ['expression'],
        message: (error as Error).message,
      });
    }
  });

const SEARCH_ANALYTICS_FILTER_GROUP_SCHEMA = z.object({
  groupType: z.literal('and').default('and'),
  filters: z.array(SEARCH_ANALYTICS_FILTER_SCHEMA),
});

const SITE_VERIFICATION_STATE_SCHEMA = z
  .enum(['verified', 'unverified', 'unknown'])
  .describe(
    "Derived from Google's permissionLevel. siteOwner/siteFullUser/siteRestrictedUser are verified, siteUnverifiedUser is unverified, and any future undocumented permission level is reported as unknown.",
  );

const SITE_OUTPUT_SCHEMA = {
  siteUrl: z.string(),
  permissionLevel: z.string(),
  verification_state: SITE_VERIFICATION_STATE_SCHEMA,
  owner: z.boolean().describe(
    "True only when Google returns permissionLevel 'siteOwner'. Restricted Indexing API workflows require owner-level Search Console access.",
  ),
};

const LISTED_SITE_OUTPUT_SCHEMA = {
  ...SITE_OUTPUT_SCHEMA,
  api_identifier_kind: z.enum(['domain', 'url_prefix', 'undocumented']),
  mcp_site_url_accepted: z.boolean(),
  unsupported_reason: z.string().optional(),
};

const PLATFORM_PROPERTY_API_NOTE =
  "Google Search Console now has platform properties for social/video accounts in its UI, but the current Search Console API documentation still defines siteUrl using URL-prefix and sc-domain website-property forms. mcp-gsc preserves any other identifier returned by sites.list but will not pass an undocumented property identifier to API tools until Google publishes that contract.";

function sitePermissionState(permissionLevel: string): {
  verification_state: 'verified' | 'unverified' | 'unknown';
  owner: boolean;
} {
  if (permissionLevel === 'siteUnverifiedUser') {
    return { verification_state: 'unverified', owner: false };
  }
  if (
    permissionLevel === 'siteOwner' ||
    permissionLevel === 'siteFullUser' ||
    permissionLevel === 'siteRestrictedUser'
  ) {
    return {
      verification_state: 'verified',
      owner: permissionLevel === 'siteOwner',
    };
  }
  return { verification_state: 'unknown', owner: false };
}

const SITEMAP_PROVIDER_NOTE =
  "Google's lastSubmitted is the time the sitemap was submitted to Search Console; it is not the sitemap file's generation, deployment, or last-modified time. lastDownloaded is the time Google last downloaded the sitemap; it is not a page crawl or indexing timestamp.";

const SITEMAP_OUTPUT_SCHEMA = z
  .object({
    path: z.string(),
    lastSubmitted: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Provider-reported time the sitemap was submitted to Search Console; not the sitemap file generation, deployment, or modification time.',
      ),
    isPending: z.boolean().nullable().optional(),
    isSitemapsIndex: z.boolean().nullable().optional(),
    type: z.string().nullable().optional(),
    lastDownloaded: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Provider-reported time Google last downloaded the sitemap; not a page crawl or page indexing timestamp.',
      ),
    warnings: z.string().nullable().optional(),
    errors: z.string().nullable().optional(),
    contents: z
      .array(
        z.object({
          type: z.string(),
          submitted: z
            .string()
            .describe('Provider-reported submitted URL count for this sitemap content type.'),
        }),
      )
      .nullable()
      .optional(),
  });

const CAPABILITIES_OUTPUT_SCHEMA = {
  server: z.string(),
  version: z.string(),
  access_mode: z.enum(['readonly', 'readwrite']),
  auth_status: z.enum(['connected', 'not_connected', 'unknown']).describe(
    "Local credential state: 'connected' means a stored Google refresh credential is present; it does not live-verify that Google still accepts it.",
  ),
  auth_status_basis: z.enum([
    'stored_refresh_token',
    'no_stored_refresh_token',
    'local_state_unavailable',
  ]),
  provider_auth_live_verified: z.literal(false).describe(
    'Always false because server.capabilities does not make a Google token or API request merely to probe authorization.',
  ),
  auth_note: z.string(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
    }),
  ),
  provider_limits: z.object({
    generative_ai_performance_report: z.object({
      dedicated_api_supported: z.literal(false),
      note: z.string(),
    }),
  }),
  hint: z.string(),
};

const SITE_DETAIL_OUTPUT_SCHEMA = {
  site: z.object(SITE_OUTPUT_SCHEMA),
};

const SITE_ADD_VERIFICATION_NOTE =
  "Google Search Console Sites.add only adds the property to the user's Search Console site set; it does not verify ownership. Ownership verification is a separate Google Site Verification/Search Console workflow.";

const INDEXING_PROVIDER_USAGE_NOTE =
  "Google's current Indexing API quota documentation lists 200 publish requests per day per project, shared by update and removal notifications. Google's October 16, 2026 update removed the previous quota-approval request form; this does not authorize exceeding Google's quota, submitting ineligible content, or bypassing required project/API permissions. Google applies spam detection and may revoke access for abuse or attempts to circumvent limits.";

const URL_INSPECTION_SCOPE_NOTE =
  "Google's URL Inspection API reports the version currently known in Google's index; it does not run a live URL test or prove current live-page indexability. The mobileUsabilityResult field is deprecated and may be absent.";

const URL_INSPECTION_INDEX_STATUS_SUMMARY_SCHEMA = z.object({
  indexed_state: z.enum(['indexed', 'not_indexed', 'unknown']).describe(
    "Conservative state derived only from Google's indexStatusResult.verdict: PASS => indexed, FAIL/NEUTRAL => not_indexed, and missing/unknown/reserved verdicts => unknown.",
  ),
  verdict: z.string().optional(),
  coverage_state: z.string().optional(),
  robots_txt_state: z.string().optional(),
  indexing_state: z.string().optional(),
  last_crawl_time: z.string().optional(),
  page_fetch_state: z.string().optional(),
  google_canonical: z.string().optional(),
  user_canonical: z.string().optional(),
  crawled_as: z.string().optional(),
});

const INSPECTION_OUTPUT_SCHEMA = {
  inspection_result: z.unknown().optional(),
  inspection_result_omitted: z.boolean().optional().describe(
    'True when the raw Google response exceeded the bounded MCP output budget; index_status_summary remains available.',
  ),
  summary_fields_omitted: z.boolean().optional().describe(
    'True when oversized provider status descriptions were omitted; indexed_state remains available.',
  ),
  index_status_summary: URL_INSPECTION_INDEX_STATUS_SUMMARY_SCHEMA,
  note: z.string(),
};

const INSPECTION_BATCH_OUTPUT_SCHEMA = {
  requested_count: z.number().int().positive(),
  succeeded_count: z.number().int().nonnegative(),
  failed_count: z.number().int().nonnegative(),
  index_status_counts: z.object({
    indexed: z.number().int().nonnegative(),
    not_indexed: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }).describe('Conservative indexed-state counts among successful inspections only. Failed requests are excluded; these counts are not property-wide index coverage.'),
  raw_results_omitted_count: z.number().int().nonnegative().describe(
    'Number of successful URL inspections whose raw Google detail was omitted to keep this batch bounded.',
  ),
  note: z.string(),
  results: z.array(
    z.object({
      inspection_url: z.string(),
      inspection_result: z.unknown().optional(),
      index_status_summary: URL_INSPECTION_INDEX_STATUS_SUMMARY_SCHEMA.optional(),
      inspection_result_omitted: z.boolean().optional().describe(
        'True if the raw Google result was omitted for response size; index_status_summary remains available.',
      ),
      summary_fields_omitted: z.boolean().optional(),
      error_truncated: z.boolean().optional(),
      error: z.string().optional(),
    }),
  ),
};

const SEARCH_ANALYTICS_OUTPUT_SCHEMA = {
  row_count: z.number().int().nonnegative(),
  start_row: z.number().int().nonnegative(),
  rows: z.array(z.object(SEARCH_ROW_OUTPUT_SCHEMA)),
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
    .describe(
      'Ordered labels for rows[].keys. Each key position corresponds to the dimension at the same index. Empty for aggregate dimensions: [] queries.',
    ),
  search_type: z
    .enum(['web', 'image', 'video', 'news', 'discover', 'googleNews'])
    .describe('The Search Analytics search type requested for this response.'),
  data_state: z.enum(['all', 'final', 'hourly_all']).describe(
    'The Search Analytics dataState requested from Google for this response.',
  ),
  preliminary_data_possible: z.boolean().describe(
    'True when the requested data state can include fresh data that is still being collected and processed. This does not assert that every returned row is incomplete.',
  ),
  position_supported: z.boolean().describe(
    'Whether average position is supported for the selected Search Analytics search type. False for Google Discover and Google News.',
  ),
  position_note: z.string().optional(),
  provider_exhaustiveness_guaranteed: z.literal(false).describe(
    'False because the Search Analytics API does not guarantee every data row; Google can return only top rows even after local pagination is exhausted.',
  ),
  provider_note: z.string(),
  generative_ai_report_isolatable: z.literal(false).describe(
    'False because the current documented Search Analytics API exposes no dedicated Generative AI report search type or filter selector.',
  ),
  generative_ai_note: z.string(),
  multimodal_report_isolatable: z.literal(false).describe(
    'False because the current documented Search Analytics API exposes no dedicated web multimodal search type or filter selector.',
  ),
  multimodal_note: z.string(),
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

const SITE_ADD_OUTPUT_SCHEMA = {
  message: z.string(),
  ownership_verification_performed: z.literal(false),
  ownership_verification_note: z.string(),
};

const SITE_DELETE_OUTPUT_SCHEMA = {
  message: z.string(),
  removed_from_connected_account_site_set: z.literal(true),
  website_content_deleted: z.literal(false),
  provider_scope_note: z.string(),
};

const SITEMAP_SUBMIT_OUTPUT_SCHEMA = {
  message: z.string(),
  submitted_to_search_console: z.literal(true),
  sitemap_processing_completion_proven: z.literal(false),
  page_indexing_proven: z.literal(false),
  provider_scope_note: z.string(),
};

const SITEMAP_DELETE_OUTPUT_SCHEMA = {
  message: z.string(),
  removed_from_search_console: z.literal(true),
  sitemap_file_deleted: z.literal(false),
  page_deindexing_proven: z.literal(false),
  provider_scope_note: z.string(),
};

const SEARCH_ANALYTICS_PAGINATION_OUTPUT_SCHEMA = z.object({
  rows_fetched: z.number().int().nonnegative(),
  pages_fetched: z.number().int().positive(),
  local_limit_reached: z.boolean(),
  provider_exhaustiveness_guaranteed: z.literal(false).describe(
    'False because Google does not guarantee that Search Analytics exposes every data row.',
  ),
  provider_note: z.string(),
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

const SITES_OUTPUT_SCHEMA = {
  sites: z.array(z.object(LISTED_SITE_OUTPUT_SCHEMA)),
  result_page: RESULT_PAGE_OUTPUT_SCHEMA,
};

const SITEMAPS_OUTPUT_SCHEMA = {
  sitemaps: z.array(SITEMAP_OUTPUT_SCHEMA),
  provider_note: z.string(),
  result_page: RESULT_PAGE_OUTPUT_SCHEMA,
};

// Leave room for pagination metadata and the sitemap provider note inside 48 KB.
const COLLECTION_LIST_BYTE_BUDGET = 44_000;
const COLLECTION_LIST_LIMIT_SCHEMA = z.number().int().min(1).max(250).default(100)
  .describe('Maximum items per response (1-250), subject to the output byte limit.');

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
  page_contains: z.string().nullable().describe('Page URL substring filtered at Google, or null when unfiltered.'),
  query_contains: z.string().nullable().describe('Query topic substring filtered at Google, or null when unfiltered.'),
  country: z.string().nullable().describe('ISO alpha-3 searcher country filtered at Google, or null when unfiltered. Not a page language.'),
  scope_note: z.string(),
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
  query_contains: z.string().nullable().describe('Optional query topic substring filtered at Google before Search Analytics pagination, or null for no topic filter.'),
  scope_note: z.string(),
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
  page_contains: z.string().nullable().describe('Optional URL substring filtered at Google before Search Analytics pagination, or null for no page filter.'),
  scope_note: z.string(),
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
  page_contains: z.string().nullable().describe('Page URL substring passed to Google for the Search Analytics page filter, or null for no page filter.'),
  query_contains: z.string().nullable().describe('Query substring passed to Google for the Search Analytics query filter, or null for no query filter.'),
  scope_note: z.string(),
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
  search_type: z.enum(['web', 'image', 'video', 'news']),
  page_contains: z.string().nullable(),
  query_contains: z.string().nullable(),
  country: z.string().nullable(),
  scope_note: z.string(),
  comparison_periods: z.object({
    recent: z.object({ start: z.string(), end: z.string() }),
    previous: z.object({ start: z.string(), end: z.string() }),
  }),
  comparison_scope: z.literal('common_returned_rows_only'),
  comparison_note: z.string(),
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
  provider_default_publish_requests_per_day: z.literal(200),
  provider_default_quota_for_testing_only: z.literal(false),
  provider_usage_approval_required: z.literal(false),
  provider_spam_detection_applies: z.literal(true),
  provider_usage_note: z.string(),
};

const INDEXING_REMOVE_OUTPUT_SCHEMA = {
  ...INDEXING_OUTPUT_SCHEMA,
  removal_completion_proven: z.literal(false),
};

const INDEXING_NOTIFICATION_SCHEMA = z.object({
  url: z.string().optional(),
  type: z.string().optional(),
  notifyTime: z.string().optional(),
});

const INDEXING_STATUS_OUTPUT_SCHEMA = {
  notification_metadata: z.object({
    url: z.string().optional(),
    latestUpdate: INDEXING_NOTIFICATION_SCHEMA.optional(),
    latestRemove: INDEXING_NOTIFICATION_SCHEMA.optional(),
  }),
  notification_receipt_only: z.literal(true),
  index_coverage_report: z.literal(false),
  indexing_or_removal_completion_proven: z.literal(false),
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

const COMMON_RETURNED_ROWS_COMPARISON_NOTE =
  'Comparisons use only dimension keys returned in both period responses. A key missing from one Search Analytics response is not treated as zero because Google does not guarantee every data row.';

const PERFORMANCE_COMPARISON_OUTPUT_SCHEMA = {
  comparison_scope: z.literal('common_returned_rows_only'),
  comparison_note: z.string(),
  data_state: z.enum(['all', 'final']).describe(
    'The Search Analytics dataState applied identically to both comparison periods.',
  ),
  preliminary_data_possible: z.boolean().describe(
    'True when data_state=all, because recent Search Analytics rows can still be incomplete and subject to change.',
  ),
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

type InspectionBatchEntry = {
  inspection_url: string;
  inspection_result?: unknown;
  index_status_summary?: ReturnType<typeof summarizeUrlInspectionIndexStatus>;
  error?: string;
  inspection_result_omitted?: boolean;
  summary_fields_omitted?: boolean;
  error_truncated?: boolean;
};

function boundInspectionBatchPayload(entries: InspectionBatchEntry[]) {
  // Reserve MCP envelope headroom; bound text and structured payload equally.
  const byteBudget = STRUCTURED_RESULT_BYTE_BUDGET - 2_000;
  const encodedBytes = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const compact: InspectionBatchEntry[] = entries.map((entry) => {
    const { inspection_result, ...status } = entry;
    return inspection_result !== undefined
      ? { ...status, inspection_result_omitted: true }
      : status;
  });
  const indexStatusCounts = { indexed: 0, not_indexed: 0, unknown: 0 };
  for (const entry of entries) {
    if (entry.inspection_result === undefined) continue;
    switch (entry.index_status_summary?.indexed_state) {
      case 'indexed': indexStatusCounts.indexed += 1; break;
      case 'not_indexed': indexStatusCounts.not_indexed += 1; break;
      default: indexStatusCounts.unknown += 1; break;
    }
  }
  const makePayload = () => ({
    requested_count: entries.length,
    succeeded_count: entries.filter((entry) => entry.inspection_result !== undefined).length,
    failed_count: entries.filter((entry) => entry.inspection_result === undefined).length,
    index_status_counts: indexStatusCounts,
    raw_results_omitted_count: compact.filter((entry) => entry.inspection_result_omitted).length,
    note: URL_INSPECTION_SCOPE_NOTE,
    results: compact,
  });

  // Preserve exact URL identity and normalized indexed state when provider
  // messages or optional status annotations themselves are oversized.
  if (encodedBytes(makePayload()) > byteBudget) {
    for (const entry of compact) {
      if (entry.error && entry.error.length > 512) {
        entry.error = entry.error.slice(0, 512);
        entry.error_truncated = true;
      }
      if (entry.index_status_summary) {
        entry.index_status_summary = {
          indexed_state: entry.index_status_summary.indexed_state,
        };
        entry.summary_fields_omitted = true;
      }
    }
  }
  if (encodedBytes(makePayload()) > byteBudget) {
    throw new Error('URL Inspection result identifiers exceed the bounded response budget. Retry with shorter URLs or smaller batches.');
  }

  // Restore raw Google data where the entire batch still fits. Earlier large
  // results cannot crowd out the statuses for later requested URLs.
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].inspection_result === undefined) continue;
    const previous = compact[i];
    compact[i] = { ...entries[i] };
    if (encodedBytes(makePayload()) > byteBudget) compact[i] = previous;
  }
  return makePayload();
}

const SEARCH_ANALYTICS_PROVIDER_NOTE =
  'Google Search Analytics does not guarantee all data rows and can return only top rows. Local pagination fields describe what this server fetched or bounded; they do not prove provider-level exhaustiveness.';

const GENERATIVE_AI_REPORT_API_NOTE =
  "Search Console's dedicated Generative AI performance reports are not exposed by the current documented Search Analytics API as a dedicated search type or filter selector. AI Overviews and AI Mode remain included in overall web Search performance data. Do not infer isolated Generative AI metrics from analytics.query or guess a searchAppearance identifier.";

const MULTIMODAL_REPORT_API_NOTE =
  "Search Console's web multimodal performance filter is currently available in the Search Console UI, but the documented Search Analytics API does not expose a multimodal search type or filter selector. Current API search types remain web, image, video, news, discover, and googleNews. Do not pass search_type='multimodal' or guess a searchAppearance identifier to isolate Lens, Circle to Search, image-upload, or Chrome image-search traffic.";

function paginationMetadata(result: PaginatedSearchAnalyticsResult) {
  return {
    rows_fetched: result.rows.length,
    pages_fetched: result.pagesFetched,
    local_limit_reached: result.localLimitReached,
    provider_exhaustiveness_guaranteed: false as const,
    provider_note: SEARCH_ANALYTICS_PROVIDER_NOTE,
  };
}

function windowKnownResults<T>(
  items: readonly T[],
  startRow: number,
  limit: number,
  byteBudget?: number,
) {
  const requested = items.slice(startRow, startRow + limit);
  const bounded = takeBoundedItems(requested, limit, byteBudget);
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
      'List accessible Search Console properties with bounded, deterministic pagination using start_row and limit. Follow result_page.next_start_row while has_more is true.',
  },
  {
    name: 'sites.get',
    description:
      'Get one exact Search Console property and the connected account\'s permission level for it.',
  },
  {
    name: 'sites.add',
    description:
      'Add a website property to the connected Google account\'s Search Console site set. This does not verify ownership; Google handles ownership verification through a separate Site Verification/Search Console workflow.',
  },
  {
    name: 'sites.delete',
    description:
      "Remove an existing website property from the connected Google account's Search Console site set. This changes that account's Search Console membership for the property; it does not delete the website itself.",
  },
  {
    name: 'analytics.query',
    description:
      'Query Search Console search analytics (impressions, clicks, CTR, average position) over a date range, broken down by query, page, country, device, date, or search appearance. Supports filters and pagination. Google does not guarantee every data row and can return only top rows. The current documented API does not expose a dedicated Generative AI performance-report selector; do not invent one.',
  },
  {
    name: 'insights.page_queries',
    description:
      'For one exact page URL, list the Search Console queries that produced impressions for it, with optional Google-side query_contains topic filtering before bounded pagination, clicks, impressions, CTR, average position, and search type.',
  },
  {
    name: 'insights.query_pages',
    description:
      'For one exact search query, list the site pages that received impressions for it, with optional Google-side page_contains URL-section filtering before bounded pagination, clicks, impressions, CTR, average position, and search type.',
  },
  {
    name: 'urls.inspect',
    description:
      "Inspect Google's indexed version of a single URL: a conservative normalized index-status summary plus Google's raw index status, last crawl, page-fetch/indexing state, canonicals, and rich-results/AMP analysis where available. This is not a live URL test; mobile usability is a deprecated response field. Use urls.inspect_many for 2-10 URLs.",
  },
  {
    name: 'urls.inspect_many',
    description:
      "Inspect Google's indexed versions of up to 10 URLs sequentially, with a conservative normalized index-status summary per successful item and the same URL Inspection safety budget per URL. This does not run live URL tests.",
  },
  {
    name: 'sitemaps.list',
    description:
      'List submitted sitemaps for a property with bounded, deterministic pagination using start_row and limit. Follow result_page.next_start_row while has_more is true.',
  },
  {
    name: 'sitemaps.submit',
    description:
      'Submit a sitemap URL to a Search Console property. A successful API response proves the Search Console submission request succeeded; it does not prove sitemap processing completed or that any page was indexed.',
  },
  {
    name: 'sitemaps.delete',
    description:
      'Remove a submitted sitemap from a Search Console property. This removes the Search Console sitemap entry; it does not delete the remotely hosted sitemap file or prove that any page was deindexed.',
  },
  {
    name: 'sitemaps.get',
    description:
      'Get status and details of a single sitemap submitted to Google Search Console.',
  },
  {
    name: 'insights.quick_wins',
    description:
      'Find observed query/page rows meeting an impression threshold and configurable average-position opportunity range (8-20 by default), optionally scoped at Google by page_contains URL section, query_contains topic and country (ISO alpha-3 searcher country) before pagination. Average position is not a literal current rank, CTR is context rather than an eligibility filter, and scoped rows are not property-wide totals.',
  },
  {
    name: 'insights.cannibalization',
    description:
      'Analyze query/page Search Analytics for queries surfaced by multiple pages, optionally scoped at Google by query_contains topic and page_contains URL section before pagination. Candidate totals and impression shares concern observed rows, not true property-wide query totals.',
  },
  {
    name: 'insights.content_decay',
    description:
      'Assess page-level click declines across two contiguous periods, optionally scoped at Google by query_contains topic, page_contains URL section and country (ISO alpha-3 searcher location, not page language) in both periods and by Web, Image, Video or News-tab search. Compare pages returned in both responses; one-sided row absence is not zero traffic.',
  },
  {
    name: 'indexing.request',
    description:
      'Request an eligible JobPosting or livestream URL update through Google\'s restricted Indexing API; this is not a general webpage submission tool. Google documents a default quota of 200 publish requests/day/project; eligible content restrictions, project permissions, quota limits, and spam screening still apply.',
  },
  {
    name: 'indexing.remove',
    description:
      "Request a URL_DELETED notification for a previously eligible JobPosting or livestream URL through Google's restricted Indexing API. The URL must already return HTTP 404/410 or expose a robots noindex meta directive; notification receipt does not prove removal completed.",
  },
  {
    name: 'indexing.status',
    description:
      'Read the latest successful Indexing API update/remove notifications Google received for a previously submitted URL. This reports notification receipt only, not crawl, index coverage, indexing completion, or removal completion.',
  },
  {
    name: 'indexing.list_pages',
    description: SEARCH_VISIBLE_PAGES_DESCRIPTION,
  },
  {
    name: 'analytics.compare',
    description:
      'Compare Search Console performance metrics between two date ranges for dimension keys returned in both Search Analytics responses; one-sided row absence is not treated as zero. The same search type, optional finalized/all data state, and filters are applied to both periods.',
  },
  {
    name: 'reports.weekly_digest',
    description:
      'Generate a plain-language weekly Search Console report for Web (default), Image, Video or Google Search News-tab performance using search_type, optionally scoped by page_contains URL section, device (desktop, mobile or tablet), query_contains topic, and country (ISO 3166-1 alpha-3). Scoped reports are not all-device or property-wide totals.',
  },
  {
    name: 'server.capabilities',
    description:
      "List every tool this server exposes and report local Google credential state. A connected status means a stored refresh credential is present; it is not a live Google authorization check.",
  },
] as const;

class GscMcpRuntime {
  server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

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
    units = getToolRateLimitUnits(toolName),
    displayName: string = toolName,
  ) {
    const result = await enforceToolRateLimit(this.env, googleId, toolName, units);
    if (result.allowed) return null;

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((result.retry_after_ms ?? 0) / 1000),
    );
    return toolError(
      `Rate limit reached for ${displayName}. Retry after ${retryAfterSeconds} seconds.`,
    );
  }

  private async reserveUrlInspectionRetry(googleId: string): Promise<void> {
    const result = await enforceToolRateLimit(this.env, googleId, 'urls.inspect', 1);
    if (!result.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil((result.retry_after_ms ?? 0) / 1000));
      throw new Error(`URL Inspection retry budget exhausted. Retry after ${retryAfterSeconds} seconds.`);
    }
  }

  private async reserveSearchAnalyticsRetry(googleId: string): Promise<void> {
    const result = await enforceToolRateLimit(this.env, googleId, 'analytics.query', 1);
    if (!result.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil((result.retry_after_ms ?? 0) / 1000));
      throw new Error(`Search Analytics retry budget exhausted. Retry after ${retryAfterSeconds} seconds.`);
    }
  }

  private async reserveMetadataReadRetry(googleId: string): Promise<void> {
    // All four metadata tools share the same per-user rate-limit category.
    const result = await enforceToolRateLimit(this.env, googleId, 'sites.list', 1);
    if (!result.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil((result.retry_after_ms ?? 0) / 1000));
      throw new Error(`Search Console metadata retry budget exhausted. Retry after ${retryAfterSeconds} seconds.`);
    }
  }

  private async reserveIndexingMetadataRetry(googleId: string): Promise<void> {
    // Indexing API receipt lookups have both per-user and project-level limits.
    const result = await enforceToolRateLimit(this.env, googleId, 'indexing.status', 1);
    if (!result.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil((result.retry_after_ms ?? 0) / 1000));
      throw new Error(`Indexing metadata retry budget exhausted. Retry after ${retryAfterSeconds} seconds.`);
    }
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
          "List every tool this server exposes, its configured access mode, and local Google credential state. Call this first if you're unsure what tools are available, whether the deployment is read-only, or whether stored Google credentials are configured. auth_status='connected' means a stored refresh credential is present; this tool does not make a Google token/API request and therefore does not live-verify that Google still accepts it. Takes no arguments.",
        inputSchema: {},
        outputSchema: CAPABILITIES_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async () => {
        let authStatus: 'connected' | 'not_connected' | 'unknown';
        let authStatusBasis:
          | 'stored_refresh_token'
          | 'no_stored_refresh_token'
          | 'local_state_unavailable';
        try {
          const googleId = this.props?.google_id;
          if (!googleId) {
            authStatus = 'not_connected';
            authStatusBasis = 'no_stored_refresh_token';
          } else {
            const refreshToken = await getDecryptedRefreshToken(
              this.env,
              googleId,
            );
            authStatus = refreshToken ? 'connected' : 'not_connected';
            authStatusBasis = refreshToken
              ? 'stored_refresh_token'
              : 'no_stored_refresh_token';
          }
        } catch {
          authStatus = 'unknown';
          authStatusBasis = 'local_state_unavailable';
        }
        const authNote = authStatus === 'connected'
          ? "Stored Google refresh credentials are present, but server.capabilities does not live-verify them with Google. Refresh tokens can expire or be revoked; a Google tool call may still require reconnection."
          : authStatus === 'not_connected'
            ? 'No stored Google refresh credential is available. Reconnect this server in your MCP client to sign in with Google.'
            : 'Local Google credential state could not be read. Provider authorization was not checked.';
        const capabilities = {
          server: SERVER_NAME,
          version: SERVER_VERSION,
          access_mode: accessMode,
          auth_status: authStatus,
          auth_status_basis: authStatusBasis,
          provider_auth_live_verified: false as const,
          auth_note: authNote,
          tools: getToolCatalogForAccessMode(TOOL_CATALOG, accessMode),
          provider_limits: {
            generative_ai_performance_report: {
              dedicated_api_supported: false as const,
              note: GENERATIVE_AI_REPORT_API_NOTE,
            },
          },
          hint: authStatus === 'connected'
            ? 'Stored Google credentials are configured. If a Google tool later reports revoked access, reconnect this server in your MCP client.'
            : 'Reconnect this server in your MCP client to sign in with Google.',
        };
        return toolResponse(JSON.stringify(capabilities, null, 2), capabilities);
      },
    );

    this.server.registerTool(
      'sites.list',
      {
        title: 'List Search Console properties',
        description:
          "List the Google Search Console properties (sites) the connected Google account has access to, ordered by siteUrl. Each entry preserves Google's siteUrl and permissionLevel, derives verification_state plus owner, and adds api_identifier_kind plus mcp_site_url_accepted. The response is bounded by limit/start_row and encoded bytes; follow result_page.next_start_row while has_more is true. The first text content remains a JSON array for older clients; structuredContent.result_page contains continuation metadata. Treat verification_state='unverified' as not ready for normal property-scoped workflows; owner=true is required for restricted Indexing API workflows. Undocumented platform-property identifiers are preserved but marked unsupported.",
        inputSchema: {
          start_row: RESULT_START_ROW_SCHEMA,
          limit: COLLECTION_LIST_LIMIT_SCHEMA,
        },
        outputSchema: SITES_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ start_row = 0, limit = 100 }) => {
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'sites.list');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        const sites = (await listSites(
          accessToken,
          () => this.reserveMetadataReadRetry(googleId),
        )).map((site) => {
          const apiIdentifierKind = classifySearchConsolePropertyIdentifier(site.siteUrl);
          const mcpSiteUrlAccepted = apiIdentifierKind !== 'undocumented';
          return {
            ...site,
            ...sitePermissionState(site.permissionLevel),
            api_identifier_kind: apiIdentifierKind,
            mcp_site_url_accepted: mcpSiteUrlAccepted,
            ...(!mcpSiteUrlAccepted
              ? { unsupported_reason: PLATFORM_PROPERTY_API_NOTE }
              : {}),
          };
        }).sort((a, b) => a.siteUrl < b.siteUrl ? -1 : a.siteUrl > b.siteUrl ? 1 : 0);
        const bounded = windowKnownResults(
          sites, start_row, limit, COLLECTION_LIST_BYTE_BUDGET,
        );
        if (bounded.resultPage.byte_limit_reached && bounded.items.length === 0) {
          return toolError('A single Search Console property entry exceeds the response byte limit. Use sites.get for a known property identifier.');
        }
        const payload = { sites: bounded.items, result_page: bounded.resultPage };
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(payload.sites) },
            { type: 'text' as const, text: JSON.stringify({ result_page: payload.result_page }) },
          ],
          structuredContent: payload,
        };
      },
    );

    this.server.registerTool(
      'sites.get',
      {
        title: 'Get Search Console property',
        description:
          "Retrieve one exact Google Search Console property and its connected-account access state. The response preserves Google's permissionLevel and derives verification_state plus owner so callers can distinguish an unverified property and recognize owner-only Indexing API prerequisites without listing every property first.",
        inputSchema: {
          site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA,
        },
        outputSchema: SITE_DETAIL_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url }) => {
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'sites.get');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        const site = await getSite(
          accessToken,
          site_url,
          () => this.reserveMetadataReadRetry(googleId),
        );
        const siteWithPermissionState = {
          ...site,
          ...sitePermissionState(site.permissionLevel),
        };
        return toolResponse(JSON.stringify(siteWithPermissionState, null, 2), {
          site: siteWithPermissionState,
        });
      },
    );

    this.server.registerTool(
      'urls.inspect',
      {
        title: 'Inspect URL index status',
        description: `Inspect the version of a single URL currently known in Google's index. Returns a conservative normalized index-status summary alongside Google's raw index-status analysis, last crawl, page-fetch/indexing state, canonicals, and rich-results/AMP analysis where the bounded response budget permits. inspection_result_omitted marks oversized raw details; indexed_state is preserved even when optional status descriptions are omitted. This API does not test the live URL or prove current live-page indexability, and its mobile-usability result is deprecated. Use this when the user asks 'is X indexed?' or wants Google's indexed-state evidence for one page. For a bounded group of 2-10 URLs, prefer urls.inspect_many; Google still processes one URL Inspection request per URL and applies the same quota semantics.`,
        inputSchema: {
          site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA,
          inspection_url: z
            .string()
            .describe(
              'The fully-qualified URL to inspect. Must belong to the site_url property: same domain for sc-domain properties, same URL prefix for URL-prefix properties.',
            ),
          language_code: URL_INSPECTION_LANGUAGE_CODE_SCHEMA,
        },
        outputSchema: INSPECTION_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, inspection_url, language_code }) => {
        const googleId = this.requireGoogleId();
        assertUrlWithinSearchConsoleProperty(
          inspection_url,
          site_url,
          'inspection_url',
        );
        const rateLimitError = await this.rateLimitError(googleId, 'urls.inspect');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        const result = await inspectUrl(
          accessToken,
          site_url,
          inspection_url,
          language_code,
          () => this.reserveUrlInspectionRetry(googleId),
        );
        const indexStatusSummary = summarizeUrlInspectionIndexStatus(result);
        // Share the batch output budget and compaction rules so oversized raw
        // Google details cannot flood the single-URL MCP response either.
        const bounded = boundInspectionBatchPayload([{
          inspection_url,
          inspection_result: result,
          index_status_summary: indexStatusSummary,
        }]).results[0];
        const payload = {
          ...(bounded.inspection_result !== undefined
            ? { inspection_result: bounded.inspection_result }
            : {}),
          index_status_summary: bounded.index_status_summary ?? indexStatusSummary,
          ...(bounded.inspection_result_omitted ? { inspection_result_omitted: true } : {}),
          ...(bounded.summary_fields_omitted ? { summary_fields_omitted: true } : {}),
          note: URL_INSPECTION_SCOPE_NOTE,
        };
        return toolResponse(JSON.stringify(payload), payload);
      },
    );

    this.server.registerTool(
      'urls.inspect_many',
      {
        title: 'Inspect multiple URLs',
        description: `Inspect the versions of up to 10 URLs currently known in Google's index from one Search Console property. Each successful item includes a normalized index-status summary, and index_status_counts totals indexed/not_indexed/unknown results among successful inspections only (not property-wide coverage); failed requests are reported separately. Raw Google details are included when the bounded response budget allows, otherwise inspection_result_omitted marks the affected item. This API does not run live URL tests. Each URL reserves one initial unit of the shared URL-inspection safety budget; transient Google retries reserve an additional unit per attempt before calling Google again. Requests inspect URLs sequentially and preserve input order; a Google-access revocation prevents any subsequent inspection from starting. Use this for a small group of important or debugging-target URLs; do not use it to crawl an entire site.`,
        inputSchema: {
          site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA,
          inspection_urls: z
            .array(z.string().url())
            .min(1)
            .max(10)
            .refine((urls) => new Set(urls).size === urls.length, {
              message: 'inspection_urls must not contain duplicate URLs.',
            })
            .describe(
              'Between 1 and 10 unique fully-qualified URLs to inspect. Each URL must belong to the site_url property.',
            ),
          language_code: URL_INSPECTION_LANGUAGE_CODE_SCHEMA,
        },
        outputSchema: INSPECTION_BATCH_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, inspection_urls, language_code }) => {
        const googleId = this.requireGoogleId();
        for (const inspectionUrl of inspection_urls) {
          assertUrlWithinSearchConsoleProperty(
            inspectionUrl,
            site_url,
            'inspection_url',
          );
        }
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
          () => this.reserveUrlInspectionRetry(googleId),
        );
        const results = batchResults.map((result) => ({
          inspection_url: result.inspectionUrl,
          ...(result.inspectionResult !== undefined
            ? {
                inspection_result: result.inspectionResult,
                index_status_summary: summarizeUrlInspectionIndexStatus(
                  result.inspectionResult,
                ),
              }
            : {}),
          ...(result.error !== undefined ? { error: result.error } : {}),
        }));

        const payload = boundInspectionBatchPayload(results);
        return toolResponse(JSON.stringify(payload), payload);
      },
    );

    this.server.registerTool(
      'sitemaps.list',
      {
        title: 'List submitted sitemaps',
        description:
          'List sitemaps submitted for a Search Console property, sorted by sitemap path and bounded by limit/start_row plus output bytes. Follow result_page.next_start_row while has_more is true. Optionally filter to entries included by one sitemap index. Returns sitemap URLs, provider-reported submission/download timestamps, submitted URL counts, warning and error counts, and sitemap status. lastSubmitted is the Search Console submission time; lastDownloaded is when Google downloaded the sitemap, not page crawl/indexing time. Google\'s deprecated indexed count is intentionally omitted.',
        inputSchema: {
          site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA,
          sitemap_index: SITEMAP_URL_SCHEMA
            .optional()
            .describe(
              'Optional sitemap index URL. When supplied, Google returns sitemap entries included in that index.',
            ),
          start_row: RESULT_START_ROW_SCHEMA,
          limit: COLLECTION_LIST_LIMIT_SCHEMA,
        },
        outputSchema: SITEMAPS_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, sitemap_index, start_row = 0, limit = 100 }) => {
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'sitemaps.list');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        const sitemaps = (await listSitemaps(
          accessToken,
          site_url,
          sitemap_index,
          () => this.reserveMetadataReadRetry(googleId),
        ))
          .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        const bounded = windowKnownResults(
          sitemaps, start_row, limit, COLLECTION_LIST_BYTE_BUDGET,
        );
        if (bounded.resultPage.byte_limit_reached && bounded.items.length === 0) {
          return toolError('A single sitemap entry exceeds the response byte limit. Use sitemaps.get with its known feedpath for individual status.');
        }
        const payload = {
          sitemaps: bounded.items,
          provider_note: SITEMAP_PROVIDER_NOTE,
          result_page: bounded.resultPage,
        };
        return toolResponse(JSON.stringify(payload), payload);
      },
    );

    this.server.registerTool(
      'analytics.query',
      {
        title: 'Query search analytics',
        description: [
          'Query Google Search Console search analytics data. Returns',
          '{ row_count, start_row, rows, dimensions, search_type,',
          '  provider_exhaustiveness_guaranteed, provider_note, has_more,',
          '  truncated, byte_limit_reached }',
          'where dimensioned rows have keys plus clicks, impressions, ctr, and',
          'position. The echoed dimensions array labels rows[].keys in order,',
          'so saved or forwarded responses remain self-describing. Aggregate',
          'rows from dimensions: [] may omit keys because',
          'Google itself omits that field. When has_more is true, the response',
          'includes next_start_row — pass it back as start_row to fetch the next',
          'safe page. Large requested row_limit values are automatically split',
          'into bounded MCP responses rather than failing structured output.',
          'Google does not guarantee that Search Analytics exposes every data',
          'row; it can return only top rows. Local has_more/pagination fields',
          'therefore describe this server\'s fetch window, not provider-level',
          'exhaustiveness.',
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
          '- DATA FRESHNESS: data_state "all" can include fresh preliminary',
          '  data instead of imposing the finalized-data lag; "final" returns',
          '  only finalized data and can therefore lag recent activity. When',
          '  Google returns metadata.first_incomplete_date or',
          '  metadata.first_incomplete_hour for date/hour groupings, treat',
          '  that boundary and later rows as still subject to change. The',
          '  response also echoes data_state and preliminary_data_possible.',
          '- AVERAGE POSITION is impression-weighted. To compute an overall',
          '  position across multiple rows, use',
          '  sum(position * impressions) / sum(impressions). Never plain-average',
          '  the position column across rows.',
          '- CTR in the response is a 0–1 fraction. Multiply by 100 for percent.',
          '- Use search_type to query image/video/news/discover indexes',
          '  separately from web.',
          '- Google Discover and Google News do not support query grouping/',
          '  filtering or average position. For those surfaces, use page/',
          '  country/device/date/searchAppearance dimensions and interpret',
          '  clicks, impressions, and CTR; query dimensions/filters are',
          '  rejected before the API call.',
          '- News Showcase panel reporting: set aggregation_type to',
          '  "byNewsShowcasePanel", use search_type "discover" or',
          '  "googleNews", and include a searchAppearance equals',
          '  "NEWS_SHOWCASE" filter. Do not group/filter by page or add',
          '  another searchAppearance filter for that aggregation mode.',
          '- For hourly breakdowns, include "hour" in dimensions and set',
          '  data_state to "hourly_all". The hourly date range can span at',
          '  most 10 inclusive days, and hourly data',
          '  is preliminary.',
          '- SEARCH APPEARANCE uses a two-step workflow. To discover the',
          '  property-specific appearance values Google currently exposes,',
          '  call with dimensions: ["searchAppearance"] and no other grouping',
          '  dimension. Then filter to one exact returned searchAppearance',
          '  value in a separate query and group by page/query/country/device/',
          '  date/hour as needed. Do not guess new appearance identifiers;',
          '  discover the values Google returns for the property first.',
          '- GENERATIVE AI REPORT: Search Console now has dedicated',
          '  Generative AI performance reports in its UI, but the current',
          '  documented Search Analytics API exposes no dedicated Generative',
          '  AI search type or filter selector. AI Overviews and AI Mode remain',
          '  included in overall web Search performance data. Do not guess a',
          '  searchAppearance identifier or claim analytics.query isolates the',
          '  dedicated Generative AI report.',
          '- WEB MULTIMODAL REPORT: Search Console now has a web multimodal',
          '  performance filter in its UI for searches such as Lens, Circle to',
          '  Search, image uploads, and Chrome image search. The current',
          '  documented Search Analytics API still exposes only web, image,',
          '  video, news, discover, and googleNews search types, with no',
          '  multimodal selector. Do not pass search_type="multimodal" or guess',
          '  a searchAppearance identifier to isolate this UI report.',
          '- Use dimension_filter_groups to filter by country, device, query',
          '  content, page URL, or search feature. includingRegex and',
          '  excludingRegex use RE2 syntax. A query regex can provide a manual',
          '  brand/non-brand approximation when the caller supplies the brand',
          "  pattern. It is not equivalent to Search Console's native Branded/",
          '  Non-branded filter: Google describes that classification as',
          '  AI-assisted (including language variants, typos, and associated',
          '  products/services), and the Search Analytics API does not expose',
          '  that native classifier as a filter.',
          "- data_state defaults to 'all' which matches the GSC dashboard.",
          "  Pass 'final' only when the user explicitly asks for stable,",
          '  non-preliminary data.',
        ].join('\n'),
        inputSchema: {
          site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA,
          start_date: SEARCH_CONSOLE_DATE_SCHEMA.describe(
            searchConsoleDateDescription('Start date (inclusive) in YYYY-MM-DD format.'),
          ),
          end_date: SEARCH_CONSOLE_DATE_SCHEMA.describe(
            searchConsoleDateDescription(
              'End date (inclusive) in YYYY-MM-DD format. Recent dates are allowed: data_state all/hourly_all can include preliminary data, while final returns only finalized data.',
            ),
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
            .superRefine((dimensions, ctx) => {
              if (new Set(dimensions).size !== dimensions.length) {
                ctx.addIssue({
                  code: 'custom',
                  message: 'Search Analytics dimensions must not contain duplicates.',
                });
              }
              if (dimensions.includes('searchAppearance') && dimensions.length > 1) {
                ctx.addIssue({
                  code: 'custom',
                  message: 'Search Analytics searchAppearance must be the only grouping dimension.',
                });
              }
            })
            .default(['query'])
            .describe(
              "Dimensions to group rows by. Pass [] (empty array) to get a single row of true site-level totals. searchAppearance must be the only grouping dimension; discover an appearance value with ['searchAppearance'], then filter to that value in a separate query when grouping by another dimension. The 'hour' dimension requires data_state 'hourly_all' and an inclusive date range of at most 10 days. Google Discover and Google News do not support the query dimension.",
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
          start_row: SEARCH_ANALYTICS_START_ROW_SCHEMA
            .default(0)
            .describe(
              'Zero-based row offset for pagination (0 through 2147483647). When a response contains next_start_row, pass it here to fetch the next page.',
            ),
          data_state: z
            .enum(['all', 'final', 'hourly_all'])
            .default('all')
            .describe(
              "'all' includes fresh (preliminary) data and matches the GSC dashboard; 'final' returns only finalized data; 'hourly_all' includes hourly preliminary data and must be used when grouping by the 'hour' dimension. Hour-grouped requests can span at most 10 inclusive days.",
            ),
          search_type: z
            .enum(['web', 'image', 'video', 'news', 'discover', 'googleNews'])
            .default('web')
            .describe('Which documented Search Analytics search index to query. Defaults to web. Google Discover and Google News do not support query grouping/filtering or average position. The current API does not expose a dedicated Generative AI performance-report search type or the Search Console UI web multimodal filter as a search type.'),
          aggregation_type: z
            .enum(['auto', 'byNewsShowcasePanel', 'byPage', 'byProperty'])
            .default('auto')
            .describe(
              "How Google aggregates metrics. Leave as 'auto' unless specific semantics are needed. When grouping/filtering by page, use 'auto'; explicit 'byPage' and 'byProperty' are rejected for that request shape. 'byProperty' is also unavailable for search_type discover/googleNews. 'byNewsShowcasePanel' requires search_type discover/googleNews plus a searchAppearance equals NEWS_SHOWCASE filter, and cannot be combined with page grouping/filtering or another searchAppearance filter.",
            ),
          dimension_filter_groups: z
            .array(SEARCH_ANALYTICS_FILTER_GROUP_SCHEMA)
            .optional()
            .describe(
              "Optional filters ANDed together, e.g. [{ groupType: 'and', filters: [{ dimension: 'country', expression: 'usa' }] }]. Filter operator defaults to 'equals' when omitted, matching Search Console. Expressions are limited to 4096 characters. Countries use ISO 3166-1 alpha-3 codes. Query filters are not supported when search_type is discover or googleNews.",
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
        assertDateNotInFuture(
          end_date,
          getSearchConsoleCalendarDate(),
          'end_date',
        );
        const sourceRowLimit = Math.min(row_limit, MAX_DIRECT_SOURCE_ROWS);
        const query = {
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
        };
        assertSearchAnalyticsQueryCompatible(query);
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'analytics.query');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        const response = await querySearchAnalytics(
          accessToken, site_url, query,
          () => this.reserveSearchAnalyticsRetry(googleId),
        );
        // Google documents a short page as terminal. An exactly full page can
        // still have a following page, so expose continuation only then.
        const sourceMayHaveMore =
          dimensions.length > 0 && response.rows.length === sourceRowLimit;
        const bounded = windowSourceRows(
          response.rows,
          start_row,
          row_limit,
          sourceMayHaveMore,
          start_row + sourceRowLimit,
        );
        const payload: Record<string, unknown> = {
          row_count: bounded.items.length,
          start_row,
          rows: bounded.items,
          dimensions,
          search_type,
          data_state,
          preliminary_data_possible: data_state !== 'final',
          position_supported:
            search_type !== 'discover' && search_type !== 'googleNews',
          ...(search_type === 'discover' || search_type === 'googleNews'
            ? {
                position_note:
                  `${search_type === 'discover' ? 'Google Discover' : 'Google News'} does not support average position. Do not interpret rows[].position for search_type='${search_type}'.`,
              }
            : {}),
          provider_exhaustiveness_guaranteed: false,
          provider_note: SEARCH_ANALYTICS_PROVIDER_NOTE,
          generative_ai_report_isolatable: false,
          generative_ai_note: GENERATIVE_AI_REPORT_API_NOTE,
          multimodal_report_isolatable: false,
          multimodal_note: MULTIMODAL_REPORT_API_NOTE,
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
        description: 'For one exact page URL within the supplied Search Console property, return the queries that produced impressions for it over a date range. This wraps an exact page dimension filter so agents do not need to construct analytics.query filter groups manually. Optional query_contains narrows query topics at Google before source pagination; these observed rows are not all queries for the page. Exact page matching is case-sensitive in Search Console. Use row_limit and start_row to page through bounded results; Search Console can still omit anonymized queries. Google Discover and Google News are intentionally unavailable because those reports do not expose query data.',
        inputSchema: {
          site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA,
          page_url: z.string().url().describe('Exact fully-qualified page URL to filter on, e.g. https://example.com/guides/seo/. The URL must belong to site_url; Search Console exact page filters are case-sensitive.'),
          query_contains: z.string().trim().min(1).max(240).optional().describe('Optional case-insensitive query substring (e.g. seo) to filter at Google before pagination. Omit for all query topics.'),
          start_date: SEARCH_CONSOLE_DATE_SCHEMA.describe(
            searchConsoleDateDescription('Start date (inclusive) in YYYY-MM-DD format.'),
          ),
          end_date: SEARCH_CONSOLE_DATE_SCHEMA.describe(
            searchConsoleDateDescription(
              'End date (inclusive) in YYYY-MM-DD format. Note the 2-3 day GSC data lag.',
            ),
          ),
          search_type: z
            .enum(['web', 'image', 'video', 'news'])
            .default('web')
            .describe('Which search index to query. Defaults to web. Discover and Google News are not supported because this tool groups by query.'),
          row_limit: z
            .number()
            .int()
            .min(1)
            .max(25000)
            .default(100)
            .describe('Maximum query rows requested for this response. Continue with result_page.next_start_row while result_page.has_more is true.'),
          start_row: SEARCH_ANALYTICS_START_ROW_SCHEMA
            .default(0)
            .describe('Zero-based Search Analytics row offset for pagination (0 through 2147483647).'),
        },
        outputSchema: PAGE_QUERIES_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, page_url, query_contains, start_date, end_date, search_type, row_limit = 100, start_row = 0 }) => {
        assertDateRange(start_date, end_date);
        assertDateNotInFuture(
          end_date,
          getSearchConsoleCalendarDate(),
          'end_date',
        );
        assertUrlWithinSearchConsoleProperty(page_url, site_url, 'page_url');
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
                ...(query_contains ? [{ dimension: 'query' as const, operator: 'contains' as const, expression: query_contains }] : []),
              ],
            },
          ],
        }, {
          maxRows: sourceRowLimit,
          beforeRetry: () => this.reserveSearchAnalyticsRetry(googleId),
        });
        const rows = mapSourceRows(source.rows, (row) =>
          (row.keys?.length ?? 0) > 0 && hasRecordedPosition(row) ? ({
            query: row.keys![0],
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
          }) : undefined);
        const bounded = windowSourceRows(
          rows.items,
          start_row,
          row_limit,
          source.localLimitReached,
          start_row + source.rows.length,
          rows.sourceRowOffsets,
        );
        const payload = {
          page: page_url,
          query_contains: query_contains ?? null,
          scope_note: query_contains
            ? 'Queries are filtered to the requested case-insensitive topic substring at Google before pagination; these are not all queries for this page, and missing rows do not mean zero impressions.'
            : 'Observed page/query rows may be incomplete because Search Console can omit or truncate data; missing rows do not mean zero impressions.',
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
        description: 'For one exact search query, return the site pages that received impressions for it over a date range. This wraps an exact query dimension filter so agents do not need to construct analytics.query filter groups manually. Optional page_contains scopes matching page URLs at Google before source pagination, for example /de/; filtered rows are not property-wide. Exact query matching is case-sensitive in Search Console. Use row_limit and start_row to page through bounded results and verify which URL Google is surfacing before diagnosing cannibalization or content targeting. Google Discover and Google News are intentionally unavailable because those reports do not expose query data.',
        inputSchema: {
          site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA,
          query: z.string().min(1).describe('Exact Search Console query text to filter on. Exact query filters are case-sensitive.'),
          page_contains: z.string().trim().min(1).max(240).optional().describe('Optional case-insensitive substring of page URLs to filter at Google before pagination, such as /de/. Omit for all pages.'),
          start_date: SEARCH_CONSOLE_DATE_SCHEMA.describe(
            searchConsoleDateDescription('Start date (inclusive) in YYYY-MM-DD format.'),
          ),
          end_date: SEARCH_CONSOLE_DATE_SCHEMA.describe(
            searchConsoleDateDescription(
              'End date (inclusive) in YYYY-MM-DD format. Note the 2-3 day GSC data lag.',
            ),
          ),
          search_type: z
            .enum(['web', 'image', 'video', 'news'])
            .default('web')
            .describe('Which search index to query. Defaults to web. Discover and Google News are not supported because this tool filters by query.'),
          row_limit: z
            .number()
            .int()
            .min(1)
            .max(25000)
            .default(100)
            .describe('Maximum page rows requested for this response. Continue with result_page.next_start_row while result_page.has_more is true.'),
          start_row: SEARCH_ANALYTICS_START_ROW_SCHEMA
            .default(0)
            .describe('Zero-based Search Analytics row offset for pagination (0 through 2147483647).'),
        },
        outputSchema: QUERY_PAGES_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, query, page_contains, start_date, end_date, search_type, row_limit = 100, start_row = 0 }) => {
        assertDateRange(start_date, end_date);
        assertDateNotInFuture(
          end_date,
          getSearchConsoleCalendarDate(),
          'end_date',
        );
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
                ...(page_contains ? [{ dimension: 'page' as const, operator: 'contains' as const, expression: page_contains }] : []),
              ],
            },
          ],
        }, {
          maxRows: sourceRowLimit,
          beforeRetry: () => this.reserveSearchAnalyticsRetry(googleId),
        });
        const rows = mapSourceRows(source.rows, (row) =>
          (row.keys?.length ?? 0) > 0 && hasRecordedPosition(row) ? ({
            page: row.keys![0],
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
          }) : undefined);
        const bounded = windowSourceRows(
          rows.items,
          start_row,
          row_limit,
          source.localLimitReached,
          start_row + source.rows.length,
          rows.sourceRowOffsets,
        );
        const payload = {
          query,
          page_contains: page_contains ?? null,
          scope_note: page_contains
            ? 'Pages are filtered to the requested URL substring at Google before pagination; observed rows are not property-wide, and absent rows are not evidence of zero impressions.'
            : 'Observed query/page rows may be incomplete because Search Console can omit or truncate data; absent rows are not evidence of zero impressions.',
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
        description: 'Add a website property to the connected Google account\'s Search Console site set. This does not verify ownership. Domain properties require an sc-domain prefix (e.g., sc-domain:example.com); URL-prefix properties require a full URL (e.g., https://example.com/).',
        inputSchema: {
          site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA,
        },
        outputSchema: SITE_ADD_OUTPUT_SCHEMA,
        annotations: WRITE_TOOL_ANNOTATIONS['sites.add'],
      },
      async ({ site_url }) => {
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'sites.add');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        await addSite(accessToken, site_url);
        const message = `Successfully added site property: ${site_url}`;
        const payload = {
          message,
          ownership_verification_performed: false as const,
          ownership_verification_note: SITE_ADD_VERIFICATION_NOTE,
        };
        return toolResponse(`${message}\n\n${SITE_ADD_VERIFICATION_NOTE}`, payload);
      },
    );

      this.server.registerTool(
      'sites.delete',
      {
        title: 'Remove Search Console property from account',
        description: "Remove an existing website property from the connected Google account's Search Console site set. Google documents this operation as removing the site from the user's Search Console sites; it does not delete website content.",
        inputSchema: {
          site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA,
        },
        outputSchema: SITE_DELETE_OUTPUT_SCHEMA,
        annotations: WRITE_TOOL_ANNOTATIONS['sites.delete'],
      },
      async ({ site_url }) => {
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'sites.delete');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        await deleteSite(accessToken, site_url);
        const message = `Successfully removed site property from the connected account's Search Console site set: ${site_url}`;
        const payload = {
          message,
          removed_from_connected_account_site_set: true as const,
          website_content_deleted: false as const,
          provider_scope_note: "Google's Sites.delete method removes the property from the connected user's Search Console site set. It does not delete the website itself.",
        };
        return toolResponse(`${message}\n\n${payload.provider_scope_note}`, payload);
      },
    );

      this.server.registerTool(
      'sitemaps.submit',
      {
        title: 'Submit sitemap',
        description: 'Submit a sitemap URL to a Search Console property. A successful API response means the Search Console submission request succeeded; it does not prove sitemap processing completed or that any page was indexed.',
        inputSchema: {
          site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA,
          feedpath: SITEMAP_URL_SCHEMA.describe('The full HTTP/HTTPS URL of the sitemap file to submit, e.g. https://example.com/sitemap.xml'),
        },
        outputSchema: SITEMAP_SUBMIT_OUTPUT_SCHEMA,
        annotations: WRITE_TOOL_ANNOTATIONS['sitemaps.submit'],
      },
      async ({ site_url, feedpath }) => {
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'sitemaps.submit');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        await submitSitemap(accessToken, site_url, feedpath);
        const message = `Successfully submitted sitemap to Search Console: ${feedpath} for site: ${site_url}`;
        const payload = {
          message,
          submitted_to_search_console: true as const,
          sitemap_processing_completion_proven: false as const,
          page_indexing_proven: false as const,
          provider_scope_note: "Google's Sitemaps.submit method returns an empty body on success. That success confirms the Search Console submission operation, not completed sitemap processing or page indexing.",
        };
        return toolResponse(`${message}\n\n${payload.provider_scope_note}`, payload);
      },
    );

      this.server.registerTool(
      'sitemaps.delete',
      {
        title: 'Delete sitemap',
        description: 'Remove a submitted sitemap from a Search Console property. This removes the Search Console sitemap entry; it does not delete the remotely hosted sitemap file or prove that any page was deindexed.',
        inputSchema: {
          site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA,
          feedpath: SITEMAP_URL_SCHEMA.describe('The full HTTP/HTTPS URL of the sitemap file to delete, e.g. https://example.com/sitemap.xml'),
        },
        outputSchema: SITEMAP_DELETE_OUTPUT_SCHEMA,
        annotations: WRITE_TOOL_ANNOTATIONS['sitemaps.delete'],
      },
      async ({ site_url, feedpath }) => {
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'sitemaps.delete');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        await deleteSitemap(accessToken, site_url, feedpath);
        const message = `Successfully removed sitemap from Search Console: ${feedpath} for site: ${site_url}`;
        const payload = {
          message,
          removed_from_search_console: true as const,
          sitemap_file_deleted: false as const,
          page_deindexing_proven: false as const,
          provider_scope_note: "Google's Sitemaps.delete method removes the submitted sitemap from the Search Console property. It does not delete the remotely hosted sitemap file or prove that any page was deindexed.",
        };
        return toolResponse(`${message}\n\n${payload.provider_scope_note}`, payload);
      },
      );
    }

    this.server.registerTool(
      'sitemaps.get',
      {
        title: 'Get sitemap details',
        description: 'Get status and details of a single sitemap submitted to Google Search Console. lastSubmitted is when the sitemap was submitted to Search Console; lastDownloaded is when Google last downloaded the sitemap. Neither timestamp is a sitemap-file modification time or a page crawl/indexing time.',
        inputSchema: {
          site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA,
          feedpath: SITEMAP_URL_SCHEMA.describe('The full HTTP/HTTPS URL of the sitemap file, e.g. https://example.com/sitemap.xml'),
        },
        outputSchema: { sitemap: SITEMAP_OUTPUT_SCHEMA, provider_note: z.string() },
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, feedpath }) => {
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'sitemaps.get');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        const details = await getSitemap(
          accessToken,
          site_url,
          feedpath,
          () => this.reserveMetadataReadRetry(googleId),
        );
        const payload = { sitemap: details, provider_note: SITEMAP_PROVIDER_NOTE };
        return toolResponse(JSON.stringify(payload, null, 2), payload);
      },
    );

    this.server.registerTool(
      'insights.quick_wins',
      {
        title: 'Identify SEO Quick Wins',
        description: 'Find observed query/page Search Analytics rows with at least the requested impressions whose average position falls in a configurable opportunity range (8-20 by default). Optional page_contains, query_contains and country (searcher ISO alpha-3, not page language) filter URL sections, query topics and searcher geography together at Google before source pagination. Filtered results are not property-wide. Average position is an aggregate Search Console metric, not a literal current rank; CTR is returned for context and is not an eligibility filter. Results are ordered by impressions and bounded with limit/start_row and explicit result_page metadata. Source pagination flags the local 100,000-row ceiling.',
        inputSchema: createQuickWinsInputSchema(),
        outputSchema: z.object(QUICK_WIN_OUTPUT_SCHEMA),
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, start_date, end_date, min_impressions, min_position, max_position, page_contains, query_contains, country, limit = DEFAULT_ANALYSIS_RESULT_LIMIT, start_row = 0 }) => {
        assertDateRange(start_date, end_date);
        assertDateNotInFuture(
          end_date,
          getSearchConsoleCalendarDate(),
          'end_date',
        );
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'insights.quick_wins');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        const sourceFilters = [
          ...(page_contains ? [{ dimension: 'page' as const, operator: 'contains' as const, expression: page_contains }] : []),
          ...(query_contains ? [{ dimension: 'query' as const, operator: 'contains' as const, expression: query_contains }] : []),
          ...(country ? [{ dimension: 'country' as const, operator: 'equals' as const, expression: country.toUpperCase() }] : []),
        ];
        const source = await querySearchAnalyticsPaginated(accessToken, site_url, {
          startDate: start_date,
          endDate: end_date,
          dimensions: ['query', 'page'],
          ...(sourceFilters.length ? {
            dimensionFilterGroups: [{
              groupType: 'and' as const,
              filters: sourceFilters,
            }],
          } : {}),
        }, { beforeRetry: () => this.reserveSearchAnalyticsRetry(googleId) });

        const quickWins = processQuickWins(source.rows, min_impressions, min_position, max_position);
        const bounded = windowKnownResults(quickWins, start_row, limit);
        const payload = {
          note: 'Candidates are observed query/page rows selected by Search Console average position, not proof of a stable or current rank. CTR is reported for context and does not affect eligibility.',
          page_contains: page_contains ?? null,
          query_contains: query_contains ?? null,
          country: country?.toUpperCase() ?? null,
          scope_note: page_contains || query_contains || country
            ? 'Quick-win opportunities are scoped by Google-side URL section, query topic and/or searcher country filters; results are not property-wide. The searcher country does not identify page language. Missing Search Analytics rows do not mean zero traffic.'
            : 'Quick-win opportunities derive from returned query/page rows, which are not guaranteed exhaustive; missing rows do not mean zero traffic.',
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
        description: 'Analyze query/page Search Analytics to find queries split across multiple pages. Optional page_contains and query_contains filter matching URL sections and query topics at Google before pagination and aggregation, and can be combined in one AND group. Query filtering retains all returned competing pages for matching queries; page filtering restricts observed page shares to that URL scope, not property-wide totals. Candidates are ranked by observed query/page impressions and bounded with limit/start_row. Google may omit rows; sums can exceed true query-level aggregates. Multiple ranking URLs can reflect legitimate locale or intent differences, not harmful cannibalization.',
        inputSchema: {
          site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA,
          start_date: SEARCH_CONSOLE_DATE_SCHEMA.describe(
            searchConsoleDateDescription('Start date (inclusive) in YYYY-MM-DD format.'),
          ),
          end_date: SEARCH_CONSOLE_DATE_SCHEMA.describe(
            searchConsoleDateDescription(
              'End date (inclusive) in YYYY-MM-DD format. Note the 2-3 day GSC data lag.',
            ),
          ),
          min_impressions: CANNIBALIZATION_MIN_IMPRESSIONS_SCHEMA,
          min_page_percentage: CANNIBALIZATION_MIN_PAGE_PERCENTAGE_SCHEMA,
          query_contains: CANNIBALIZATION_QUERY_CONTAINS_SCHEMA,
          page_contains: CANNIBALIZATION_PAGE_CONTAINS_SCHEMA,
          limit: ANALYSIS_RESULT_LIMIT_SCHEMA,
          start_row: RESULT_START_ROW_SCHEMA,
        },
        outputSchema: CANNIBALIZATION_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, start_date, end_date, min_impressions, min_page_percentage, query_contains, page_contains, limit = DEFAULT_ANALYSIS_RESULT_LIMIT, start_row = 0 }) => {
        assertDateRange(start_date, end_date);
        assertDateNotInFuture(
          end_date,
          getSearchConsoleCalendarDate(),
          'end_date',
        );
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'insights.cannibalization');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        const sourceFilters = [
          ...(page_contains ? [{ dimension: 'page' as const, operator: 'contains' as const, expression: page_contains }] : []),
          ...(query_contains ? [{ dimension: 'query' as const, operator: 'contains' as const, expression: query_contains }] : []),
        ];
        const source = await querySearchAnalyticsPaginated(accessToken, site_url, {
          startDate: start_date,
          endDate: end_date,
          dimensions: ['query', 'page'],
          ...(sourceFilters.length ? {
            dimensionFilterGroups: [{
              groupType: 'and' as const,
              filters: sourceFilters,
            }],
          } : {}),
        }, { beforeRetry: () => this.reserveSearchAnalyticsRetry(googleId) });

        const queryFilter = query_contains?.toLowerCase();
        const cannibalizationCandidates = processCannibalization(
          source.rows,
          min_impressions,
          min_page_percentage,
        )
          .filter((candidate) =>
            !queryFilter || candidate.query.toLowerCase().includes(queryFilter)
          )
          .map((candidate) => {
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
          page_contains: page_contains ?? null,
          query_contains: query_contains ?? null,
          scope_note: page_contains || query_contains
            ? 'Candidates and observed impression shares are restricted to Google-filtered query/page rows, not property-wide totals; page_contains restricts which competing URLs are included. Missing Search Analytics rows are not zero.'
            : 'Candidates and observed impression shares use returned query/page rows, not true query-level property totals; missing rows are not zero.',
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
        description: 'Assess page-level click declines across two contiguous periods without treating every small click change as content decay. Optional search_type selects Web (default), Image, Video or News-tab search consistently for both periods; Discover and Google News are excluded from this position-aware heuristic. Compare 1-240 days per period so both periods fit in Search Console\'s 16-month performance history with the three-day finalized-data lag. Optional page_contains, query_contains and country scope both Google Search Analytics requests to a URL section (such as /de/), search topic (such as technical seo), and ISO alpha-3 searcher country (such as DEU for Germany, not page language) using AND before pagination; this changes the comparison population, not property-wide totals. No additional requests are made, and missing rows are never treated as zero. Only pages returned in both Search Analytics period responses are compared; Google does not guarantee every data row. Each result is classified as likely_decay, weak_insufficient_evidence, or improving_visibility_with_click_volatility using deterministic click-volume, impression, and average-position signals. This is a heuristic assessment, not statistical proof. Results are bounded with limit/start_row; source pagination is reported separately.',
        inputSchema: {
          site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA,
          compare_days: CONTENT_DECAY_COMPARE_DAYS_SCHEMA,
          search_type: z.enum(['web', 'image', 'video', 'news']).default('web').describe('Search Console search type applied identically to both comparison periods: web (default), image, video or news (Google Search News tab). Discover and Google News are excluded because this heuristic relies on average position.'),
          page_contains: CONTENT_DECAY_PAGE_CONTAINS_SCHEMA,
          query_contains: CONTENT_DECAY_QUERY_CONTAINS_SCHEMA,
          country: CONTENT_DECAY_COUNTRY_SCHEMA,
          limit: ANALYSIS_RESULT_LIMIT_SCHEMA,
          start_row: RESULT_START_ROW_SCHEMA,
        },
        outputSchema: CONTENT_DECAY_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, compare_days, search_type = 'web', page_contains, query_contains, country, limit = DEFAULT_ANALYSIS_RESULT_LIMIT, start_row = 0 }) => {
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

        const filters = [
          ...(page_contains ? [{ dimension: 'page' as const, operator: 'contains' as const, expression: page_contains }] : []),
          ...(query_contains ? [{ dimension: 'query' as const, operator: 'contains' as const, expression: query_contains }] : []),
          ...(country ? [{ dimension: 'country' as const, operator: 'equals' as const, expression: country.toUpperCase() }] : []),
        ];
        const scopedDimensionFilters = filters.length ? {
          dimensionFilterGroups: [{
            groupType: 'and' as const,
            filters,
          }],
        } : {};

        const recentSource = await querySearchAnalyticsPaginated(accessToken, site_url, {
          startDate: recentStart,
          endDate: recentEnd,
          dimensions: ['page'],
          type: search_type,
          ...scopedDimensionFilters,
        }, { beforeRetry: () => this.reserveSearchAnalyticsRetry(googleId) });

        const previousSource = await querySearchAnalyticsPaginated(accessToken, site_url, {
          startDate: previousStart,
          endDate: previousEnd,
          dimensions: ['page'],
          type: search_type,
          ...scopedDimensionFilters,
        }, { beforeRetry: () => this.reserveSearchAnalyticsRetry(googleId) });

        const pageFilter = page_contains?.toLowerCase();
        const decayResults = processContentDecay(
          recentSource.rows,
          previousSource.rows,
        ).filter((result) =>
          !pageFilter || result.page.toLowerCase().includes(pageFilter)
        );
        const bounded = windowKnownResults(decayResults, start_row, limit);

        const payload = {
          search_type,
          page_contains: page_contains ?? null,
          query_contains: query_contains ?? null,
          country: country?.toUpperCase() ?? null,
          scope_note: page_contains || query_contains || country
            ? 'Both comparison periods contain only Google-filtered matching page URLs, search query topics and/or searcher country (not page language), not property-wide totals. Missing rows are not zero.'
            : 'Both comparison periods use observed property-page rows; missing rows are not zero.',
          comparison_periods: {
            recent: { start: recentStart, end: recentEnd },
            previous: { start: previousStart, end: previousEnd },
          },
          comparison_scope: 'common_returned_rows_only' as const,
          comparison_note: COMMON_RETURNED_ROWS_COMPARISON_NOTE,
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
      'indexing.status',
      {
        title: 'Get Indexing API notification status',
        description: "Read the latest successful Indexing API URL_UPDATED and URL_DELETED notifications Google received for a previously submitted URL within an owner-level Search Console property accessible to the connected Google account. This is a read-only notification-receipt lookup, not an index-coverage report and not proof that Google crawled, indexed, or removed the URL. It is available only in readwrite access mode because Google's metadata endpoint requires the Indexing API OAuth scope.",
        inputSchema: {
          site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA.describe(`${SEARCH_CONSOLE_PROPERTY_DESCRIPTION} The connected Google account must be an owner of this property.`),
          url: z.string().superRefine((value, ctx) => {
            try {
              assertIndexingRequestUrl(value);
            } catch (error) {
              ctx.addIssue({
                code: 'custom',
                message: (error as Error).message,
              });
            }
          }).describe('A fully qualified HTTP/HTTPS URL previously submitted successfully through the Google Indexing API. It must fall within site_url.'),
        },
        outputSchema: INDEXING_STATUS_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, url }) => {
        assertUrlWithinSearchConsoleProperty(url, site_url);
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'indexing.status');
        if (rateLimitError) return rateLimitError;
        // Ownership validation issues an independent Search Console sites.list
        // read, so account for it in that shared per-user metadata budget.
        const sitesRateLimitError = await this.rateLimitError(googleId, 'sites.list');
        if (sitesRateLimitError) return sitesRateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        const sites = await listSites(
          accessToken,
          () => this.reserveMetadataReadRetry(googleId),
        );
        assertIndexingUrlAuthorized(url, site_url, sites);
        const notificationMetadata = await getIndexingNotificationMetadata(
          accessToken,
          url,
          () => this.reserveIndexingMetadataRetry(googleId),
        );
        const payload = {
          notification_metadata: notificationMetadata,
          notification_receipt_only: true as const,
          index_coverage_report: false as const,
          indexing_or_removal_completion_proven: false as const,
          note: "This reports the latest successful Indexing API notification receipt(s) Google recorded for the URL. It does not report whether Google crawled, indexed, or removed the URL; use URL Inspection for indexed-state evidence.",
        };
        return toolResponse(JSON.stringify(payload, null, 2), payload);
      },
      );

      this.server.registerTool(
      'indexing.request',
      {
        title: 'Request Indexing',
        description: "Requests indexing through Google's Indexing API for a URL within an owner-level Search Console property accessible to the connected Google account. Google currently restricts this API to pages containing JobPosting structured data or livestream pages containing BroadcastEvent inside VideoObject. It is not available for general webpage submission. Google documents a default of 200 publish requests/day/project, shared by update and removal notifications. Eligibility, project authorization, quota limits and spam detection still apply; the published default does not authorize higher-volume or ineligible submissions.",
        inputSchema: {
          site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA.describe(`${SEARCH_CONSOLE_PROPERTY_DESCRIPTION} The connected Google account must be an owner of this property.`),
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
        assertUrlWithinSearchConsoleProperty(url, site_url);
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'indexing.request');
        if (rateLimitError) return rateLimitError;
        // Authorization requires an independent Search Console sites.list read.
        const sitesRateLimitError = await this.rateLimitError(googleId, 'sites.list');
        if (sitesRateLimitError) return sitesRateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        const sites = await listSites(
          accessToken,
          () => this.reserveMetadataReadRetry(googleId),
        );
        assertIndexingUrlAuthorized(url, site_url, sites);
        const result = await requestIndexing(accessToken, url);
        const payload = {
          result,
          note: "Google accepting this notification does not guarantee the URL will be indexed. Indexing remains at Google's discretion.",
          provider_default_publish_requests_per_day: 200 as const,
          provider_default_quota_for_testing_only: false as const,
          provider_usage_approval_required: false as const,
          provider_spam_detection_applies: true as const,
          provider_usage_note: INDEXING_PROVIDER_USAGE_NOTE,
        };
        return toolResponse(JSON.stringify(payload, null, 2), payload);
      },
      );

      this.server.registerTool(
      'indexing.remove',
      {
        title: 'Request Indexing API removal',
        description: "Requests a URL_DELETED notification through Google's Indexing API for a URL within an owner-level Search Console property accessible to the connected Google account. Use only for pages that were eligible for the restricted Indexing API (JobPosting or livestream BroadcastEvent in VideoObject). Before removal Google requires the URL to return HTTP 404/410 or contain a robots noindex meta directive. A successful notification is only receipt acknowledgment and does not prove Google removed the URL from its index.",
        inputSchema: {
          site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA.describe(`${SEARCH_CONSOLE_PROPERTY_DESCRIPTION} The connected Google account must be an owner of this property.`),
          url: z.string().superRefine((value, ctx) => {
            try {
              assertIndexingRequestUrl(value);
            } catch (error) {
              ctx.addIssue({
                code: 'custom',
                message: (error as Error).message,
              });
            }
          }).describe('The fully qualified HTTP/HTTPS URL to request removal for. It must fall within site_url, must have been eligible for the restricted Indexing API, and must currently return HTTP 404/410 or contain a robots noindex meta directive.'),
        },
        outputSchema: INDEXING_REMOVE_OUTPUT_SCHEMA,
        annotations: WRITE_TOOL_ANNOTATIONS['indexing.remove'],
      },
      async ({ site_url, url }) => {
        assertUrlWithinSearchConsoleProperty(url, site_url);
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'indexing.remove');
        if (rateLimitError) return rateLimitError;
        const sitesRateLimitError = await this.rateLimitError(googleId, 'sites.list');
        if (sitesRateLimitError) return sitesRateLimitError;
        const accessToken = await this.getAccessToken(googleId);
        const sites = await listSites(
          accessToken,
          () => this.reserveMetadataReadRetry(googleId),
        );
        assertIndexingUrlAuthorized(url, site_url, sites);
        const result = await requestIndexingRemoval(accessToken, url);
        const payload = {
          result,
          note: "Google accepting this URL_DELETED notification only confirms receipt. It does not prove the URL was removed from Google's index; use URL Inspection for indexed-state evidence.",
          provider_default_publish_requests_per_day: 200 as const,
          provider_default_quota_for_testing_only: false as const,
          provider_usage_approval_required: false as const,
          provider_spam_detection_applies: true as const,
          provider_usage_note: INDEXING_PROVIDER_USAGE_NOTE,
          removal_completion_proven: false as const,
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
          site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA,
          start_date: SEARCH_CONSOLE_DATE_SCHEMA.optional().describe(
            searchConsoleDateDescription(
              'Start date (inclusive) in YYYY-MM-DD format. If end_date is omitted, the generated end date is 29 days later, capped at the latest complete date.',
            ),
          ),
          end_date: SEARCH_CONSOLE_DATE_SCHEMA.optional().describe(
            searchConsoleDateDescription(
              'End date (inclusive) in YYYY-MM-DD format. If start_date is omitted, the generated start date is 29 days earlier. Defaults to 3 days ago. Note the 2-3 day data lag.',
            ),
          ),
          row_limit: z.number().int().min(1).max(25000).default(1000).describe(`Maximum pages requested for this logical response (1-25000). Output is safely bounded; continue with result_page.next_start_row while result_page.has_more is true.`),
          start_row: INDEXED_PAGES_START_ROW_SCHEMA.default(0).describe('Zero-based page-row offset for pagination (0 through 2147483647).'),
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
        }, () => this.reserveSearchAnalyticsRetry(googleId));

        const pages = mapSourceRows(response.rows, (row) =>
          (row.keys?.length ?? 0) > 0 && hasRecordedPosition(row) ? ({
            page: row.keys![0],
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
          }) : undefined);
        const bounded = windowSourceRows(
          pages.items,
          start_row,
          row_limit,
          response.rows.length === sourceRowLimit,
          start_row + response.rows.length,
          pages.sourceRowOffsets,
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
        description: 'Compare Search Console performance metrics (clicks, impressions, CTR, average position) between two distinct date ranges (Period A vs Period B) for a selected dimension (query, page, country, device). Only dimension keys returned in both Search Analytics period responses are compared; a key missing from one response is not treated as zero because Google does not guarantee every data row. Apply the same search type, data state, and optional dimension filters to both periods. data_state defaults to final, preserving Google\'s finalized-only behavior when dataState is omitted; use all explicitly when recent preliminary-capable rows are desired. Results are ranked by largest absolute click change, then impression change, and safely paged with limit/start_row. Percentage change is null when an explicitly returned baseline row has zero and the comparison value differs. Discover and Google News are intentionally unavailable because this comparison contract includes average position, which those reports do not support.',
        inputSchema: {
          site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA,
          start_date_a: SEARCH_CONSOLE_DATE_SCHEMA.describe(
            searchConsoleDateDescription('Start date of Period A (recent, YYYY-MM-DD).'),
          ),
          end_date_a: SEARCH_CONSOLE_DATE_SCHEMA.describe(
            searchConsoleDateDescription('End date of Period A (recent, YYYY-MM-DD).'),
          ),
          start_date_b: SEARCH_CONSOLE_DATE_SCHEMA.describe(
            searchConsoleDateDescription('Start date of Period B (previous, YYYY-MM-DD).'),
          ),
          end_date_b: SEARCH_CONSOLE_DATE_SCHEMA.describe(
            searchConsoleDateDescription('End date of Period B (previous, YYYY-MM-DD).'),
          ),
          dimension: z.enum(['query', 'page', 'country', 'device']).default('query').describe('The dimension to compare performance for. Defaults to query.'),
          search_type: z
            .enum(['web', 'image', 'video', 'news'])
            .default('web')
            .describe('Which Search Console search index to compare. The same search type is used for both periods. Discover and Google News are excluded because this tool returns average-position comparisons.'),
          data_state: z
            .enum(['all', 'final'])
            .default('final')
            .describe(
              "'final' requests finalized data only and preserves Google's behavior when dataState is omitted; 'all' can include fresh preliminary Search Analytics data. The same state is applied to both comparison periods.",
            ),
          dimension_filter_groups: z
            .array(SEARCH_ANALYTICS_FILTER_GROUP_SCHEMA)
            .optional()
            .describe(
              "Optional Search Console filters applied identically to both periods. Filter operator defaults to 'equals' when omitted, and expressions are limited to 4096 characters. A caller-supplied query regex can approximate a manual brand/non-brand split, but it is not equivalent to Search Console's AI-assisted native Branded/Non-branded filter, which the Search Analytics API does not expose. Countries use ISO 3166-1 alpha-3 codes.",
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
        data_state,
        dimension_filter_groups,
        limit = DEFAULT_ANALYSIS_RESULT_LIMIT,
        start_row = 0,
      }) => {
        assertDateRange(start_date_a, end_date_a, 'start_date_a', 'end_date_a');
        assertDateRange(start_date_b, end_date_b, 'start_date_b', 'end_date_b');
        const today = getSearchConsoleCalendarDate();
        assertDateNotInFuture(end_date_a, today, 'end_date_a');
        assertDateNotInFuture(end_date_b, today, 'end_date_b');
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'analytics.compare');
        if (rateLimitError) return rateLimitError;
        const accessToken = await this.getAccessToken(googleId);

        const sourceA = await querySearchAnalyticsPaginated(accessToken, site_url, {
          startDate: start_date_a,
          endDate: end_date_a,
          dimensions: [dimension],
          type: search_type,
          dataState: data_state,
          ...(dimension_filter_groups !== undefined
            ? { dimensionFilterGroups: dimension_filter_groups }
            : {}),
        }, { beforeRetry: () => this.reserveSearchAnalyticsRetry(googleId) });

        const sourceB = await querySearchAnalyticsPaginated(accessToken, site_url, {
          startDate: start_date_b,
          endDate: end_date_b,
          dimensions: [dimension],
          type: search_type,
          dataState: data_state,
          ...(dimension_filter_groups !== undefined
            ? { dimensionFilterGroups: dimension_filter_groups }
            : {}),
        }, { beforeRetry: () => this.reserveSearchAnalyticsRetry(googleId) });

        const comparison = processPerformanceComparison(sourceA.rows, sourceB.rows);
        const bounded = windowKnownResults(comparison, start_row, limit);
        const payload = {
          comparison_scope: 'common_returned_rows_only' as const,
          comparison_note: COMMON_RETURNED_ROWS_COMPARISON_NOTE,
          data_state,
          preliminary_data_possible: data_state !== 'final',
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
          'Generate a plain-language weekly Search Console report for Web (default), Image, Video or Google Search News-tab performance; Discover and Google News app are excluded because query rows are unavailable. Optional search_type is applied to every Google request, and non-Web reports avoid Web-specific SEO advice. Optional page_contains scopes URLs, device selects desktop/mobile/tablet, query_contains scopes query topics, and country selects a three-letter ISO 3166-1 alpha-3 searcher country (not page language). All selected filters apply together at Google to the same five (or three preliminary) requests; scoped results are not property-wide. For finalized weeks, returns the 7-day comparison, top pages and query movers. Defaults end_date to 3 days ago. Passing an explicitly newer end_date includes fresher preliminary data as a clearly labeled snapshot without week-over-week claims or SEO advice.',
        inputSchema: {
          site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA,
          search_type: z.enum(['web', 'image', 'video', 'news']).default('web').describe(
            'Search Console search type for every digest request: web (default), image, video or news (Google Search News tab, not Google News app). Discover and Google News app are excluded.',
          ),
          page_contains: z.string().trim().min(1).max(120).optional().describe(
            'Optional case-insensitive page URL substring such as /de/. Applied to every Search Analytics request, including totals and query movers, so the report describes matching pages rather than property-wide traffic.',
          ),
          device: z.enum(['desktop', 'mobile', 'tablet']).optional().describe(
            'Optional Search Console device scope. When set, every total, query and page request filters to that device before aggregation; combines with page_contains as Google-side AND. Omit for all devices.',
          ),
          query_contains: z.string().trim().min(1).max(240).optional().describe(
            'Optional case-insensitive query topic substring, such as technical SEO. Applied to all digest requests before aggregation, alongside URL and device filters in one Google-side AND group. These are topic-scoped, not property-wide totals.',
          ),
          country: z.string().trim().regex(/^[a-zA-Z]{3}$/, 'Use a three-letter ISO 3166-1 alpha-3 country code such as SVN or DEU.').optional().describe(
            'Optional ISO 3166-1 alpha-3 searcher country code, e.g. SVN for Slovenia or DEU for Germany. Case is normalized to upper-case for the Google equals filter. Country is based on searcher location, not site URL language; combines with query, page and device filters.',
          ),
          end_date: SEARCH_CONSOLE_DATE_SCHEMA
            .optional()
            .describe(
              searchConsoleDateDescription(
                'End date (inclusive) in YYYY-MM-DD format. Defaults to 3 days ago, which is usually the latest complete Search Console date. Pass a more recent date explicitly for a preliminary snapshot without trend conclusions or SEO recommendations.',
              ),
            ),
        },
        outputSchema: WEEKLY_DIGEST_OUTPUT_SCHEMA,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ site_url, end_date, page_contains, search_type = 'web', device, query_contains, country }) => {
        const today = getSearchConsoleCalendarDate();
        const resolvedEndDate = resolveWeeklyDigestEndDate(end_date, today);
        assertDateNotInFuture(resolvedEndDate, today, 'end_date');
        const googleId = this.requireGoogleId();
        const rateLimitError = await this.rateLimitError(googleId, 'reports.weekly_digest');
        if (rateLimitError) return rateLimitError;
        // Preliminary snapshots make three current-week queries; finalized
        // digests make five. Reserve the exact request count up front.
        const sharedBudgetError = await this.rateLimitError(
          googleId,
          'analytics.query',
          weeklyDigestAnalyticsRequestCount(resolvedEndDate, today),
          'reports.weekly_digest (shared Search Analytics quota)',
        );
        if (sharedBudgetError) return sharedBudgetError;

        try {
          const markdown = await generateWeeklyDigest(
            this.getAccessTokenLifecycle(),
            googleId,
            site_url,
            resolvedEndDate,
            () => this.reserveSearchAnalyticsRetry(googleId),
            today,
            page_contains,
            search_type,
            device,
            query_contains,
            country,
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

// Keep access tokens tied to their Worker binding set. A module-global singleton
// would reuse credentials from the first Env even when another Env is supplied.
const sharedAccessTokens = new WeakMap<Env, GoogleAccessTokenLifecycle>();

function getSharedAccessTokenLifecycle(env: Env): GoogleAccessTokenLifecycle {
  let lifecycle = sharedAccessTokens.get(env);
  if (!lifecycle) {
    lifecycle = new GoogleAccessTokenLifecycle(env);
    sharedAccessTokens.set(env, lifecycle);
  }
  return lifecycle;
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

const MCP_HEADER_PREFLIGHT_MAX_BYTES = 2 * 1024 * 1024;

async function readMcpHeaderPreflightBody(
  request: Request,
): Promise<{ tooLarge: true } | { tooLarge: false; text: string }> {
  const advertisedLength = request.headers.get('Content-Length');
  if (
    advertisedLength !== null &&
    /^\d+$/.test(advertisedLength.trim()) &&
    Number(advertisedLength) > MCP_HEADER_PREFLIGHT_MAX_BYTES
  ) {
    return { tooLarge: true };
  }

  // Inspect a clone so malformed JSON and notifications still reach the SDK.
  const reader = request.clone().body?.getReader();
  if (!reader) return { tooLarge: false, text: '' };
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MCP_HEADER_PREFLIGHT_MAX_BYTES - totalBytes) {
        // Do not await cancellation: a cloned stream can remain teed to the SDK branch.
        void reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      totalBytes += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { tooLarge: false, text: new TextDecoder().decode(bytes) };
}

export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (
      request.method === 'POST' &&
      request.headers.has('Mcp-Method') &&
      !request.headers.has('MCP-Protocol-Version')
    ) {
      let id: string | number | null = null;
      let isRequest = false;
      try {
        const preview = await readMcpHeaderPreflightBody(request);
        if (preview.tooLarge) {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32600, message: 'MCP request body exceeds the 2 MiB preflight limit.' },
            }),
            { status: 413, headers: { 'content-type': 'application/json; charset=utf-8' } },
          );
        }
        const body = JSON.parse(preview.text) as { id?: unknown };
        if (Object.prototype.hasOwnProperty.call(body, 'id')) {
          isRequest = true;
          if (typeof body.id === 'string' || typeof body.id === 'number') {
            id = body.id;
          }
        }
      } catch {
        // Let the SDK handle malformed bodies; this guard targets valid modern requests.
      }

      if (isRequest) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32020,
              message: 'HeaderMismatch: MCP-Protocol-Version header is required for modern MCP requests.',
            },
          }),
          {
            status: 400,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        );
      }
    }

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

const CONSENT_COOKIE_HTTPS = '__Host-MCP_GSC_CONSENT';
const CONSENT_COOKIE_LOOPBACK = 'MCP_GSC_CONSENT';

interface PendingConsentPayload {
  kind: 'mcp-gsc-consent';
  authRequest: AuthRequest;
}

function isLoopbackHttp(url: URL): boolean {
  return (
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' ||
      url.hostname === 'localhost' ||
      url.hostname === '[::1]')
  );
}

function consentCookieName(url: URL): string {
  return isLoopbackHttp(url) ? CONSENT_COOKIE_LOOPBACK : CONSENT_COOKIE_HTTPS;
}

function consentCookie(url: URL, value: string, maxAgeSeconds = 600): string {
  const secure = isLoopbackHttp(url) ? '' : '; Secure';
  return `${consentCookieName(url)}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearConsentCookie(url: URL): string {
  return consentCookie(url, '', 0);
}

function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  for (const entry of cookie.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

async function constantTimeStringEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function isParsedAuthorizationRequest(value: unknown): value is AuthRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AuthRequest>;
  return (
    typeof candidate.responseType === 'string' &&
    typeof candidate.clientId === 'string' &&
    typeof candidate.redirectUri === 'string' &&
    Array.isArray(candidate.scope) &&
    candidate.scope.every((scope) => typeof scope === 'string') &&
    typeof candidate.state === 'string'
  );
}

function isPendingConsentPayload(value: unknown): value is PendingConsentPayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PendingConsentPayload>;
  return candidate.kind === 'mcp-gsc-consent' && isParsedAuthorizationRequest(candidate.authRequest);
}

function oauthErrorRedirect(
  authRequest: AuthRequest,
  code: 'access_denied' | 'server_error',
  description?: string,
): Response {
  const redirect = new URL(authRequest.redirectUri);
  redirect.searchParams.set('error', code);
  if (description) redirect.searchParams.set('error_description', description);
  redirect.searchParams.set('state', authRequest.state);
  if (authRequest.issuer) redirect.searchParams.set('iss', authRequest.issuer);
  return new Response(null, {
    status: 302,
    headers: { location: redirect.toString() },
  });
}

function consentReturnDestination(redirectUri: string): string {
  const redirect = new URL(redirectUri);
  if (redirect.origin !== 'null') return redirect.origin;
  // Custom-scheme desktop clients may not have a web origin.
  return redirect.host ? `${redirect.protocol}//${redirect.host}` : redirect.protocol;
}

function consentHtml(input: {
  clientName: string;
  clientId: string;
  returnDestination: string;
  consentNonce: string;
  mcpScopes: readonly string[];
  googleScopes: readonly string[];
  accessMode: GscAccessMode;
}): string {
  const list = (values: readonly string[]) =>
    values.length > 0
      ? values.map((value) => `<li><code>${escapeHtml(value)}</code></li>`).join('')
      : '<li><em>No additional scopes requested</em></li>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize Google Search Console MCP</title>
<style>
body{font-family:system-ui,sans-serif;max-width:760px;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#111}main{border:1px solid #ddd;border-radius:12px;padding:1.5rem}code{overflow-wrap:anywhere}button{padding:.65rem 1rem;margin-right:.5rem;font:inherit}button[name="decision"][value="allow"]{font-weight:700}.muted{color:#555}
</style>
</head>
<body>
<main>
<h1>Authorize Google Search Console access</h1>
<p><strong>${escapeHtml(input.clientName)}</strong> is requesting access through mcp-gsc.</p>
<p class="muted">Client ID: <code>${escapeHtml(input.clientId)}</code></p>
<p class="muted">Return destination: <code>${escapeHtml(input.returnDestination)}</code></p>
<p class="muted">Confirm this destination belongs to the MCP client you intended to connect.</p>
<h2>MCP scopes requested</h2>
<ul>${list(input.mcpScopes)}</ul>
<h2>Google scopes mcp-gsc will request</h2>
<p>Configured access mode: <strong>${escapeHtml(input.accessMode)}</strong></p>
<ul>${list(input.googleScopes)}</ul>
<p>Continue only if you recognize and trust the requesting MCP client.</p>
<form method="post" action="/authorize">
<input type="hidden" name="consent_nonce" value="${escapeHtml(input.consentNonce)}">
<button type="submit" name="decision" value="allow">Allow and continue to Google</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>
</main>
</body>
</html>`;
}

function googleRedirectUri(request: Request): string {
  return new URL('/google/callback', request.url).toString();
}

async function readConsentForm(request: Request): Promise<URLSearchParams | null> {
  const maxBytes = 4_096;
  const bytes = new Uint8Array(maxBytes);
  const reader = request.body?.getReader();
  let received = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength > maxBytes - received) {
          await reader.cancel().catch(() => undefined);
          return null;
        }
        bytes.set(value, received);
        received += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  }
  return new URLSearchParams(new TextDecoder().decode(bytes.subarray(0, received)));
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
        'mcp-gsc — Google Search Console MCP server.\n' +
          `MCP endpoint: ${url.origin}/mcp\n` +
          'Setup: https://github.com/AKzar1el/mcp-gsc#readme\n',
        { headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }

    if (url.pathname === '/healthz' && request.method === 'GET') {
      return new Response('ok', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    if (url.pathname === '/authorize' && request.method === 'GET') {
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
      if (!isParsedAuthorizationRequest(claudeAuthRequest)) {
        return new Response('Invalid OAuth authorization request.', { status: 400 });
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
      let client;
      try {
        client = await env.OAUTH_PROVIDER.lookupClient(claudeAuthRequest.clientId);
      } catch (err) {
        console.warn('OAuth client lookup failed', {
          message: (err as Error).message,
        });
        return new Response('Could not verify the requesting OAuth client.', { status: 400 });
      }
      if (!client) {
        return new Response('Unknown OAuth client.', { status: 400 });
      }

      const consentNonce = crypto.randomUUID();
      const pendingConsent: PendingConsentPayload = {
        kind: 'mcp-gsc-consent',
        authRequest: claudeAuthRequest,
      };
      await stashPendingAuth(env, consentNonce, pendingConsent);
      return new Response(
        consentHtml({
          clientName: client.clientName ?? claudeAuthRequest.clientId,
          clientId: claudeAuthRequest.clientId,
          returnDestination: consentReturnDestination(claudeAuthRequest.redirectUri),
          consentNonce,
          mcpScopes: claudeAuthRequest.scope,
          googleScopes: getGoogleOAuthScopes(accessMode),
          accessMode,
        }),
        {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
            'x-frame-options': 'DENY',
            'set-cookie': consentCookie(url, consentNonce),
          },
        },
      );
    }

    if (url.pathname === '/authorize' && request.method === 'POST') {
      const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.startsWith('application/x-www-form-urlencoded')) {
        return new Response('Unsupported Media Type', { status: 415 });
      }
      const contentLength = Number(request.headers.get('content-length') ?? '0');
      if (Number.isFinite(contentLength) && contentLength > 4096) {
        return new Response('Authorization response too large', { status: 413 });
      }
      const body = await readConsentForm(request);
      if (!body) {
        return new Response('Authorization response too large', { status: 413 });
      }
      const consentNonceValue = body.get('consent_nonce');
      const decisionValue = body.get('decision');
      const consentNonce =
        typeof consentNonceValue === 'string' ? consentNonceValue : null;
      const decision = typeof decisionValue === 'string' ? decisionValue : null;
      const cookieNonce = getCookie(request, consentCookieName(url));
      if (!consentNonce || !cookieNonce || !(await constantTimeStringEqual(consentNonce, cookieNonce))) {
        return new Response('Invalid or expired authorization consent.', { status: 400 });
      }

      const pending = await consumePendingAuth(env, consentNonce);
      if (!pending || !isPendingConsentPayload(pending.claudeAuthRequest)) {
        return new Response('Authorization consent expired or invalid.', { status: 400 });
      }
      const authRequest = pending.claudeAuthRequest.authRequest;
      if (decision === 'deny') {
        const denied = oauthErrorRedirect(authRequest, 'access_denied', 'The user denied access.');
        denied.headers.append('set-cookie', clearConsentCookie(url));
        return denied;
      }
      if (decision !== 'allow') {
        return new Response('Invalid authorization decision.', { status: 400 });
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
      const googleNonce = crypto.randomUUID();
      await stashPendingAuth(env, googleNonce, authRequest);
      const googleUrl = buildAuthUrl(
        env.GOOGLE_CLIENT_ID,
        googleRedirectUri(request),
        googleNonce,
        accessMode,
      );
      return new Response(null, {
        status: 302,
        headers: {
          location: googleUrl,
          'set-cookie': clearConsentCookie(url),
        },
      });
    }

    if (url.pathname === '/google/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const googleError = url.searchParams.get('error');

      if (!state || (!code && !googleError)) {
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

      const claudeAuthReq = pending.claudeAuthRequest;
      if (!isParsedAuthorizationRequest(claudeAuthReq)) {
        console.error('Pending auth had an invalid shape');
        return new Response('Auth request expired or invalid', { status: 400 });
      }

      if (googleError) {
        console.warn('Google OAuth returned error', { error: googleError });
        return oauthErrorRedirect(
          claudeAuthReq,
          googleError === 'access_denied' ? 'access_denied' : 'server_error',
          googleError === 'access_denied'
            ? 'Google authorization was denied.'
            : 'Google authorization failed.',
        );
      }

      if (!code) {
        return new Response('Missing authorization code', { status: 400 });
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
        getSharedAccessTokenLifecycle(env).invalidate(userinfo.id);
      } catch (err) {
        console.error('Save user failed', {
          google_id: userinfo.id,
          message: (err as Error).message,
        });
        return new Response('Save user failed', { status: 500 });
      }

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
