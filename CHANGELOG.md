# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- The documented and npm-declared Node.js minimum is now 22+, matching the bundled Wrangler 4 runtime requirement instead of advertising unsupported Node.js 20 installs.

### Fixed
- URL Inspection guidance now states that Google reports the version currently in its index rather than running a live URL test, and no longer presents the deprecated mobile-usability field as a current primary signal.

## [0.4.2] - 2026-09-21

### Fixed
- Cannibalization totals and impression shares now expose their query/page-row aggregation scope explicitly so clients do not mistake summed page impressions for a true query-level Search Console total.
- Discover Search Analytics calls now reject unsupported query grouping/filtering before reaching Google, and query-centric/comparison tools no longer advertise Discover where their contracts depend on query or average-position data that Discover does not provide.
- Quick-win guidance now treats Search Console position as an aggregate average-position metric rather than a literal current rank, and metadata no longer implies CTR is an eligibility filter when the implementation does not filter on CTR.

## [0.4.1] - 2026-09-21

### Changed
- Large Search Analytics, comparison, cannibalization, quick-win, content-decay, page/query drilldown, and impression-page proxy responses now use deterministic bounded output with explicit pagination/truncation metadata instead of risking oversized MCP structured content.
- Content-decay assessment now requires meaningful click evidence plus supporting impression or average-position deterioration for a `likely_decay` classification, while separately identifying weak evidence and improving visibility with click volatility.
- Weekly-digest recommendations now keep measured Search Console observations separate from causal hypotheses and avoid unsupported publishing or indexing-speed prescriptions.

### Fixed
- True site-total `analytics.query` calls with `dimensions: []` now accept Google's valid aggregate rows when the `keys` field is omitted.
- Query/page drilldowns now expose usable paging inputs instead of reporting pagination metadata that callers could not advance.
- `indexing.list_pages` now makes its impressions-based proxy semantics explicit and safely pages large result sets.

## [0.4.0] - 2026-09-21

### Added
- Bounded bulk URL inspection with \`urls.inspect_many\`, preserving input order and per-URL failures.
- Exact property lookup with \`sites.get\`.
- Query/page drilldowns with \`insights.page_queries\` and \`insights.query_pages\`.
- Hourly Search Analytics support and News Showcase panel aggregation.
- Read-only deployment mode for least-privilege autonomous/agent installations.

### Changed
- Migrated the remote MCP runtime to Cloudflare's current stateless handler and modernized OAuth discovery with Client ID Metadata Documents, S256 PKCE, reconnect isolation, and Durable Object-backed pending authorization state.
- Self-host npm transport metadata now accurately describes the loopback Streamable HTTP launcher and OAuth callback.
- Search Console calendar defaults now follow Pacific Time and weekly reports default to usually-complete data.
- Weekly-digest guidance now avoids unsupported indexing, zero-click, branded-query, and average-position conclusions and points users to the underlying Search Console evidence.
- Search Analytics requests now reject documented invalid cross-field combinations before reaching Google.

### Fixed
- Higher-level Search Analytics pagination, comparison zero-baseline math, indexing authorization/eligibility bounds, OAuth state atomicity, access-token lifecycle behavior, and tool rate-limit RPC behavior.
- Dependency and CI hygiene, including current Cloudflare Vitest integration, supported Wrangler floor, Node 24 GitHub Actions, and Ubuntu 26 runners.

## [0.3.1] - 2026-07-27

### Added
- Namespaced MCP tool names and typed output schemas for more consistent client integration.
- Distribution surfaces for self-hosting: a portable launcher, Docker/Glama support, and Cursor and Claude Code plugin metadata.
- The public npm package, `@digestseo/mcp-gsc`, with an `npx` launcher.

### Changed
- Registry, manifest, and package metadata now point to the official DigestSEO listing.

## [0.3.0] - 2026-07-13

### Added
- Search Console write operations for properties and sitemaps, Indexing API requests, and analytics insight tools for quick wins, cannibalization, content decay, indexed pages, and period comparisons.
- An on-demand weekly Search Console performance digest with top pages, movers, and recommended actions.
- Static tool and connection metadata for registry discovery.

### Changed
- Google OAuth permissions and MCP annotations now distinguish read operations from the available write operations.

## [0.2.0] - 2026-06-10

### Added
- `get_capabilities` tool — returns the tool catalog and a non-destructive auth-status probe for better first-run discovery in lazy-loading clients.
- **Pagination** for `query_search_analytics`: new `start_row` parameter (Google's `startRow`), plus a `next_start_row` field in the response whenever a full page came back.
- **Parameter descriptions on every tool input** — including the `sc-domain:` vs URL-prefix property format trap, the YYYY-MM-DD date format, and the 2–3 day GSC data lag — so MCP clients make correct calls on the first try.
- **MCP tool annotations**: all five tools now declare `readOnlyHint: true` and human-readable titles.
- **Offline unit tests** (`npm run test:unit`, 15 tests): crypto roundtrip/tamper checks, OAuth URL construction, refresh-token error mapping, and Search Console request encoding — no deployment needed.
- **GitHub Actions CI**: typecheck + unit tests on every push and pull request.
- `SECURITY.md` with a private-reporting channel and a full data-handling inventory.

### Changed
- `query_search_analytics` now returns compact JSON shaped as `{ row_count, start_row, rows, next_start_row? }` instead of a pretty-printed bare array — roughly 3× fewer tokens for the same data.
- Default `row_limit` lowered from 1000 to **100**. Most conversational questions need far fewer rows; bulk consumers can still request up to 25,000 and paginate.
- Input validation tightened: dates must be `YYYY-MM-DD`, `row_limit` must be an integer in 1–25000.
- Error messages no longer hardcode Claude.ai — they now say "your MCP client (e.g. Claude.ai → Settings → Connectors)".
- The version reported by the MCP server and `get_capabilities` is now read from `package.json` (single source of truth).
- A failure inside the OAuth provider's `completeAuthorization` now returns a clean 500 instead of an unhandled exception.

### Fixed
- Server name: the MCP server now identifies as `mcp-gsc` (in the `McpServer` name and the `GET /` response body) to match the repo, package, and worker name — it was previously `hosted-gsc-mcp`.
- A transient Google error no longer deletes a user's stored credentials. `refreshAccessToken` now treats only a definitive `invalid_grant` as a revocation; other non-OK responses (bare 400/401, 5xx, network) propagate as plain errors, so a temporary blip can no longer trigger `deleteUser`.

## [0.1.0] - 2026-06-02

Initial public release — a hosted MCP server for Google Search Console, self-hostable on Cloudflare Workers.

### Added
- One-click Google OAuth onboarding (`/authorize` → Google → `/google/callback`): connect with your Google account, no API keys to copy.
- Four read-only tools: `list_sites`, `query_search_analytics`, `inspect_url`, `list_sitemaps`.
- Bring-your-own Google OAuth credentials and Cloudflare KV — see [SETUP.md](SETUP.md).
- AES-GCM encryption of stored Google refresh tokens (`src/crypto.ts`).
- Structural smoke tests (`npm run test:smoke`).
