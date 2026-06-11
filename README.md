# mcp-gsc

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-remote%20server-8A2BE2)](https://modelcontextprotocol.io)

A self-hostable [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for **Google Search Console**. Connect it to Claude.ai, Cursor, ChatGPT, or any MCP-compatible client and ask your AI assistant about your site's organic search performance — impressions, clicks, top queries, index status, and sitemap health — straight from your own Google account.

It runs on [Cloudflare Workers](https://workers.cloudflare.com/) and ships with one-click Google OAuth onboarding: connect the server in your client, sign in with Google once, grant read-only access to your Search Console properties, and you're done. No API keys to copy around, no service-account JSON to manage.

> **Prefer zero setup?** The hosted version — with automatic weekly email digests delivered to your inbox — is at **[digestseo.com](https://digestseo.com)**. This repository is the open-source core you can run yourself.

## Tools

This server exposes five **read-only** tools:

| Tool | What it does |
|---|---|
| **`get_capabilities`** | List every tool this server exposes and report whether your Google connection is currently authenticated (`connected` / `not_connected`). Takes no arguments — a good first call for discovery. |
| **`list_sites`** | List the Search Console properties the connected Google account can access (`siteUrl`, `permissionLevel`). |
| **`query_search_analytics`** | Impressions, clicks, CTR, and average position over a date range — broken down by query, page, country, device, date, or search appearance, with dimension filters, pagination (`start_row`), and a selectable search type (web, image, video, news, discover). |
| **`inspect_url`** | Google's URL Inspection report for a single page: index status, last crawl, mobile usability, rich-results eligibility, AMP. |
| **`list_sitemaps`** | All sitemaps submitted for a property, with submission/processing status and warning and error counts. |

Every tool uses only the `https://www.googleapis.com/auth/webmasters.readonly` scope — the server never modifies your Search Console data. All tools carry the MCP `readOnlyHint` annotation, so clients can show them as safe.

## What you can ask

Once connected, ask your assistant things like:

- *"What are my top 20 queries by clicks in the last 28 days?"*
- *"Compare impressions for example.com this month vs last month — which pages dropped?"*
- *"Is `https://example.com/pricing` indexed? When was it last crawled?"*
- *"Which queries does my blog rank position 5–15 for? Those are my quick wins."*
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

*Built by the team behind [digestseo.com](https://digestseo.com) — weekly SEO digests for non-technical site owners.*
