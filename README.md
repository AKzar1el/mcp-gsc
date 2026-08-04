# mcp-gsc

<!-- Logo asset for marketplace submissions: assets/logo-400.png (400x400). -->

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-remote%20server-8A2BE2)](https://modelcontextprotocol.io)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.AKzar1el%2Fmcp--gsc-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.AKzar1el/mcp-gsc)
[![CI](https://github.com/AKzar1el/mcp-gsc/actions/workflows/ci.yml/badge.svg)](https://github.com/AKzar1el/mcp-gsc/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40digestseo%2Fmcp-gsc.svg)](https://www.npmjs.com/package/@digestseo/mcp-gsc)
[![smithery badge](https://smithery.ai/badge/digestseo/mcp-gsc)](https://smithery.ai/servers/digestseo/mcp-gsc)

Part of the **[DigestSEO](https://digestseo.com/)** suite of open-source SEO tools.

- Product: [digestseo.com/gsc-mcp](https://digestseo.com/gsc-mcp/)
- Support: [digestseo.com/support](https://digestseo.com/support/)
- Privacy: [digestseo.com/privacy](https://digestseo.com/privacy/)

The self-hosting launcher is available as [`@digestseo/mcp-gsc`](https://www.npmjs.com/package/@digestseo/mcp-gsc):

```bash
npx -y @digestseo/mcp-gsc
```

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

**ChatGPT** — add it as a custom connector; see [Connect in your AI client](#connect-in-your-ai-client) below.

A self-hostable [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for **Google Search Console**. Connect it to Claude.ai, Cursor, ChatGPT, or any MCP-compatible client and ask your AI assistant about your site's organic search performance — impressions, clicks, top queries, index status, and sitemap health — straight from your own Google account.

It runs on [Cloudflare Workers](https://workers.cloudflare.com/) and ships with one-click Google OAuth onboarding: connect the server in your client, sign in with Google once, grant the requested Google Search Console permissions, and you're done. No API keys to copy around and no service-account JSON to manage.

> **Prefer zero setup?** The hosted version — with automatic weekly email digests delivered to your inbox — is at **[digestseo.com](https://digestseo.com)**. This repository is the open-source core you can run yourself.

## Tools

This server exposes 17 tools. Read-only analytics and reporting tools are marked with MCP's `readOnlyHint`; the write tools below can change Search Console properties, sitemaps, or indexing state.

| Tool | Access | What it does |
|---|---|---|
| **`server.capabilities`** | Read | List every tool this server exposes and report whether your Google connection is currently authenticated (`connected` / `not_connected`). Takes no arguments — a good first call for discovery. |
| **`sites.list`** | Read | List the Search Console properties the connected Google account can access (`siteUrl`, `permissionLevel`). |
| **`analytics.query`** | Read | Impressions, clicks, CTR, and average position over a date range, with dimensions, filters, pagination, and selectable search type. |
| **`urls.inspect`** | Read | Google's URL Inspection report for a single page. |
| **`sitemaps.list`** / **`sitemaps.get`** | Read | List submitted sitemaps or retrieve one sitemap's details. |
| **`insights.quick_wins`** / **`insights.cannibalization`** / **`insights.content_decay`** | Read | Surface optimization opportunities, competing pages, and declining content. |
| **`indexing.list_pages`** / **`analytics.compare`** | Read | Analyze pages receiving impressions and compare two periods. |
| **`reports.weekly_digest`** | Read | Generate a plain-language seven-day performance report with movers, top pages, and one recommended action. |
| **`sites.add`** / **`sites.delete`** | Write | Add or remove a Search Console property. |
| **`sitemaps.submit`** / **`sitemaps.delete`** | Write | Submit or remove a sitemap. |
| **`indexing.request`** | Write | Requests indexing through Google's Indexing API. Google currently restricts this API to pages containing `JobPosting` structured data or livestream pages containing `BroadcastEvent` inside `VideoObject`. It is not available for general webpage submission. |

The server requests Google Search Console and Indexing API scopes. Use a Google account with only the property access you intend to delegate, and review write-tool calls before approving them.

> **`indexing.request` eligibility.** Google's Indexing API is not a general-purpose page submission tool — as of this writing, Google's own documentation limits it to two content types: pages with `JobPosting` structured data, and livestream pages with `BroadcastEvent` structured data nested inside `VideoObject`. Before submitting, the server fetches the target URL and checks its JSON-LD for one of those two types; if neither is present (or the page can't be fetched), it returns an error explaining why the URL is ineligible instead of calling the Indexing API. A successful submission is only an acknowledgment that Google received the notification — it does not guarantee the URL will be indexed.

## What you can ask

Once connected, ask your assistant things like:

- *"What are my top 20 queries by clicks in the last 28 days?"*
- *"Compare impressions for example.com this month vs last month — which pages dropped?"*
- *"Is `https://example.com/pricing` indexed? When was it last crawled?"*
- *"Which queries does my blog rank position 5–15 for? Those are my quick wins."*
- *"Give me a weekly digest for `sc-domain:example.com` ending today."*
- *"Do any of my sitemaps have errors or warnings?"*
- *"Split my clicks into brand vs non-brand using a regex on the query."*
- *"How is my site doing in Google Discover vs regular web search?"*

## Connect in your AI client

Once you've deployed the server (see **[SETUP.md](SETUP.md)**), connect it by pasting your Worker's `/mcp` URL into your client:

```
https://<your-worker>.workers.dev/mcp
```

- **Claude.ai** — Settings → Connectors → **Add custom connector** → paste the `/mcp` URL. Leave Client ID and Client Secret blank. On first use, Claude opens a Google sign-in flow; grant read access and the connector turns green.
- **Cursor** — add it as a custom MCP server pointing at the same `/mcp` URL.
- **ChatGPT** (with connector/MCP support) — add a custom connector with the `/mcp` URL.

Any MCP-compatible client works — they all point at the same `/mcp` endpoint and share the same OAuth flow.

## Setup

Self-hosting means bringing your own Google OAuth credentials and Cloudflare account. The full, copy-pasteable walkthrough is in **[SETUP.md](SETUP.md)** — including an important note about Google's OAuth verification and the 7-day refresh-token limit while your app is unverified.

Quick shape:

```bash
git clone https://github.com/<you>/mcp-gsc.git
cd mcp-gsc
npm install
cp wrangler.example.jsonc wrangler.jsonc       # then paste in your KV ids
# set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / TOKEN_ENCRYPTION_KEY as secrets
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
