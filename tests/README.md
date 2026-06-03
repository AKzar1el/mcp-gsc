# Smoke tests

A `node:test` script that exercises the deployed mcp-gsc Worker end-to-end to catch obvious regressions after every deploy. Runs in well under 30 seconds.

## What this is and isn't

These are **structural** smoke tests, not data tests. They assert things that should hold for any working server with any user's GSC data:

- The Worker is reachable.
- The unauthenticated endpoints (`/`, `/healthz`, malformed `/authorize`, unauthenticated `/mcp`) return the expected status codes.
- With a real token, the MCP advertises all 5 expected tool names (`list_sites`, `query_search_analytics`, `inspect_url`, `list_sitemaps`, `get_capabilities`).
- The `list_sites` tool returns a valid JSON array.

They explicitly do **not** assert any specific GSC numbers — impressions, clicks, positions, query strings — because that data is live and changes daily. Any test that asserts a specific number will be flaky within a week and must be rejected at review.

## Running

```bash
npm run test:smoke
```

Requires Node 20+ (for the stable built-in test runner and `--test` exit codes). No npm dependencies, no `jq`, no `bash` — works the same on Windows, macOS, and Linux.

Reads configuration from `tests/../.env.test` (gitignored) and from the shell environment. The shell environment overrides `.env.test` for any variable that's already exported.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `MCP_BASE_URL` | no | `https://your-worker.workers.dev` | Base URL of your deployed Worker, no trailing slash. |
| `MCP_ACCESS_TOKEN` | only for checks 5-6 | unset | A valid MCP access token issued by this Worker's OAuth provider. |

Without `MCP_ACCESS_TOKEN`, checks 5-6 are reported as skipped — checks 1-4 remain useful on their own.

## Obtaining `MCP_ACCESS_TOKEN` once

1. In Claude.ai → Settings → Connectors → Add custom connector, paste `${MCP_BASE_URL}/mcp` and complete the Google OAuth handshake. The connector should turn green.

2. List the OAuth provider's KV namespace:

   ```bash
   npx wrangler kv key list --binding OAUTH_KV --remote
   ```

   The `@cloudflare/workers-oauth-provider` package stores issued access tokens under a key prefix (e.g. `token:<the-token>`). Identify the entry that maps to the session you just created.

3. Save the token value (without the prefix) into `tests/../.env.test`:

   ```bash
   echo "MCP_ACCESS_TOKEN=<the-token>" >> .env.test
   ```

   `.env.test` is gitignored. Do not commit the token.

## Exit codes

- `0` — no failed checks (skips are not failures).
- non-zero — at least one assertion failed.

## Adding new checks

Two rules:

1. The check must be deterministic across days. If running the same script today and next week against the same working server can produce different results, the check is wrong.
2. No assertions on specific GSC values. Only assertions on structure (status codes, JSON keys, tool names).
