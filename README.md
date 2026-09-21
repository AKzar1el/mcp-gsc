# mcp-gsc

<!-- Logo asset for marketplace submissions: assets/logo-400.png (400x400). -->

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-remote%20server-8A2BE2)](https://modelcontextprotocol.io)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.AKzar1el%2Fmcp--gsc-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.AKzar1el/mcp-gsc)
[![CI](https://github.com/AKzar1el/mcp-gsc/actions/workflows/ci.yml/badge.svg)](https://github.com/AKzar1el/mcp-gsc/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40digestseo%2Fmcp-gsc.svg)](https://www.npmjs.com/package/@digestseo/mcp-gsc)
[![mcp-gsc MCP server](https://glama.ai/mcp/servers/AKzar1el/mcp-gsc/badges/score.svg)](https://glama.ai/mcp/servers/AKzar1el/mcp-gsc)

Part of the **[DigestSEO](https://digestseo.com/)** suite of open-source SEO tools.

- Product: [digestseo.com/gsc-mcp](https://digestseo.com/gsc-mcp/)
- Engineering case study: [DigestSEO MCP Suite — AI visibility, Search Console, web validation, and trend intelligence](https://tomiseregi.si/projects/digestseo-mcp-suite)
- Support: [digestseo.com/support](https://digestseo.com/support/)
- Privacy: [digestseo.com/privacy](https://digestseo.com/privacy/)

The self-hosting launcher is available as [`@digestseo/mcp-gsc`](https://www.npmjs.com/package/@digestseo/mcp-gsc):

```bash
npx -y @digestseo/mcp-gsc
```

The npm launcher starts a loopback-only **Streamable HTTP** Worker on `127.0.0.1` (port `8080` by default); it is not a stdio MCP process. You can run the `npx` command from any directory because the launcher resolves its bundled Worker configuration from the installed package. Clients that launch the package should connect to `http://127.0.0.1:8080/mcp` after supplying the Google OAuth and token-encryption environment variables described in [SETUP.md](SETUP.md). Before the first OAuth sign-in, authorize the exact callback `http://127.0.0.1:8080/google/callback` in Google Cloud (or use the same custom `PORT` you launch with); the launcher prints both URLs at startup.

The local launcher defaults to `GSC_ACCESS_MODE=readwrite`. For least-privilege analytics/reporting-only use, set `GSC_ACCESS_MODE=readonly` in the environment before running `npx`; the launcher forwards that value into the local Worker so OAuth requests only the read-only Search Console scope and the five mutation tools stay unregistered.

For Google OAuth and Cloudflare deployment configuration, follow [SETUP.md](SETUP.md).

### Connect in 30 seconds

Every deployed instance exposes the same endpoint shape:

```
https://<your-worker>.workers.dev/mcp
```

The DigestSEO-hosted instance is available at:

```
https://mcp-gsc.digestseo.com/mcp
```

**Claude Code**

```bash
claude mcp add --transport http gsc https://<your-worker>.workers.dev/mcp
```

**Cursor**

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=gsc&config=eyJ1cmwiOiJodHRwczovL21jcC1nc2MuZGlnZXN0c2VvLmNvbS9tY3AifQ%3D%3D)

**Kiro**

[![Add to Kiro](https://kiro.dev/images/add-to-kiro.svg)](https://kiro.dev/launch/mcp/add?name=mcp-gsc&config=%7B%22url%22%3A%22https%3A%2F%2Fmcp-gsc.digestseo.com%2Fmcp%22%2C%22disabled%22%3Afalse%2C%22autoApprove%22%3A%5B%5D%7D)

Uses the hosted endpoint above; complete its Google OAuth flow on first use.

**ChatGPT** — add it as a custom MCP app in developer mode; see [Connect in your AI client](#connect-in-your-ai-client) below.

A self-hostable [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for **Google Search Console**. Connect it to Claude.ai, Cursor, ChatGPT, or any MCP-compatible client and ask your AI assistant about your site's organic search performance — impressions, clicks, top queries, index status, and sitemap health — straight from your own Google account.

It runs on [Cloudflare Workers](https://workers.cloudflare.com/) and ships with one-click Google OAuth onboarding: connect the server in your client, sign in with Google once, grant the requested Google Search Console permissions, and you're done. No API keys to copy around and no service-account JSON to manage.

> **Prefer zero setup?** The hosted version — with automatic weekly email digests delivered to your inbox — is at **[digestseo.com](https://digestseo.com)**. This repository is the open-source core you can run yourself.

## Tools

By default (`GSC_ACCESS_MODE=readwrite`), this server exposes 21 tools. Read-only analytics and reporting tools are marked with MCP's `readOnlyHint`; the write tools below can change Search Console properties, sitemaps, or indexing state. Set `GSC_ACCESS_MODE=readonly` to request only the Search Console read-only scope and expose the 16 read-only tools.

| Tool | Access | What it does |
|---|---|---|
| **`server.capabilities`** | Read | List every tool this server exposes and report whether your Google connection is currently authenticated (`connected` / `not_connected`). Takes no arguments — a good first call for discovery. |
| **`sites.list`** | Read | List the Search Console properties the connected Google account can access (`siteUrl`, `permissionLevel`). |
| **`sites.get`** | Read | Retrieve one exact Search Console property and the connected account's permission level for it. |
| **`analytics.query`** | Read | Impressions, clicks, CTR, and average position over a date range, with dimensions, filters, safe pagination, and selectable search type. Pass `dimensions: []` for true site totals; Google's aggregate row may omit `keys`. Search Analytics does not guarantee every data row and can return only top rows, so exhausting local pagination is not proof that the provider dataset is exhaustive. For `search_type: "discover"`, `position_supported` is `false` because Google Discover does not support average position. |
| **`insights.page_queries`** / **`insights.query_pages`** | Read | Drill from one exact page to its Search Console queries, or from one exact query to the pages Google surfaced for it, with `row_limit` / `start_row` pagination. |
| **`urls.inspect`** | Read | Google's URL Inspection report for the version of one page currently known in Google's index. It is not a live URL test; mobile-usability output is deprecated. |
| **`urls.inspect_many`** | Read | Inspect Google's indexed versions of up to 10 URLs sequentially in one call. Each URL still consumes one Google URL Inspection request and one unit of the server's shared inspection safety budget; this does not run live URL tests. |
| **`sitemaps.list`** / **`sitemaps.get`** | Read | List submitted sitemaps or retrieve one sitemap's details. |
| **`insights.quick_wins`** / **`insights.cannibalization`** / **`insights.content_decay`** | Read | Surface average-position opportunity rows, query/page overlap, and evidence-ranked click declines. Quick-win candidates are observed query/page rows selected by aggregate Search Console average position, not proof of a stable current rank, and CTR is context rather than an eligibility filter. Cannibalization candidate totals/shares are scoped to observed query/page rows rather than true query-level property totals; content-decay results compare only pages returned in both periods and do not turn one-sided row absence into zero traffic. |
| **`indexing.list_pages`** / **`analytics.compare`** | Read | Analyze pages receiving Search Console impressions and compare two periods, optionally using the same search type and query/page/country/device/search-appearance filters for both periods. `analytics.compare` compares only dimension keys returned in both period responses; a key absent from one non-exhaustive Search Analytics response is not assumed to have zero metrics. `indexing.list_pages` is performance data, not index coverage: a missing URL may still be indexed; use `urls.inspect` / `urls.inspect_many` for URL-level index status. |
| **`reports.weekly_digest`** | Read | Generate a plain-language seven-day performance report with movers, top pages, and one recommended action. Query movers compare only rows returned in both weekly Search Analytics result sets; a query missing from one bounded response is not treated as zero because Google does not guarantee every data row. |
| **`sites.add`** / **`sites.delete`** | Write | Add or remove a Search Console property. |
| **`sitemaps.submit`** / **`sitemaps.delete`** | Write | Submit or remove a sitemap. |
| **`indexing.request`** | Write | Requests indexing through Google's Indexing API. Google currently restricts this API to pages containing `JobPosting` structured data or livestream pages containing `BroadcastEvent` inside `VideoObject`. It is not available for general webpage submission. |

> **Platform properties.** Search Console now supports platform properties for social/video accounts such as Instagram, TikTok, X, and YouTube in its UI. Google's current Search Console API documentation still defines `siteUrl` using URL-prefix and `sc-domain:` website-property forms and does not publish a platform-property API identifier contract. `sites.list` therefore preserves every identifier Google returns and marks whether it matches the documented API grammar; the other tools deliberately reject undocumented forms instead of inventing an identifier. Use the Search Console UI/export for a platform property until Google documents API support.

Read-write mode requests the Google Search Console read-write and Indexing API scopes. Read-only mode requests only `https://www.googleapis.com/auth/webmasters.readonly` (plus `openid` and `email`) and does not register the five write tools. Read-write remains the default so existing deployments retain their current behavior; see [SETUP.md](SETUP.md) to select a mode before connecting users.

Large analytics responses are bounded at the MCP boundary instead of being generated and then discarded by clients with structured-content limits. List-style tools expose `start_row` / `next_start_row` where applicable; ranked analytical tools expose `limit`, `start_row`, and `result_page` metadata including `has_more`, `truncated`, and `byte_limit_reached`. Continue paging while `has_more` is true rather than assuming one response is complete.

> **`indexing.request` eligibility.** Google's Indexing API is not a general-purpose page submission tool — as of this writing, Google's own documentation limits it to two content types: pages with `JobPosting` structured data, and livestream pages with `BroadcastEvent` structured data nested inside `VideoObject`. Before submitting, the server fetches the target URL and checks static JSON-LD, Microdata, and RDFa markup for one of those two types; if neither is present (or the page can't be fetched), it returns an error explaining why the URL is ineligible instead of calling the Indexing API. Structured data injected only after client-side JavaScript runs cannot be confirmed by this bounded preflight and therefore fails closed. A successful submission is only an acknowledgment that Google received the notification — it does not guarantee the URL will be indexed.

## What you can ask

Once connected, ask your assistant things like:

- *"What are my top 20 queries by clicks in the last 28 days?"*
- *"Compare impressions for example.com this month vs last month — which pages dropped?"*
- *"What does Google's indexed version of `https://example.com/pricing` show for index status and last crawl?"*
- *"Which high-impression query/page rows have an average position between 5 and 15? Show me those optimization opportunities."*
- *"Give me a weekly digest for `sc-domain:example.com` ending today."*
- *"Do any of my sitemaps have errors or warnings?"*
- *"Split my clicks into brand vs non-brand using a regex on the query."*
- *"How is my site doing in Google Discover vs regular web search?"*

## Connect in your AI client

Once you've deployed the server (see **[SETUP.md](SETUP.md)**), connect it by pasting your Worker's `/mcp` URL into your client:

```
https://<your-worker>.workers.dev/mcp
```

- **Claude.ai / Claude Desktop** — go to **Customize → Connectors**, click **+ → Add custom connector**, enter a name and paste the `/mcp` URL. Leave the optional advanced OAuth Client ID/Secret fields blank. On Team/Enterprise, an Owner or Primary Owner must first add the custom Web connector from **Organization settings → Connectors**; members then connect it from Customize → Connectors. On first connection, Claude opens the Google sign-in flow.
- **Cursor** — add a remote **Streamable HTTP** MCP server pointing at the same `/mcp` URL; Cursor supports OAuth for remote HTTP MCP servers. The hosted Add to Cursor button above uses this endpoint directly.
- **ChatGPT** — enable **Developer mode**, then create a custom MCP **app** from **Settings → Apps → Create** (admins/owners can also use **Workspace settings → Apps → Create**). Provide the `/mcp` endpoint, select the applicable authentication option, **Scan Tools**, complete OAuth, then create the app. Full MCP including write/modify tools is currently available to Business and Enterprise/Edu; Pro custom MCP access is read/fetch-only, so use `GSC_ACCESS_MODE=readonly` for that path.

The `/mcp` endpoint is the same across clients, but each host has its own setup and permission flow.

## Setup

Self-hosting means bringing your own Google OAuth credentials and Cloudflare account. The full, copy-pasteable walkthrough is in **[SETUP.md](SETUP.md)** — including an important note about Google's OAuth verification and the 7-day refresh-token limit while your app is unverified.

Quick shape:

```bash
git clone https://github.com/<you>/mcp-gsc.git
cd mcp-gsc
npm install
cp wrangler.example.jsonc wrangler.jsonc       # then paste in your KV ids
# set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / TOKEN_ENCRYPTION_KEY as secrets
# choose GSC_ACCESS_MODE=readonly in wrangler.jsonc for a read-only deployment
npm run deploy
```

See **[SETUP.md](SETUP.md)** for every step in detail.

## Development

```bash
npm install
npm test              # typecheck + offline unit tests (what CI runs)
npm run dev           # wrangler dev (local)
npm run test:smoke    # structural smoke tests against a deployment
```

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 DigestSEO.

---

*Built and maintained by [Tomi Šeregi](https://tomiseregi.si), the builder behind [digestseo.com](https://digestseo.com) — weekly SEO digests for non-technical site owners.*
