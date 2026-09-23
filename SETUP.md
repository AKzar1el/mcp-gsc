# Setup — self-hosting mcp-gsc

This guide walks you through deploying your own instance of `mcp-gsc` on Cloudflare Workers with your own Google OAuth credentials ("bring your own OAuth"). Budget about 30–40 minutes the first time.

By the end you'll have a Worker at `https://<your-worker>.workers.dev/mcp` that you can connect as a remote MCP integration in Claude, Cursor, or ChatGPT.

> **Read [Step 7](#step-7--important-google-verification) before you start.** While your Google OAuth app is unverified, refresh tokens expire after **7 days** and you're capped at **100 users**. This is the single biggest reason self-hosting a Google Search Console MCP is heavier than a key-based MCP — it's how Google's OAuth works for the sensitive `webmasters` and `indexing` scopes, not a limitation of this project.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (the free Workers plan is enough to start).
- A [Google account](https://accounts.google.com/) with access to the Search Console properties you want to query.
- Node.js 22.18+ within the 22.x line, or Node.js 24.11+ with npm. The bundled runtime dependency graph includes Babel 8 packages with this stricter Node support range.
- The Wrangler CLI — installed for you by `npm install`; invoke it with `npx wrangler …`.

Clone and install:

```bash
git clone https://github.com/<you>/mcp-gsc.git
cd mcp-gsc
npm install
```

Authenticate Wrangler with Cloudflare (opens a browser):

```bash
npx wrangler login
```

---

## Step 1 — Create a Google Cloud project and enable the Search Console API

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (top bar → project dropdown → **New Project**). Name it anything, e.g. `mcp-gsc`.
3. With that project selected, enable the **Google Search Console API**:
   - Go to **APIs & Services → Library**.
   - Search for **"Google Search Console API"**.
   - Open it and click **Enable**.

   Direct link: <https://console.cloud.google.com/apis/library/searchconsole.googleapis.com>

---

## Step 2 — Configure Google Auth Platform

1. In the Google Cloud console, go to **Google Auth platform → Branding**.
2. If Google says the Auth platform is not configured yet, click **Get Started** and complete the setup wizard:
   - **App Information:** enter the app name and user support email.
   - **Audience:** choose **External**.
   - **Contact Information:** enter the developer contact email.
   - **Finish:** review the Google API Services User Data Policy, agree if appropriate, then click **Continue → Create**.
   If the Auth platform is already configured, review the existing **Branding** and **Audience** settings instead of starting over.
3. Go to **Google Auth platform → Audience**. Under **Test users**, click **Add users** and add your own Google email address (and any teammates who need access while the app is in Testing).
4. Go to **Google Auth platform → Data Access → Add or remove scopes**. Choose the access mode for this deployment and add the matching scope set:

   | `GSC_ACCESS_MODE` | Scopes to add |
   |---|---|
   | `readwrite` (default) | `https://www.googleapis.com/auth/webmasters` and `https://www.googleapis.com/auth/indexing` |
   | `readonly` | `https://www.googleapis.com/auth/webmasters.readonly` |

   `readwrite` preserves the full tool surface: it grants Search Console read-write access and the Indexing API scope required to manage sites, sitemaps, and request URL crawling. `readonly` requests only the Search Console read-only scope and omits the mutation tools.

   Note that the Indexing API itself is narrow: Google currently restricts it to pages containing `JobPosting` structured data or livestream pages containing `BroadcastEvent` inside `VideoObject`. It is not available for general webpage submission - the `indexing.request` tool checks a page's structured data before submitting and returns an error for ineligible URLs. `indexing.remove` is for previously eligible pages and requires the URL to already return HTTP 404/410 or expose a robots `noindex` meta directive before it sends Google's `URL_DELETED` notification. Google's default **200 publish requests/day/project** is shared by update and removal notifications and is explicitly for onboarding and submission testing; ongoing usage/resource provisioning requires additional Google approval. All submissions are subject to spam detection, and Google warns that abuse or attempts to exceed quotas through multiple accounts or other means can result in revoked access. The server's own lower safety limits do not constitute Google approval or increase provider quota.
5. Save the Data Access changes. In **Google Auth platform → Audience**, leave **Publishing status** as **Testing** for now — see [Step 7](#step-7--important-google-verification).

---

## Step 3 — Create an OAuth client (Web application)

1. Go to **Google Auth platform → Clients → Create Client**.
2. **Application type: Web application.**
3. Under **Authorized redirect URIs**, add the entries for the ways you will run mcp-gsc:

   ```
   https://<your-worker>.workers.dev/google/callback
   http://localhost:8787/google/callback
   http://127.0.0.1:8080/google/callback
   ```

   - Replace `<your-worker>` with your Worker's name + subdomain. If you don't know it yet, deploy once (Step 6) to see the assigned `*.workers.dev` URL, then come back and add it here. The default Worker name is `mcp-gsc` (set in `wrangler.jsonc`).
   - The `http://localhost:8787/google/callback` entry is for local development with `npm run dev`.
   - The `http://127.0.0.1:8080/google/callback` entry is for the published `npx -y @digestseo/mcp-gsc` launcher, whose Registry transport is `http://127.0.0.1:8080/mcp` by default. If you set `PORT`, replace `8080` with that exact port.
   - The `npx` launcher persists its local KV and Durable Object state in `~/.mcp-gsc/state` by default so npm package upgrades or cache cleanup do not discard the encrypted Google session. Set `MCP_GSC_STATE_DIR` to use another directory, and keep the same `TOKEN_ENCRYPTION_KEY` when reusing existing state. The first release with this stable path may require one Google reconnect because older launcher releases stored local state under the npm package cache.
   - The Worker derives Google's redirect URI from the MCP request URL. Google requires an exact authorized-URI match, so keep the same scheme, host, port, and `/google/callback` path. `localhost` and `127.0.0.1` are different hosts for this check.
   - The path must be exactly `/google/callback` — that's the route this server handles.
4. Click **Create**. Copy the **Client ID** and **Client secret** — you'll set them as secrets in the next step.

---

## Step 4 — Set the Worker secrets

This server reads three secrets. **Never commit these to git** — set them with `wrangler secret put`, which stores them encrypted in Cloudflare:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
# paste the Client ID from Step 3

npx wrangler secret put GOOGLE_CLIENT_SECRET
# paste the Client secret from Step 3

npx wrangler secret put TOKEN_ENCRYPTION_KEY
# paste the key generated below
```

`TOKEN_ENCRYPTION_KEY` is the **AES-256 key** used by `src/crypto.ts` to encrypt each user's Google refresh token before it's stored in KV. Generate a fresh 32-byte key, base64-encoded:

```bash
openssl rand -base64 32
```

Paste that value when prompted. Keep it safe — if you lose it, the refresh tokens already in KV become undecryptable and every user has to reconnect.

The published `npx` launcher validates this exact key format before starting Wrangler. A malformed base64 value or a value that does not decode to exactly 32 bytes is rejected without printing the secret value.

For **local development**, put the same three values in `.dev.vars` instead — copy `.dev.vars.example` to `.dev.vars` (it's gitignored). The published npm launcher can also read them from the process environment; its bundled Wrangler config declares `GOOGLE_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY` as required local secrets so those sensitive values do not need to be serialized into `--var` command-line arguments:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
TOKEN_ENCRYPTION_KEY=...
GSC_ACCESS_MODE=readwrite
```

---

## Step 5 — Create the KV namespaces

The server uses two Workers KV namespaces: `OAUTH_KV` (data required by the OAuth provider) and `USER_KV` (encrypted refresh tokens, keyed per user). Pending OAuth state is stored separately in a Durable Object so each nonce can be consumed exactly once.

```bash
npx wrangler kv namespace create OAUTH_KV
npx wrangler kv namespace create USER_KV
```

Each command prints an `id`. Copy the template to your real config and paste the two ids in:

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Then edit `wrangler.jsonc` and replace the placeholders:

```jsonc
"kv_namespaces": [
  { "binding": "OAUTH_KV", "id": "YOUR_OAUTH_KV_ID" },   // ← paste OAUTH_KV id
  { "binding": "USER_KV",  "id": "YOUR_USER_KV_ID" }      // ← paste USER_KV id
]
```

The template also sets `GSC_ACCESS_MODE` to `readwrite`, preserving the historical behavior. To deploy least-privilege read-only access, set it to `readonly` before deploying:

```jsonc
"vars": {
  "GSC_ACCESS_MODE": "readonly"
}
```

Read-only deployments request `webmasters.readonly`, omit the Indexing API scope, and do not register `sites.add`, `sites.delete`, `sitemaps.submit`, `sitemaps.delete`, `indexing.request`, `indexing.remove`, or the otherwise read-only `indexing.status` lookup. Changing modes affects OAuth grants for future connections; reconnect users after changing the mode so Google grants the matching scope set.

`wrangler.jsonc` is gitignored because it contains your account's namespace ids. The `wrangler.example.jsonc` template stays in git.

---

## Step 6 — Apply migrations, deploy, and verify

The Durable Object migrations declared in `wrangler.jsonc` are applied automatically when you deploy: `v1` creates the historical `GscMcpAgent` class, `v2` adds `PendingAuthState` for atomic OAuth-state consumption, and `v3` adds `ToolRateLimiter` for server-side per-user tool limits. The MCP endpoint now uses Cloudflare's stateless MCP handler; `GscMcpAgent` remains as an unused compatibility shell so existing deployments can upgrade without a destructive Durable Object deletion migration. Do not remove or rename the existing binding/migration history. Deploy:

```bash
npm run deploy
```

Wrangler prints your Worker URL, e.g. `https://mcp-gsc.<your-subdomain>.workers.dev`. If you didn't know that host in Step 3, add `https://<that-host>/google/callback` to the Authorized redirect URIs now, then deploy again.

Smoke-check the deployment:

```bash
curl https://<your-worker>.workers.dev/healthz
# → ok
```

Opening the root URL in a browser also prints the `/mcp` connect URL.

Now connect it in your client:

- **Claude.ai / Claude Desktop** — go to **Customize → Connectors**, click **+ → Add custom connector**, enter a name, and paste `https://<your-worker>.workers.dev/mcp`. Leave the optional advanced OAuth Client ID/Secret fields blank. On Team/Enterprise, an Owner or Primary Owner must first add the custom Web connector from **Organization settings → Connectors**; members then connect it from Customize → Connectors. On first connection, Claude opens the Google sign-in flow.
- **Cursor** — add a remote **Streamable HTTP** MCP server with the same `/mcp` URL. Cursor supports OAuth for remote HTTP servers.
- **ChatGPT** — enable **Developer mode**, then create a custom MCP **app** from **Settings → Apps → Create** (admins/owners can also use **Workspace settings → Apps → Create**). Provide the `/mcp` endpoint, select the applicable authentication option, click **Scan Tools**, complete OAuth, then create the app. Full MCP including write/modify tools is currently available to Business and Enterprise/Edu; Pro custom MCP access is read/fetch-only, so use `GSC_ACCESS_MODE=readonly` for that path.

After the client starts OAuth, sign in with a Google account you added as a **test user** in Step 2 and grant the access requested by your selected deployment mode. Then ask: *"What sites do I have in Search Console?"*

---

## Step 7 — Important: Google verification

**Read this carefully — it determines whether your self-hosted instance keeps working past a week.**

While your OAuth app's **Publishing status** is **Testing** (where it starts, and where Step 2 leaves it), three limits apply:

- **Unverified-app screen.** Users see Google's *"Google hasn't verified this app"* warning during sign-in and must click **Advanced → Go to \<app\> (unsafe)** to continue. That's expected for an unverified app — it isn't a problem with this server.
- **100-user cap.** At most 100 Google accounts can ever authorize the app.
- **Refresh tokens expire after 7 days.** This is the big one. In Testing mode, Google expires every refresh token **7 days** after it's issued. When that happens the tools start returning *"Google access revoked. Please reconnect this connector in Claude.ai"*, and the user has to reconnect to get a fresh token. **Any automation or scheduled job you build on top will break every 7 days** until you fix this.

To remove all three limits you must move the app to **Publishing status: In production** and complete any verification Google requires for the scopes you use:

- In **Google Auth platform → Audience**, click **Publish app** and confirm the move to production.
- Google requires public production apps that use **sensitive or restricted scopes** to complete OAuth verification. Follow **Google Auth platform → Verification Center** for the requirements that apply to your selected scopes. Google's additional security assessment applies to **restricted** scopes; do not assume every sensitive scope requires one. Review time varies by the checks your app requires.
- Once the app is **In production and verified**, the unverified-app screen goes away, the 100-user cap is lifted, and refresh tokens stop expiring on the 7-day clock.

**Bottom line:** for personal use with one or two Google accounts, Testing mode is fine as long as you don't mind reconnecting roughly every 7 days. For anything shared or automated, you'll want to complete Google's verification — and that, not the code, is the heaviest part of self-hosting a Google Search Console MCP.

---

## Troubleshooting

- **`redirect_uri_mismatch`** — the redirect URI in Step 3 must match your Worker host exactly, including `https://` and the `/google/callback` path. Check for typos and trailing slashes.
- **`Google did not return a refresh_token`** — you need a fresh consent. This server requests `access_type=offline` with `prompt=consent`, but if you've authorized before, remove the app from your [Google Account permissions](https://myaccount.google.com/permissions) and reconnect to force a new refresh token.
- **"Google access revoked" after about a week** — that's the 7-day Testing-mode expiry from Step 7. Reconnect, or move the app to production.
- **401 on `/mcp`** — expected when unauthenticated. Connect through your MCP client's OAuth flow rather than calling `/mcp` directly in a browser.
