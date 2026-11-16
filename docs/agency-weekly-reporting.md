# Read-only weekly Search Console reporting for SEO agencies

This is a repeatable, zero-additional-cost reporting workflow for a consultant or agency already authorized by a client to read its Google Search Console property. It uses mcp-gsc's existing tools, not a fabricated sample account, customer endorsement, automated delivery system, or paid service.

## Connect with least privilege

1. Obtain the client's explicit authorization to view its Search Console data and use it in your chosen MCP client. The Google account signing in must already have permission for the client's property. Never request or copy a client's Google password, OAuth token, or API secret.
2. Follow [SETUP.md](../SETUP.md) for your own Google OAuth configuration. For a new local launcher session, explicitly select `GSC_ACCESS_MODE=readonly` before starting `npx -y @digestseo/mcp-gsc`. On Windows PowerShell, use `$env:GSC_ACCESS_MODE = 'readonly'`, then start the launcher. New self-hosting templates also choose read-only access; an existing deployment without this setting retains its backward-compatible read-write mode.
3. Connect to your own `/mcp` endpoint, complete the normal Google OAuth consent, and review the tool catalog. The read-only mode omits property, sitemap, and Indexing API mutation tools. Do not change the access mode of an existing deployment or reconnect another client's account without its approval.
4. Use `sites.list` to discover Google's exact property identifiers, then `sites.get` to confirm the one property the client authorized. Preserve the returned `siteUrl` exactly (e.g. `sc-domain:example.com`); do not substitute a different host, protocol, or client's property. Separate each client's reporting session and output.

The procedure below calls read-only MCP tools and contains no outbound email, posting, export, or upload step: **no client data is transmitted outside the selected MCP connection by this workflow**. The selected MCP host, model provider, and Google still process data according to their respective policies; inspect those policies and your client agreement before using real client data or sharing a finished report.

## Repeatable weekly prompt sequence

Replace the placeholders with values from Google's actual tool responses. The example property below is a placeholder, not a claim about a real client or live metrics.

### 1. Confirm the property

> Use `sites.list` and then `sites.get` for the exact property `sc-domain:example.com`. If this Google account lacks access, stop. Do not search or report on another property as a substitute. Do not invoke write tools.

### 2. Generate the weekly first draft

> Call `reports.weekly_digest` once for `site_url: "sc-domain:example.com"`. Use the default `end_date` (normally three days before today's Search Console Pacific Time date) for usually-complete data. Return the actual date range and the digest without inventing missing metrics, causes, rankings, or recommendations.

The digest makes five Search Analytics queries against the shared quota and has a separate hourly limit. Avoid repeatedly running it to produce multiple cosmetic versions. Its queries can request preliminary-capable data; a default end date is not a guarantee that every returned value is finalized.

**Optional section-level report:** For a multilingual site, call `reports.weekly_digest` with the same exact `site_url` and, for example, `page_contains: "/de/"`. This applies the page-URL substring filter to the digest's totals, query movers, and page rows, and labels the report as filtered rather than property-wide. The filter matches URLs containing the supplied text; it does not identify a language automatically or guarantee that all matching URLs are German. Check the actual URL structure first. A filtered digest makes the same number of Search Analytics requests as an unfiltered digest, but each separate invocation still consumes its own quota allowance.

**Optional search-surface report:** Supply `search_type: "image"`, `"video"`, or `"news"` when the client needs performance for that specific Search Console surface instead of the default `"web"`. The `"news"` value is the Google Search News tab, not the Google News app; Discover and Google News reports cannot provide the query-based movers used here. Every request in the digest uses the same selected type, and the report labels that scope. Non-Web reports refrain from Web-specific SEO prescriptions until the underlying query/page evidence is reviewed. You can combine `search_type` and `page_contains`, without changing the number of Google requests.

**Optional device-scoped report:** Supply `device: "mobile"`, `"desktop"`, or `"tablet"` to the digest when the client needs performance for one device category. You can combine this with `search_type` and `page_contains`. All digest requests apply the same Google-side device filter (MOBILE, DESKTOP, or TABLET), so the resulting metrics are for that device only. A device-scoped digest is **not** interchangeable with an all-device report. Each new invocation still consumes its normal shared Search Analytics quota.

**Optional country-scoped report:** Supply `country: "SVN"` for searches attributed to Slovenia, or `"DEU"` for Germany. Use the three-letter ISO 3166-1 alpha-3 country code (case-insensitive input), not a two-letter locale like `sl` or `de`. This filter identifies the **searcher's country**, not the language of a page or the `/sl/` URL section. It combines with `device`, `page_contains`, `query_contains` and `search_type` across the same five finalized (or three preliminary) requests, without adding Google calls. Country-scoped totals are not property-wide; do not infer country from the URL path.

**Optional topic report:** Supply `query_contains: "technical seo"` to see only Search Console query topics containing that phrase. Matching queries can be omitted or anonymized by Google. Do not treat the resulting totals as sitewide or compare them with an unfiltered report.

### 3. Reconcile client-facing performance and movers

> For the same property and exact seven-day window from the digest, call `analytics.query` with `dimensions: []` and `data_state: "final"` for genuine site-wide totals. Compare them to the previous seven-day window using the same search type and filters. For row-level movers, use `analytics.compare` with `start_date_a`, `end_date_a`, `start_date_b`, `end_date_b`, `dimension: "query"`, and `data_state: "final"`. Clearly identify preliminary or mismatched date states; do not quietly mix them.

The default steps above produce **property-wide, all-device Web** comparisons. Preserve the digest's exact `site_url`, date windows, `search_type`, `page_contains`, `device`, `query_contains`, `country` and data-state interpretation when comparing totals or movers. If the digest used a non-default search type, pass that same type to both follow-up tools; never compare Image/Video/News-tab totals to Web totals as though they were the same population. If it used a URL section filter or query topic, both tools need the corresponding page or query filter. **Both `analytics.query` and `analytics.compare` must preserve the same device filter** whenever the digest selected a device; never compare device-scoped totals with all-device totals. Likewise, both must preserve any country filter before claiming geographic trends.

For a `/de/` **mobile-only** digest, combine the page and device filters in one AND group, passing the same `dimension_filter_groups` value to `analytics.query` and `analytics.compare` (for both periods). When also filtering by searcher country `DEU` and query topic `seo`, append both filters to that same group:

```json
[{"groupType":"and","filters":[{"dimension":"page","operator":"contains","expression":"/de/"},{"dimension":"device","operator":"equals","expression":"MOBILE"},{"dimension":"query","operator":"contains","expression":"seo"},{"dimension":"country","operator":"equals","expression":"DEU"}]}]
```

Omit any filter that the original digest did not use. If none is selected, omit `dimension_filter_groups`. Use `dimensions: []` for the matched-scope totals and `dimension: "query"` for the matched-scope query comparison. Keep the exact dates, search type, and data state aligned with the digest. If a follow-up tool cannot apply equivalent filters, **do not** directly compare its all-device or property-wide values with scoped digest metrics. A filter on full page URLs is not a substitute for verifying the client's actual locale URL patterns, and a country code is not a page-language identifier.

> For the most important page behind a reported mover, use `insights.page_queries` with its exact URL, and include only the supporting observed query/page rows. Where the question is query-first, `insights.query_pages` may be more suitable. If there are no comparable returned rows, withhold any claim of a measured gain or loss for that row.

The comparison tool covers only keys present in both bounded period responses. **A missing row is not zero**. Google's Search Analytics API may return top rows rather than a complete dataset. Average position is an aggregate metric, not a current SERP rank or an exact page placement. A change in clicks or impressions does not establish that an SEO edit, algorithm change, or competitor caused it.

### 4. Prepare a human-reviewed report

Use this reusable skeleton, filling values only from independently returned tool data:

| Section | Client-facing content |
|---|---|
| Client property | `[exact Google siteUrl]` |
| Report scope | `[search type, device, searcher country, query topic, page URL scope and limitations; state unfiltered where applicable]` |
| Reporting period | `[current dates, Search Console Pacific Time]` vs. `[previous dates]` |
| Consistently scoped totals | `[measured clicks and impressions, source, data_state, search type and matching page/device filters if used]` |
| Query/page movement | `[observed comparable rows, or insufficient comparable data]` |
| One priority action | `[specific, evidence-linked recommendation or no action justified]` |
| Method and limitations | `[Search Analytics row coverage, freshness, average-position caveats]` |
| Owner review | `[reviewer and approval status; never fabricated]` |

Review the property, dates, metric definitions, privacy requirements, and factual support before sending any client-facing document yourself. This workflow does not send a message or claim the report was delivered. If an indexing question matters, use `urls.inspect` only with a permitted URL and state that it reports Google's indexed version, **not** a live URL test.

## Acceptance checklist

- A permitted client account returns the exact property through `sites.list` and `sites.get`; the server exposes only read-capable tools under `readonly`.
- One `reports.weekly_digest` call produces a dated draft; `analytics.query` with empty dimensions is used for totals and `analytics.compare` uses matching periods/data state. When `page_contains`, `device`, `query_contains` or `country` is selected, both follow-ups apply equivalent page/device/topic/country filters, and all figures are labeled with their actual scope rather than property-wide or all-device.
- Important movers are supported by actual `insights.page_queries` evidence; absent rows, unsupported causal claims, unmeasured conversions, and unverified business value are excluded.
- The final client report has a truthful methodology note, no invented customer outcomes, and requires human approval before any external delivery.
