# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Local launcher setup now provides a cross-platform Node.js command for generating `TOKEN_ENCRYPTION_KEY`, and missing/invalid-key errors surface the same recovery command without logging secret values or requiring OpenSSL.

## [0.4.36] - 2026-09-24

### Changed
- `analytics.query` now exposes an explicit `multimodal_report_isolatable: false` boundary and matching runtime guidance because Search Console's new web multimodal filter is currently UI-only; the documented Search Analytics API still exposes only web/image/video/news/discover/googleNews search types.

### Fixed
- User-supplied Search Analytics ranges now reject future end dates against Search Console's Pacific calendar before reserving local safety budget, resolving Google credentials, or calling the provider; the same boundary now applies to explicit indexed-page ranges and weekly-digest input.

## [0.4.35] - 2026-09-24

### Fixed
- Search Analytics pagination now treats provider responses shorter than the requested page size as terminal, matching Google's documented contract and avoiding false continuations or unnecessary follow-up requests across direct and higher-level workflows.
- `insights.page_queries` now rejects exact page URLs outside the supplied Search Console property before reserving local Search Analytics safety budget, resolving Google credentials, or calling the provider, preventing misleading empty cross-property drilldowns.

## [0.4.34] - 2026-09-24

### Fixed
- `analytics.query` now rejects documented-invalid cross-field request combinations before reserving local Search Analytics safety budget or resolving Google credentials, while retaining the lower-level provider compatibility guard for internal callers.
- `indexing.status`, `indexing.request`, and `indexing.remove` now reject URLs outside the supplied Search Console property before reserving local safety budget, resolving Google credentials, or calling Search Console for owner authorization.

## [0.4.33] - 2026-09-24

### Changed
- `analytics.query` responses now echo the ordered requested `dimensions` and `search_type`, so `rows[].keys` remain self-describing when responses are saved, forwarded, or consumed outside the original request context.

### Fixed
- `analytics.query` now rejects duplicate grouping dimensions and mixed `searchAppearance` grouping at MCP input validation, before local rate-limit, Google credential, or provider work.

## [0.4.32] - 2026-09-24

### Added
- `urls.inspect` and successful `urls.inspect_many` items now include a conservative, schema-discoverable `index_status_summary` derived from Google's documented index-status verdict and key crawl/indexing fields while preserving the complete raw provider response.

### Changed
- Successful `sitemaps.submit` and `sitemaps.delete` results now expose explicit Search Console effect boundaries so agents do not mistake submission for completed processing/indexing or Search Console removal for deletion of the hosted sitemap file/deindexing.

## [0.4.31] - 2026-09-24

### Added
- Gemini CLI can now install this repository as a native extension, bundling the verified local Streamable HTTP MCP connection with the existing `gsc-weekly-review`, `gsc-indexing-triage`, and `gsc-search-opportunities` Agent Skills.

### Changed
- Exact Search Analytics country and device filters now reject malformed provider values before reserving local Search Analytics budget, resolving Google credentials, or calling Search Console; substring and RE2 regex operators remain unrestricted.
- `sites.list` and `sites.get` now expose explicit `verification_state` and `owner` fields alongside Google's raw `permissionLevel`, so agents can distinguish unverified properties and owner-only Indexing API prerequisites before choosing a property workflow.

## [0.4.30] - 2026-09-23

### Changed
- Search Analytics filters now default an omitted operator to Google's documented `equals` behavior in both `analytics.query` and `analytics.compare`, while both tools enforce the provider's 4096-character filter-expression ceiling through one shared schema.
- URL Inspection language codes are now validated as BCP-47 language tags before `urls.inspect` or `urls.inspect_many` can reserve local inspection budget, resolve Google credentials, or call the provider.

## [0.4.29] - 2026-09-23

### Fixed
- `urls.inspect_many` now rejects exact duplicate URLs before reserving local safety-budget units or calling Google, preventing one batch from wasting URL Inspection quota on repeated identical requests.
- `analytics.query` now rejects explicit `byPage` aggregation when the request also groups or filters by page, returning deterministic local guidance to use `auto` instead of forwarding a provider-invalid aggregation shape to Google.

## [0.4.28] - 2026-09-23

### Added
- GitHub Copilot CLI users can now register this repository as the `digestseo` plugin marketplace, discover/install `mcp-gsc` through the marketplace workflow, and still use the supported direct-repository install path.
- OpenAI Codex CLI and IDE users now have a verified one-command Streamable HTTP setup for the local `mcp-gsc` launcher.
- MCP initialization now supplies concise server-level workflow instructions so compatible agents preserve Search Console pagination, evidence, and Indexing API semantics across tools.

### Fixed
- Search Analytics `quotaExceeded` load failures now return provider-specific recovery guidance instead of an opaque raw 403 payload, while remaining outside the short transient retry loop because Google's documented recovery window is measured in minutes rather than seconds.

## [0.4.27] - 2026-09-23

### Added
- GitHub Copilot CLI can now install this repository directly as a plugin, bundling the existing `gsc-weekly-review`, `gsc-indexing-triage`, and `gsc-search-opportunities` Agent Skills with the verified local loopback MCP configuration.

### Fixed
- Direct Search Analytics-backed pagination in `analytics.query` and `indexing.list_pages` now treats short non-empty provider pages as potentially continuable and advances `next_start_row` by Google's requested page size, stopping only after an explicit empty provider page when no local response truncation remains.
- Idempotent Google read calls now apply the existing bounded retry policy when Search Console returns documented transient 403 rate-limit reasons, while permission/configuration 403 responses and write calls remain non-retried.

## [0.4.26] - 2026-09-23

### Fixed
- The published `npx` launcher now rejects malformed `TOKEN_ENCRYPTION_KEY` values before starting Wrangler, requiring valid base64 that decodes to exactly the documented 32-byte AES-256 key without logging the secret value.
- Higher-level Search Analytics pagination now follows Google's documented empty-page termination contract instead of stopping on any short non-empty page, preventing premature truncation when another provider page is still available.

## [0.4.25] - 2026-09-23

### Fixed
- Access-mode onboarding and Official MCP Registry metadata now identify all six read-write mutation tools after `indexing.remove` became part of the public tool surface.
- `analytics.query` now accepts provider-valid Discover and Google News rows with no `position` field instead of failing MCP structured-output validation; Search Console does not record average position for those surfaces.

## [0.4.24] - 2026-09-23

### Added
- `indexing.remove` publishes Google's supported `URL_DELETED` notification for previously eligible Indexing API pages after a bounded preflight confirms the URL already returns HTTP 404/410 or exposes a robots `noindex` meta directive. A successful notification is reported only as receipt acknowledgment, never as proof that Google completed removal.

### Changed
- Search Analytics date inputs now explicitly state Google's Pacific Time calendar (`America/Los_Angeles`, UTC-8/UTC-7 depending on daylight saving time), matching the server's existing Pacific-Time default/date-range calculations and preventing agents from interpreting YYYY-MM-DD inputs in the caller's local timezone or UTC.

## [0.4.23] - 2026-09-22

### Fixed
- The OAuth proxy now requires an explicit, CSRF-bound consent step that identifies the requesting MCP client and requested permissions before forwarding the browser to Google, preventing cached upstream Google consent from silently authorizing an untrusted MCP client. User or Google denial is returned to the validated MCP client as a terminal OAuth error instead of stranding the connection flow on a local error page.

## [0.4.22] - 2026-09-22

### Added
- The repository's Cursor plugin now bundles native `gsc-weekly-review`, `gsc-indexing-triage`, and `gsc-search-opportunities` Agent Skills that compose existing MCP tools into evidence-safe Search Console workflows without adding a second tool surface.

### Fixed
- The production Wrangler floor is now 4.136.3, and the Cloudflare Vitest plugin floor is 1.2.3, so runtime/test installs use Cloudflare's patched Wrangler line for the bundled `smol-toml` denial-of-service advisories GHSA-7w5x-hrqm-74c2 and GHSA-v3rj-xjv7-4jmq.

## [0.4.21] - 2026-09-22

### Fixed
- The published npm launcher now fails before starting Wrangler when any required Google OAuth/token-encryption environment variable is missing or blank, reporting only the missing variable names instead of allowing a broken local OAuth session to start.
- URL Inspection and Indexing API authorization now follow Search Console's literal URL-prefix property semantics instead of inventing a path-segment boundary when a provider-returned property identifier does not end in `/`.

## [0.4.20] - 2026-09-22

### Fixed
- Modern MCP requests that use the 2026-07-28 `Mcp-Method` header now fail with the required HTTP 400 `HeaderMismatch` error when `MCP-Protocol-Version` is missing, while legacy initialization without the modern header remains compatible.
- Repo-owned onboarding and support documentation no longer advertises the intentionally unavailable owner-hosted/automatic-weekly-email service, and Cursor guidance now identifies the one-click path as the local npm launcher.
- `GET /` now returns deployment-neutral discovery text with the derived MCP endpoint and canonical setup link instead of calling every deployment hosted or telling loopback users to connect it directly from Claude.ai.

## [0.4.19] - 2026-09-22

### Fixed
- Search Analytics freshness metadata now normalizes Google's camelCase `firstIncompleteDate` / `firstIncompleteHour` wire fields into the stable MCP `first_incomplete_date` / `first_incomplete_hour` response contract.
- The npm launcher now exits deterministically after its Wrangler child terminates by signal instead of re-signalling itself while its own `SIGINT`/`SIGTERM` listeners are installed, preventing wrapper processes from lingering after Ctrl+C or supervisor shutdown on POSIX systems.
- ChatGPT local-launcher guidance now explicitly requires Secure MCP Tunnel for the loopback `127.0.0.1` endpoint, or a separately deployed remote Worker, instead of implying that ChatGPT can connect directly to localhost.

## [0.4.18] - 2026-09-22

### Fixed
- The published npm launcher now keeps `GOOGLE_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY` out of Wrangler `--var` command-line arguments; Wrangler loads those declared local secrets directly from the child process environment instead.
- `server.capabilities` now distinguishes stored local Google credentials from live provider authorization, exposing the credential-state basis and explicitly reporting that the discovery call does not probe Google before claiming a connection is usable.

## [0.4.17] - 2026-09-22

### Added
- `indexing.status` reads Google's latest successful Indexing API update/remove notification receipts for a previously submitted URL while explicitly distinguishing notification receipt from crawl, index coverage, indexing completion, or removal completion.

### Fixed
- `sites.delete` now describes and reports Google's actual account-scoped effect: it removes the property from the connected user's Search Console site set rather than implying that the website itself or a global Search Console property is deleted.

## [0.4.16] - 2026-09-22

### Fixed
- High-level Search Analytics helpers now reserve their worst-case upstream request fan-out against the shared local safety budget, so paginated comparison/cannibalization/decay workflows cannot bypass the 10-minute limiter by hiding multiple Google API calls behind one MCP tool call.
- `indexing.request` now exposes Google's current Indexing API usage boundary: the default 200 publish requests/day/project is onboarding/testing capacity rather than ongoing-use approval, ongoing usage/resource provisioning requires approval, and all submissions are subject to spam detection.

## [0.4.15] - 2026-09-22

### Fixed
- `analytics.query` now distinguishes fresh preliminary Search Analytics data from finalized-data lag, echoes the requested `data_state`, and reports whether preliminary data is possible instead of implying a blanket 2-3 day delay.
- Repo-owned quick-connect configs and client docs now use the verified loopback npm launcher instead of routing new users to the intentionally unadvertised hosted remote while that deployment lags the current package.

## [0.4.14] - 2026-09-22

### Fixed
- `sites.add` now explicitly reports that adding a Search Console property does not perform ownership verification, preventing agents from confusing the Search Console Sites API with Google's separate Site Verification workflow.
- MCP write annotations now classify `sites.add` and `sitemaps.submit` as additive (`destructiveHint: false`) while keeping the delete tools destructive, matching the protocol's risk vocabulary instead of labeling every external mutation as destructive.

## [0.4.13] - 2026-09-22

### Fixed
- The published `npx` launcher now persists local Wrangler/KV/Durable Object state in a stable per-user directory instead of the versioned npm package cache, preserving the encrypted Google session across later package upgrades and ordinary npm cache cleanup; `MCP_GSC_STATE_DIR` can override the location. The first release with this change may require one Google reconnect because older launcher releases used the package cache for local state.
- Official MCP Registry discovery no longer advertises the owner-hosted remote while that deployment's tool contract lags the current npm package; the verified npm launcher remains the Registry installation path until hosted parity is restored.
- Search Analytics now exposes a machine-readable Generative AI report boundary instead of inviting agents to invent an unsupported selector: the current documented API has no dedicated Generative AI search type/filter, while AI Overviews and AI Mode remain included in overall web Search performance data.

## [0.4.12] - 2026-09-22

### Fixed
- `urls.inspect_many` now runs URL Inspection requests with bounded concurrency of three instead of strictly sequentially, reducing batch latency while preserving per-URL safety-budget accounting, input-order results, per-URL failures, and batch-fatal Google-access revocation.
- Search Analytics now rejects `searchAppearance` combined with another grouping dimension and documents Google's required two-step appearance discovery/filter workflow instead of sending invalid grouped requests to the provider.
- Brand/non-brand Search Analytics guidance now distinguishes caller-supplied regex segmentation from Search Console's AI-assisted native Branded/Non-branded filter, which the Search Analytics API does not expose.

## [0.4.11] - 2026-09-22

### Fixed
- Sitemap read tools now explain Google's `lastSubmitted` and `lastDownloaded` timestamp semantics so agents do not mistake Search Console submission/download times for sitemap-file modification, page-crawl, or indexing timestamps.
- Google News Search Analytics now rejects unsupported query grouping/filtering, marks average position unavailable, and removes Google News from query-centric and average-position comparison helpers while preserving supported page/country/date/device/appearance and News Showcase reporting.

## [0.4.10] - 2026-09-21

### Fixed
- The published `npx` launcher now resolves `wrangler.example.jsonc` from the installed package instead of the caller's working directory, so `npx -y @digestseo/mcp-gsc` works outside a cloned repository.

## [0.4.9] - 2026-09-21

### Changed
- `sites.list` now marks whether each returned property identifier matches the URL-prefix / `sc-domain:` forms currently documented by the Search Console API, and the docs explicitly avoid guessing an undocumented API identifier for Search Console platform properties.

### Fixed
- `analytics.query` now exposes `position_supported: false` plus an explicit note for Google Discover responses so agents do not interpret the generic row `position` field as a supported Discover metric.

## [0.4.8] - 2026-09-21

### Fixed
- Safe Google read operations now make a tightly bounded retry on transient `408`, `429`, and `5xx` provider failures while leaving Search Console writes and OAuth/token mutation paths single-attempt; long `Retry-After` windows are surfaced immediately instead of stalling an MCP call.
- The published `npx` launcher now forwards `GSC_ACCESS_MODE`, and MCP Registry package metadata exposes the same setting, so local self-hosters can actually select least-privilege `readonly` mode instead of silently inheriting the template's `readwrite` binding.

## [0.4.7] - 2026-09-21

### Fixed
- Weekly-digest query movers no longer treat a query missing from one bounded top-query response as zero traffic; comparisons now require the query to be present in both weekly result sets and explain that Search Analytics does not guarantee every data row.
- Period comparison and content-decay analysis no longer fabricate zero metrics for dimension keys or pages missing from one non-exhaustive Search Analytics response; they now compare only rows returned in both periods and expose that scope explicitly.

## [0.4.6] - 2026-09-21

### Fixed
- Package metadata and install guidance now advertise the actual Node.js ranges accepted by bundled runtime dependencies (`^22.18.0 || >=24.11.0`) instead of claiming all Node.js 22+ releases are supported.
- Indexing API eligibility preflight now recognizes static JSON-LD, Microdata, and RDFa type markup, including schema.org URL type spellings, instead of rejecting otherwise eligible static pages solely because they do not use the narrow JSON-LD form previously detected.
- URL Inspection now rejects malformed/non-HTTP(S) URLs and URLs outside the supplied Search Console property locally before consuming the server's inspection safety budget or calling Google.

## [0.4.5] - 2026-09-21

### Fixed
- Search Console property inputs now reject malformed, relative, unsupported-scheme, credential-bearing, and malformed `sc-domain:` identifiers locally across all tools instead of deferring obvious property-identifier errors to Google.
- Sitemap get/list-filter/submit/delete inputs now reject malformed, relative, and non-HTTP(S) sitemap URLs locally instead of deferring obvious contract errors to Google.

## [0.4.4] - 2026-09-21

### Fixed
- Search Analytics requests grouped by `hour` now require the documented `hourly_all` data state and reject hourly windows longer than Google's documented 10-day limit before calling the provider.
- Search Analytics outputs now distinguish local pagination completeness from Google's provider-level limitation that only top rows are guaranteed, preventing agents from treating a fully fetched local window as an exhaustive dataset.

## [0.4.3] - 2026-09-21

### Changed
- The documented and npm-declared Node.js minimum is now 22+, matching the bundled Wrangler 4 runtime requirement instead of advertising unsupported Node.js 20 installs.

### Fixed
- URL Inspection guidance now states that Google reports the version currently in its index rather than running a live URL test, and no longer presents the deprecated mobile-usability field as a current primary signal.

## [0.4.2] - 2026-09-21

### Fixed
- Search Analytics now rejects malformed exact-match country/device filters during MCP input validation, before local rate-limit, credential, or Google API work, while preserving contains and regex filter semantics.
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
