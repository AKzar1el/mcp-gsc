# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
