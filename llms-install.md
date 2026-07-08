# llms-install.md — agent installation guide for mcp-gsc

This file is for AI agents (Cline, Claude Code, Cursor, etc.) installing `mcp-gsc` on behalf of a user. It takes the user from zero to a personal, self-hosted instance on Cloudflare Workers. The human-oriented walkthrough with full explanations is [SETUP.md](SETUP.md) — this file mirrors it in deterministic, copy-pasteable steps.

**What you are deploying:** a remote MCP server for Google Search Console (five read-only tools) that runs on the user's own Cloudflare account with the user's own Google OAuth credentials. The connect URL at the end is `https://<worker-host>/mcp`.

**Security rule for agents:** the three secrets in Step 6 are entered by the **user directly into the terminal prompt** opened by `wrangler secret put`. Never ask the user to paste a secret into the chat, and never echo a secret back.

## Prerequisites (check before starting)

1. **Node.js 20+ and npm** — verify with `node --version`.
2. **A Cloudflare account** — the free Workers plan is enough. If the user has none, have them sign up at <https://dash.cloudflare.com/sign-up>.
3. **A Google account** with access to the Search Console properties the user wants to query, and permission to create a Google Cloud project at <https://console.cloud.google.com/>.
4. **Wrangler authenticated** — run:

   ```bash
   npx wrangler login
   ```

   This opens a browser; the user completes the Cloudflare login there.

## Step 1 — Clone and install

```bash
git clone https://github.com/AKzar1el/mcp-gsc.git
cd mcp-gsc
npm ci
```

## Step 2 — Create the two KV namespaces

The server needs two Workers KV namespaces: `OAUTH_KV` (pending OAuth state and issued tokens) and `USER_KV` (encrypted refresh tokens). Run exactly:

```bash
npx wrangler kv namespace create OAUTH_KV
npx wrangler kv namespace create USER_KV
```

Each command prints an `id`. Capture both ids for Step 3.

## Step 3 — Create wrangler.jsonc and paste the KV ids

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

(`wrangler.jsonc` is gitignored; the template stays in git.)

Edit `wrangler.jsonc` and replace the two placeholder ids with the ids from Step 2:

```jsonc
"kv_namespaces": [
  { "binding": "OAUTH_KV", "id": "YOUR_OAUTH_KV_ID" },   // ← paste the OAUTH_KV id
  { "binding": "USER_KV",  "id": "YOUR_USER_KV_ID" }      // ← paste the USER_KV id
]
```

Change **only** those two ids. Do not rename the `OAUTH_KV`/`USER_KV` bindings, the Durable Object binding `MCP_OBJECT` with class `GscMcpAgent`, or the `migrations` block (tag `v1`, `new_sqlite_classes: ["GscMcpAgent"]`) — the code depends on these exact names, and the migration is applied automatically on first deploy.

## Step 4 — First deploy (to learn the Worker URL)

```bash
npx wrangler deploy
```

Wrangler prints the Worker URL, e.g. `https://mcp-gsc.<account-subdomain>.workers.dev`. Record it — Step 5 needs the exact host. The Worker will not serve OAuth flows until the secrets are set in Step 6; that is expected at this point.

## Step 5 — Create the Google OAuth client

These steps happen in the user's browser at <https://console.cloud.google.com/> — guide the user through them:

1. Create a new Google Cloud project (any name, e.g. `mcp-gsc`).
2. Enable the **Google Search Console API**: <https://console.cloud.google.com/apis/library/searchconsole.googleapis.com> → **Enable**.
3. Configure the OAuth consent screen (**APIs & Services → OAuth consent screen**):
   - **User type: External** → Create.
   - Fill in app name, user support email, developer contact email.
   - On the **Scopes** step, add these scopes:

     ```
     https://www.googleapis.com/auth/webmasters
     https://www.googleapis.com/auth/indexing
     ```

   - On the **Test users** step, add the user's own Google email address.
   - Save, leaving **Publishing status** as **Testing**. (Important caveat: in Testing mode, Google expires refresh tokens after **7 days** and shows an "unverified app" warning at sign-in. See [SETUP.md Step 7](SETUP.md#step-7--important-google-verification) — tell the user about this.)
4. Create the OAuth client (**APIs & Services → Credentials → Create credentials → OAuth client ID**):
   - **Application type: Web application.**
   - Under **Authorized redirect URIs**, add both (replace `<worker-host>` with the host from Step 4, path exactly `/google/callback`):

     ```
     https://<worker-host>/google/callback
     http://localhost:8787/google/callback
     ```

5. Click **Create**. The user keeps the **Client ID** and **Client secret** ready for the next step — in their clipboard or a local note, not in the chat.

## Step 6 — Set the three Worker secrets

Run each command; `wrangler` opens an interactive prompt and the **user pastes the value into the terminal** (never into the chat):

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
# user pastes the Client ID from Step 5

npx wrangler secret put GOOGLE_CLIENT_SECRET
# user pastes the Client secret from Step 5

npx wrangler secret put TOKEN_ENCRYPTION_KEY
# user pastes a fresh 32-byte base64 key, generated below
```

Generate the `TOKEN_ENCRYPTION_KEY` value first so the user can paste it at the prompt:

```bash
openssl rand -base64 32
```

If `openssl` is unavailable (e.g. plain Windows), this is equivalent:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

This key encrypts each user's Google refresh token before it is stored in KV (AES-256, `src/crypto.ts`). If it is lost, stored tokens become undecryptable and every user must reconnect.

## Step 7 — Deploy again with secrets in place

```bash
npx wrangler deploy
```

## Step 8 — Verify

1. Health check:

   ```bash
   curl https://<worker-host>/healthz
   ```

   Expected output: `ok`

2. Connect the server in the user's MCP client using:

   ```
   https://<worker-host>/mcp
   ```

   - **Claude.ai / Claude Desktop** — Settings → Connectors → **Add custom connector** → paste the `/mcp` URL, leave Client ID and Client Secret blank.
   - **Claude Code** — `claude mcp add --transport http gsc https://<worker-host>/mcp`
   - **Cline / Cursor / ChatGPT** — add a remote (streamable HTTP) MCP server with the same `/mcp` URL.

3. **Final confirmation (requires the user):** when the client connects, it opens a Google sign-in page. Have the user sign in once with the Google account added as a **test user** in Step 5 and grant read access. Expect Google's *"Google hasn't verified this app"* warning (Testing mode) — the user clicks **Advanced → Go to \<app\> (unsafe)** to continue; this is expected for an unverified personal instance. The install is verified when a tool call succeeds, e.g. asking the assistant: *"What sites do I have in Search Console?"*

## Troubleshooting

- **`redirect_uri_mismatch`** — the redirect URI in Step 5 must match the Worker host exactly, including `https://` and the `/google/callback` path.
- **`Google did not return a refresh_token`** — the user should remove the app at <https://myaccount.google.com/permissions> and reconnect to force a fresh consent.
- **"Google access revoked" after about a week** — the 7-day Testing-mode expiry; reconnect, or complete Google verification ([SETUP.md Step 7](SETUP.md#step-7--important-google-verification)).
- **401 on `/mcp`** — expected when unauthenticated; connect through the MCP client's OAuth flow instead of opening `/mcp` in a browser.
