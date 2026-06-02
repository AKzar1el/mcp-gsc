# mcp-gsc

A self-hostable [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for **Google Search Console**. Connect it to Claude.ai, Cursor, ChatGPT, or any MCP-compatible client and ask your AI assistant about your site's organic search performance — impressions, clicks, top queries, index status, and sitemap health — straight from your own Google account.

It runs on [Cloudflare Workers](https://workers.cloudflare.com/) and ships with one-click Google OAuth onboarding: connect the server in your client, sign in with Google once, grant read-only access to your Search Console properties, and you're done. No API keys to copy around, no service-account JSON to manage.

> **Prefer zero setup?** The hosted version — with automatic weekly email digests delivered to your inbox — is at **[digestseo.com](https://digestseo.com)**. This repository is the open-source core you can run yourself.

## Tools

This server exposes four **read-only** tools:

| Tool | What it does |
|---|---|
| **`list_sites`** | List the Search Console properties the connected Google account can access (`siteUrl`, `permissionLevel`). |
| **`query_search_analytics`** | Impressions, clicks, CTR, and average position over a date range — broken down by query, page, country, device, date, or search appearance, with dimension filters and a selectable search type (web, image, video, news, discover). |
| **`inspect_url`** | Google's URL Inspection report for a single page: index status, last crawl, mobile usability, rich-results eligibility, AMP. |
| **`list_sitemaps`** | All sitemaps submitted for a property, with submission/processing status and warning and error counts. |

Every tool uses only the `https://www.googleapis.com/auth/webmasters.readonly` scope — the server never modifies your Search Console data.

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
npm run typecheck     # tsc --noEmit
npm run dev           # wrangler dev (local)
npm run test:smoke    # structural smoke tests against a deployment
```

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 DigestSEO.

---

*Built by the team behind [digestseo.com](https://digestseo.com) — weekly SEO digests for non-technical site owners.*
