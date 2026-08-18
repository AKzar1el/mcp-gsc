# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Instead, use
[GitHub's private vulnerability reporting](https://github.com/AKzar1el/mcp-gsc/security/advisories/new)
on this repository. You'll get a response within a few days.

## What this server stores and how

A deployed instance of `mcp-gsc` handles Google OAuth credentials on behalf of
its users. The full data inventory:

| Data | Where | Protection |
|---|---|---|
| Google **refresh token** (per user) | Workers KV (`USER_KV`) | Encrypted at rest with **AES-256-GCM** (`src/crypto.ts`) using the `TOKEN_ENCRYPTION_KEY` secret; a fresh random IV per encryption. |
| Google account **id and email** (per user) | Workers KV (`USER_KV`) | Stored in plaintext alongside the encrypted token, used only to key and label the record. |
| Pending OAuth state | Durable Object storage (`PendingAuthState`) | Stored per nonce; consumed through a strongly consistent transaction so exactly one callback succeeds; expires after 10 minutes. |
| Tool rate-limit state | Durable Object storage (`ToolRateLimiter`) | Stores a SHA-256-derived user bucket plus counter/window state; never stores tool arguments, URLs, tokens, or response data. |
| MCP client tokens | Workers KV (`OAUTH_KV`) | Managed by [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider). |
| Google **access tokens** | In-memory only (Durable Object) | Never written to storage; expire within an hour. |

Notes:

- The server requests only the **read-only** scope
  `https://www.googleapis.com/auth/webmasters.readonly` (plus `openid email`
  for identifying the account). It cannot modify Search Console data.
- Secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`)
  are read from Worker secrets / `.dev.vars`, never from the repository.
- When Google reports a refresh token as revoked (`invalid_grant`), the stored
  user record is deleted immediately.
- Search Console data is fetched on demand and returned to the MCP client;
  it is never persisted by this server.

## Tool rate limits

The server enforces the following fixed-window limits before making upstream
requests. They are per authenticated user and tool category; `indexing.request`
also has a deployment-wide project guard. A rejected invocation returns a retry
delay and does not disclose another user's usage.

| Category | Tools | Limit |
|---|---|---|
| Search Analytics | `analytics.query`, `insights.quick_wins`, `insights.cannibalization`, `insights.content_decay`, `indexing.list_pages`, `analytics.compare` | 30 per user / 10 minutes |
| URL inspection | `urls.inspect` | 20 per user / 24 hours |
| Search Console writes | `sites.add`, `sites.delete`, `sitemaps.submit`, `sitemaps.delete` | 10 per user / hour |
| Indexing publish | `indexing.request` | 2 per user / 24 hours; 200 per deployment / 24 hours |
| Weekly digest | `reports.weekly_digest` | 6 per user / hour |

The Indexing API's default publish quota is 200 requests per project per day.
Search Analytics and URL Inspection have separate load and per-site quotas, so
these limits are intentionally conservative rather than a replacement for
monitoring the Google Cloud project quota.

## Supported versions

Only the latest release on `main` is supported with security fixes.
