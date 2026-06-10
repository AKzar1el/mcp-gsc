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
| Pending OAuth state | Workers KV (`OAUTH_KV`) | Single-use nonce, expires automatically after 10 minutes. |
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

## Supported versions

Only the latest release on `main` is supported with security fixes.
