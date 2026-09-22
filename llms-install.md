# llms-install.md — agent installation guide for mcp-gsc

This file is for AI agents (Cline, Claude Code, Cursor, etc.) installing `mcp-gsc` on behalf of a user. It takes the user from zero to a personal, self-hosted instance on Cloudflare Workers. The human-oriented walkthrough with full explanations is [SETUP.md](SETUP.md) — this file mirrors it in deterministic, copy-pasteable steps.

**What you are deploying:** a remote MCP server for Google Search Console with 23 tools in the default read-write mode: read-only analytics/reporting plus explicit property, sitemap, and indexing operations. It runs on the user's own Cloudflare account with the user's own Google OAuth credentials. The connect URL at the end is `https://<worker-host>/mcp`. For analytics/reporting-only installs, prefer the least-privilege `GSC_ACCESS_MODE=readonly` mode: it requests only Search Console read access and exposes the 16 tools that do not require either write access or the separate Indexing API scope.

**Security rule for agents:** the three secrets in Step 6 are entered by the **user directly into the terminal prompt** opened by `wrangler secret put`. Never ask the user to paste a secret into the chat, and never echo a secret back.

## Prerequisites (check before starting)

1. **Node.js 22.18+ within the 22.x line, or Node.js 24.11+ with npm** - verify with `node --version`. The bundled runtime dependency graph includes Babel 8 packages with this stricter Node support range.
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

The server needs two Workers KV namespaces: `OAUTH_KV` (data required by the OAuth provider) and `USER_KV` (encrypted refresh tokens). Pending OAuth state uses a Durable Object so it can be consumed exactly once. Run exactly:

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

After pasting the two ids, choose the deployment access mode in the existing `vars` block. For analytics, reporting, URL inspection, and other non-mutating workflows, prefer least-privilege read-only access:

```jsonc
"vars": {
  "GSC_ACCESS_MODE": "readonly"
}
```

Keep `"GSC_ACCESS_MODE": "readwrite"` only when the user explicitly needs the six mutation tools for property, sitemap, or eligible Indexing API operations. This choice also determines which Google OAuth scopes to add in Step 5; changing it later requires affected users to reconnect so Google grants the matching scope set.

Do not rename the `OAUTH_KV`/`USER_KV` bindings, the Durable Object bindings `MCP_OBJECT` with class `GscMcpAgent` or `PENDING_AUTH_STATE` with class `PendingAuthState`, or the migrations (`v1` for `GscMcpAgent` and `v2` for `PendingAuthState`). The MCP endpoint itself is stateless; `GscMcpAgent` is retained as a compatibility shell so existing deployments do not need a destructive Durable Object migration. The remaining bindings are used by OAuth state and tool-rate-limit coordination.

## Step 4 — First deploy (to learn the Worker URL)

```bash
npx wrangler deploy
```

Wrangler prints the Worker URL, e.g. `https://mcp-gsc.<account-subdomain>.workers.dev`. Record it — Step 5 needs the exact host. The Worker will not serve OAuth flows until the secrets are set in Step 6; that is expected at this point.

## Step 5 — Create the Google OAuth client

These steps happen in the user's browser at <https://console.cloud.google.com/> — guide the user through them:

1. Create a new Google Cloud project (any name, e.g. `mcp-gsc`).
2. Enable the **Google Search Console API**: <https://console.cloud.google.com/apis/library/searchconsole.googleapis.com> → **Enable**.
3. Configure Google Auth Platform:
   - Open **Google Auth platform → Branding**. If Google says the Auth platform is not configured yet, click **Get Started**, enter the app name and user support email, choose **Audience: External**, add the developer contact email, review the Google API Services User Data Policy, then **Continue → Create**. If it is already configured, review the existing Branding/Audience settings instead of starting over.
   - Open **Google Auth platform → Audience** and add the user's Google email under **Test users**.
   - Open **Google Auth platform → Data Access → Add or remove scopes** and add only the scopes that match the `GSC_ACCESS_MODE` selected in Step 3:

     | `GSC_ACCESS_MODE` | Google OAuth scopes to add |
     |---|---|
     | `readonly` (preferred for analytics/reporting-only installs) | `https://www.googleapis.com/auth/webmasters.readonly` |
     | `readwrite` (needed for mutation tools) | `https://www.googleapis.com/auth/webmasters` and `https://www.googleapis.com/auth/indexing` |

     Do not add the broader write/indexing scopes to a read-only deployment. Google recommends requesting the narrowest scopes an app actually needs.

   - Save the Data Access changes and leave **Publishing status** as **Testing** on the **Audience** page. (Important caveat: in Testing mode, Google expires refresh tokens after **7 days** and shows an "unverified app" warning at sign-in. See [SETUP.md Step 7](SETUP.md#step-7--important-google-verification) — tell the user about this.)
4. Create the OAuth client from **Google Auth platform → Clients → Create Client**:
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

   - **Claude.ai / Claude Desktop** — open **Customize → Connectors**, click **+ → Add custom connector**, enter a name, and paste the `/mcp` URL. Leave the optional advanced OAuth Client ID/Secret fields blank. On Team/Enterprise, an Owner or Primary Owner must first add the custom Web connector from **Organization settings → Connectors**; members then connect it from Customize → Connectors.
   - **Claude Code** — `claude mcp add --transport http gsc https://<worker-host>/mcp`
   - **Cursor / Cline** — add a remote **Streamable HTTP** MCP server with the same `/mcp` URL. Cursor supports OAuth for remote HTTP MCP servers.
   - **ChatGPT** — enable **Developer mode**, then create a custom MCP **app** from **Settings → Apps → Create** (admins/owners can also use **Workspace settings → Apps → Create**). Provide the `/mcp` endpoint, select the applicable authentication option, **Scan Tools**, complete OAuth, then create the app. Full write/modify MCP is currently Business/Enterprise/Edu; Pro custom MCP is read/fetch-only, so keep this deployment in `GSC_ACCESS_MODE=readonly` for that path.

3. **Final confirmation (requires the user):** when the client connects, it opens a Google sign-in page. Have the user sign in once with the Google account added as a **test user** in Step 5 and grant read access. Expect Google's *"Google hasn't verified this app"* warning (Testing mode) — the user clicks **Advanced → Go to \<app\> (unsafe)** to continue; this is expected for an unverified personal instance. The install is verified when a tool call succeeds, e.g. asking the assistant: *"What sites do I have in Search Console?"*

## Troubleshooting

- **`redirect_uri_mismatch`** — the redirect URI in Step 5 must match the Worker host exactly, including `https://` and the `/google/callback` path.
- **`Google did not return a refresh_token`** — the user should remove the app at <https://myaccount.google.com/permissions> and reconnect to force a fresh consent.
- **"Google access revoked" after about a week** — the 7-day Testing-mode expiry; reconnect, or complete Google verification ([SETUP.md Step 7](SETUP.md#step-7--important-google-verification)).
- **401 on `/mcp`** — expected when unauthenticated; connect through the MCP client's OAuth flow instead of opening `/mcp` in a browser.
