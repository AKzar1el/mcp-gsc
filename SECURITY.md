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
| Google **access tokens** | Worker isolate memory only | Cached per Google user id by `GoogleAccessTokenLifecycle`; never written to storage and discarded with the isolate. Tokens expire within an hour. |

Notes:

- Access is configured by `GSC_ACCESS_MODE`; the default is `readwrite` to
  preserve existing deployments' behavior. In that mode the server requests
  `openid`, `email`, `https://www.googleapis.com/auth/webmasters` (the
  read-write Search Console scope), and
  `https://www.googleapis.com/auth/indexing`. It registers write-capable
  tools to add/delete properties, submit/delete sitemaps, and send eligible
  Indexing API notifications.
- With `GSC_ACCESS_MODE=readonly`, the server requests only `openid`, `email`,
  and `https://www.googleapis.com/auth/webmasters.readonly`. It does not
  register `sites.add`, `sites.delete`, `sitemaps.submit`, `sitemaps.delete`,
  `indexing.request`, or `indexing.remove`; the remaining tool suite uses APIs that accept the
  read-only Search Console scope.
- The Indexing API is requested only in read-write mode for `indexing.request`,
  `indexing.remove`, and the otherwise read-only `indexing.status` lookup.
  Google restricts that API to `JobPosting` pages or livestream pages with a
  `BroadcastEvent` inside a `VideoObject`; it is not a general page-submission
  API.
- Secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`)
  are read from Worker secrets / `.dev.vars`, never from the repository.
- When Google reports a refresh token as revoked (`invalid_grant`), the stored
  user record is deleted immediately.
- MCP requests use Cloudflare's stateless MCP handler. The historical
  `GscMcpAgent` Durable Object remains only as an unrouted compatibility shell;
  it does not hold Google access-token cache state.
- Search Console data is fetched on demand and returned to the MCP client;
  it is never persisted by this server.

## Tool rate limits

The server enforces the following fixed-window limits before making upstream
requests. They are per authenticated user and tool category; the Indexing API
publish and metadata-read categories also have deployment-wide project guards. A rejected invocation returns a retry
delay and does not disclose another user's usage.

| Category | Tools | Limit |
|---|---|---|
| Search Analytics | `analytics.query`, `insights.quick_wins`, `insights.cannibalization`, `insights.content_decay`, `indexing.list_pages`, `analytics.compare` | 30 per user / 10 minutes |
| URL inspection | `urls.inspect`, `urls.inspect_many` | 20 inspected URLs per user / 24 hours; batch requests reserve one unit per URL and run at most 3 inspections concurrently |
| Search Console writes | `sites.add`, `sites.delete`, `sitemaps.submit`, `sitemaps.delete` | 10 per user / hour |
| Indexing publish | `indexing.request`, `indexing.remove` | 2 per user / 24 hours; 200 per deployment / 24 hours |
| Indexing metadata | `indexing.status` | 30 per user / minute; 180 per deployment / minute |
| Weekly digest | `reports.weekly_digest` | 6 per user / hour |

The Indexing API's default publish quota is 200 requests per project per day,
and its default metadata-read quota is 180 requests per project per minute.
Search Analytics and URL Inspection have separate load and per-site quotas, so
these limits are intentionally conservative rather than a replacement for
monitoring the Google Cloud project quota.

## Supported versions

Only the latest release on `main` is supported with security fixes.
