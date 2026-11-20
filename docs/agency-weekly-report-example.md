# Example: a read-only weekly Search Console client brief

This is a **copyable workflow**, not a report generated from a real account. It works with the existing `reports.weekly_digest` tool and does not require a paid provider, a new integration, or an additional MCP server.

## Prerequisites

1. [Connect mcp-gsc](../README.md#connect-the-local-launcher) using `GSC_ACCESS_MODE=readonly`, with the OAuth credentials described in [SETUP.md](../SETUP.md). A hosted connection may expose a different tool version; check its actual catalog before continuing.
2. Sign in with the Google account that has permission to view the client's Search Console property. Never assume that possession of a saved refresh token proves live access.
3. Obtain the **exact** `siteUrl` from `sites.list`, such as a URL-prefix property or `sc-domain:example.com`. Do not construct a different property's identifier from the client's website address.

## Copy into an MCP-capable assistant

Replace `PROPERTY_FROM_SITES_LIST` with the exact identifier returned by Google, then paste:

```text
Prepare a read-only, review-only weekly Search Console brief for
site_url: PROPERTY_FROM_SITES_LIST
search_type: web

1. Call server.capabilities to confirm this connection exposes the required read-only
   tools. This only reports stored credential state; it does not verify live Google access.
2. Call sites.list and confirm that the exact site_url above is accessible. Respect
   result_page pagination if a property is not in the first returned page. Stop on
   missing access, unsupported property identifiers, or an OAuth reconnect error.
3. Call reports.weekly_digest once for that exact site_url and web surface, without
   narrowing country, device, page or query scope. Use its default latest usually
   finalized week. Do not claim it is finalized if the response indicates preliminary
   data; Search Console dates use Pacific Time and recent data can lag.
4. Draft a short brief: exact property and dates, click/impression/CTR observations,
   top returned page/query movements, up to two evidence-backed next read-only checks,
   and what the returned data cannot establish. Distinguish missing rows from measured
   zeros; never infer deindexing, ranking causation, or exhaustive query coverage.
5. Show the brief to me for review. Do not email, share, publish, alter content,
   submit sitemaps, request indexing, or call any write tool.

If the digest is unavailable or the account is disconnected, explain the exact
blocker rather than inventing a report or switching properties.
```

This workflow uses `sites.list` for property confirmation and `reports.weekly_digest` for the report. The digest makes its existing bounded Search Analytics reads (normally five for finalized reporting), subject to shared quotas and permitted retries. Request `analytics.query` with `dimensions: []`, `data_state: "final"`, the **same** `site_url`, `search_type` and seven-day dates only if an additional independent aggregate cross-check is worth another charged read. A query with dimensions is not a substitute for a property-level aggregate total.

For a specific market or device, pass identical `country`/`device` or bounded `countries`/`devices` scopes to the digest and any justified follow-up; do not silently narrow the segment. Combined lists describe one selected segment, not separate countries or devices. Search Console can omit rows and the most recent two to three days may not be settled. The final brief is a **draft for human review**, not proof of SEO recovery, customer approval, or a commercial result.

If your MCP client supports prompt discovery, `gsc-weekly-client-report` provides a guided version of this workflow. Otherwise the plain-language instructions above work with the existing read-only tools.
