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
| MCP client tokens | Workers KV (`OAUTH_KV`) | Managed by [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider). |
| Google **access tokens** | In-memory only (Durable Object) | Never written to storage; expire within an hour. |

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
  or `indexing.request`; the remaining tool suite uses APIs that accept the
  read-only Search Console scope.
- The Indexing API is requested only in read-write mode for `indexing.request`.
  Google restricts that API to `JobPosting` pages or livestream pages with a
  `BroadcastEvent` inside a `VideoObject`; it is not a general page-submission
  API.
- Secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`)
  are read from Worker secrets / `.dev.vars`, never from the repository.
- When Google reports a refresh token as revoked (`invalid_grant`), the stored
  user record is deleted immediately.
- Search Console data is fetched on demand and returned to the MCP client;
  it is never persisted by this server.

## Supported versions

Only the latest release on `main` is supported with security fixes.
