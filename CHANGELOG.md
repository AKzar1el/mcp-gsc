# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — unreleased

### Added
- `get_capabilities` tool — returns the tool catalog and a non-destructive auth-status probe for better first-run discovery in lazy-loading clients.

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
