# Setup — self-hosting mcp-gsc

This guide walks you through deploying your own instance of `mcp-gsc` on Cloudflare Workers with your own Google OAuth credentials ("bring your own OAuth"). Budget about 30–40 minutes the first time.

By the end you'll have a Worker at `https://<your-worker>.workers.dev/mcp` that you can connect as a custom MCP connector in Claude.ai, Cursor, or ChatGPT.

> **Read [Step 7](#step-7--important-google-verification) before you start.** While your Google OAuth app is unverified, refresh tokens expire after **7 days** and you're capped at **100 users**. This is the single biggest reason self-hosting a Google Search Console MCP is heavier than a key-based MCP — it's how Google's OAuth works for the sensitive `webmasters.readonly` scope, not a limitation of this project.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (the free Workers plan is enough to start).
- A [Google account](https://accounts.google.com/) with access to the Search Console properties you want to query.
- Node.js 20+ and npm.
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

## Step 2 — Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **User type: External**, then **Create**.
3. Fill in the required app info (app name, user support email, developer contact email). The app name is what users see on the Google sign-in screen.
4. On the **Scopes** step, click **Add or remove scopes** and add exactly this scope:

   ```
   https://www.googleapis.com/auth/webmasters.readonly
   ```

   This is a **sensitive** scope. It grants read-only access to Search Console data and nothing else.
5. On the **Test users** step, click **Add users** and add your own Google email address (and any teammates who need access while the app is in Testing).
6. Save. Leave the **Publishing status** as **Testing** for now — see [Step 7](#step-7--important-google-verification).

---

## Step 3 — Create an OAuth client (Web application)

1. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. **Application type: Web application.**
3. Under **Authorized redirect URIs**, add both of these:

   ```
   https://<your-worker>.workers.dev/google/callback
   http://localhost:8787/google/callback
   ```

   - Replace `<your-worker>` with your Worker's name + subdomain. If you don't know it yet, deploy once (Step 6) to see the assigned `*.workers.dev` URL, then come back and add it here. The default Worker name is `mcp-gsc` (set in `wrangler.jsonc`).
   - The `http://localhost:8787/google/callback` entry is for local development with `npm run dev`.
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

For **local development**, put the same three values in `.dev.vars` instead — copy `.dev.vars.example` to `.dev.vars` (it's gitignored):

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
TOKEN_ENCRYPTION_KEY=...
```

---

## Step 5 — Create the KV namespaces

The server uses two Workers KV namespaces: `OAUTH_KV` (pending OAuth state and issued tokens) and `USER_KV` (encrypted refresh tokens, keyed per user).

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

`wrangler.jsonc` is gitignored because it contains your account's namespace ids. The `wrangler.example.jsonc` template stays in git.

---

## Step 6 — Apply migrations, deploy, and verify

The Durable Object migration declared in `wrangler.jsonc` (`migrations` → tag `v1`, `new_sqlite_classes: ["GscMcpAgent"]`) is applied automatically the first time you deploy. Deploy:

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

Now connect it in **Claude.ai**:

1. Settings → **Connectors** → **Add custom connector**.
2. Paste `https://<your-worker>.workers.dev/mcp`.
3. Leave **Client ID** and **Client Secret** blank.
4. Click through; Claude opens a Google sign-in flow. Sign in with a Google account you added as a **test user** in Step 2, and grant read access to your Search Console properties.
5. The connector turns green. Ask: *"What sites do I have in Search Console?"*

The same `/mcp` URL works in Cursor and ChatGPT.

---

## Step 7 — Important: Google verification

**Read this carefully — it determines whether your self-hosted instance keeps working past a week.**

While your OAuth app's **Publishing status** is **Testing** (where it starts, and where Step 2 leaves it), three limits apply:

- **Unverified-app screen.** Users see Google's *"Google hasn't verified this app"* warning during sign-in and must click **Advanced → Go to \<app\> (unsafe)** to continue. That's expected for an unverified app — it isn't a problem with this server.
- **100-user cap.** At most 100 Google accounts can ever authorize the app.
- **Refresh tokens expire after 7 days.** This is the big one. In Testing mode, Google expires every refresh token **7 days** after it's issued. When that happens the tools start returning *"Google access revoked. Please reconnect this connector in Claude.ai"*, and the user has to reconnect to get a fresh token. **Any automation or scheduled job you build on top will break every 7 days** until you fix this.

To remove all three limits you must move the app to **Publishing status: In production**:

- In **APIs & Services → OAuth consent screen**, click **Publish app**.
- Because `webmasters.readonly` is a **sensitive scope**, Google requires **OAuth verification**: you submit the app for review, justify the scope, and (for sensitive/restricted scopes) may need to verify domain ownership and complete a security assessment. **This review can take days to several weeks.**
- Once the app is **In production and verified**, the unverified-app screen goes away, the 100-user cap is lifted, and refresh tokens stop expiring on the 7-day clock.

**Bottom line:** for personal use with one or two Google accounts, Testing mode is fine as long as you don't mind reconnecting roughly every 7 days. For anything shared or automated, you'll want to complete Google's verification — and that, not the code, is the heaviest part of self-hosting a Google Search Console MCP.

> Don't want to deal with verification at all? The hosted version at **[digestseo.com](https://digestseo.com)** has already been through it (and adds automatic weekly email digests on top).

---

## Troubleshooting

- **`redirect_uri_mismatch`** — the redirect URI in Step 3 must match your Worker host exactly, including `https://` and the `/google/callback` path. Check for typos and trailing slashes.
- **`Google did not return a refresh_token`** — you need a fresh consent. This server requests `access_type=offline` with `prompt=consent`, but if you've authorized before, remove the app from your [Google Account permissions](https://myaccount.google.com/permissions) and reconnect to force a new refresh token.
- **"Google access revoked" after about a week** — that's the 7-day Testing-mode expiry from Step 7. Reconnect, or move the app to production.
- **401 on `/mcp`** — expected when unauthenticated. Connect through your MCP client's OAuth flow rather than calling `/mcp` directly in a browser.
