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

The npm launcher starts a loopback-only **Streamable HTTP** Worker on `127.0.0.1` (port `8080` by default); it is not a stdio MCP process. You can run the `npx` command from any directory because the launcher resolves its bundled Worker configuration from the installed package. Clients that launch the package should connect to `http://127.0.0.1:8080/mcp` after supplying the Google OAuth and token-encryption environment variables described in [SETUP.md](SETUP.md). The launcher exits before starting Wrangler if `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, or `TOKEN_ENCRYPTION_KEY` is missing or blank, and it also rejects a nonblank `TOKEN_ENCRYPTION_KEY` unless it is valid base64 that decodes to exactly 32 bytes. Errors identify only the invalid or missing setting, never its secret value, so a broken OAuth session is not started. It keeps secret values in the child process environment and Wrangler loads them through declared local secrets; their values are not copied into Wrangler `--var` command-line arguments. Before the first OAuth sign-in, authorize the exact callback `http://127.0.0.1:8080/google/callback` in Google Cloud (or use the same custom `PORT` you launch with); the launcher prints both URLs at startup.

Local KV and Durable Object state, including the encrypted Google session, is stored in `~/.mcp-gsc/state` by default instead of inside the versioned npm cache. That keeps the local connection available across package upgrades and ordinary npm cache cleanup. Set `MCP_GSC_STATE_DIR` to use another directory; keep the same `TOKEN_ENCRYPTION_KEY` when reusing existing state because stored refresh tokens are encrypted with that key. The launcher prints the effective state directory at startup. The first release with this stable path may require one Google reconnect because older launcher releases stored local state under the npm package cache.

The local launcher defaults to `GSC_ACCESS_MODE=readwrite`. For least-privilege analytics/reporting-only use, set `GSC_ACCESS_MODE=readonly` in the environment before running `npx`; the launcher forwards that value into the local Worker so OAuth requests only the read-only Search Console scope and the six mutation tools stay unregistered.

For Google OAuth and Cloudflare deployment configuration, follow [SETUP.md](SETUP.md).

### Connect the local launcher

For the current verified quick-connect path, start the npm launcher first after supplying the Google OAuth and token-encryption environment variables described in [SETUP.md](SETUP.md):

```bash
npx -y @digestseo/mcp-gsc
```

Then connect your MCP client to the launcher's loopback endpoint:

```
http://127.0.0.1:8080/mcp
```

Self-hosted Cloudflare Worker deployments continue to use `https://<your-worker>.workers.dev/mcp`. The repo does not currently advertise the owner-hosted remote as a quick-connect path because its deployed tool contract is behind the published package.

**Claude Code**

```bash
claude mcp add --transport http gsc http://127.0.0.1:8080/mcp
```

**OpenAI Codex CLI / IDE**

```bash
codex mcp add gsc --url http://127.0.0.1:8080/mcp
```

Codex CLI and the Codex IDE extension share MCP configuration, so registering the server once makes the same local connection available to both clients. Start the npm launcher before using the connection; Codex will open the server's OAuth flow when authentication is required.

**Cursor**

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=gsc&config=eyJ1cmwiOiJodHRwOi8vMTI3LjAuMC4xOjgwODAvbWNwIn0%3D)

When this repository is installed as a Cursor plugin, Cursor also auto-discovers three bundled Agent Skills that compose the MCP tools into evidence-safe workflows: `gsc-weekly-review`, `gsc-indexing-triage`, and `gsc-search-opportunities`. The **Add to Cursor** button above installs the MCP connection only; the bundled skills are part of the repository's Cursor plugin package.

**GitHub Copilot CLI**

```bash
copilot plugin marketplace add AKzar1el/mcp-gsc
copilot plugin install mcp-gsc@digestseo
```

The marketplace path makes the plugin discoverable and updateable through Copilot's marketplace workflow. Direct repository install also remains supported with `copilot plugin install AKzar1el/mcp-gsc`. The Copilot plugin bundles the same three Agent Skills plus the local loopback MCP configuration. Start the npm launcher before using the plugin's MCP server; the plugin does not start or deploy mcp-gsc for you.

**Kiro**

[![Add to Kiro](https://kiro.dev/images/add-to-kiro.svg)](https://kiro.dev/launch/mcp/add?name=mcp-gsc&config=%7B%22url%22%3A%22http%3A%2F%2F127.0.0.1%3A8080%2Fmcp%22%2C%22disabled%22%3Afalse%2C%22autoApprove%22%3A%5B%5D%7D)

Start the npm launcher before using either install button or the Copilot plugin. Complete its Google OAuth flow on first use.

**ChatGPT** — ChatGPT cannot connect directly to this loopback `127.0.0.1` endpoint. Use OpenAI's **Secure MCP Tunnel** for the local launcher, or deploy your own remote Cloudflare Worker and add that `/mcp` URL as a custom MCP app in Developer mode; see [Connect in your AI client](#connect-in-your-ai-client) below.

A self-hostable [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for **Google Search Console**. Connect it to Claude.ai, Cursor, ChatGPT, or any MCP-compatible client and ask your AI assistant about your site's organic search performance — impressions, clicks, top queries, index status, and sitemap health — straight from your own Google account.

It runs on [Cloudflare Workers](https://workers.cloudflare.com/) and ships with Google OAuth onboarding: connect the server in your client, review the mcp-gsc consent page that identifies the requesting MCP client and permissions, then sign in with Google and grant the requested Google Search Console permissions. No API keys to copy around and no service-account JSON to manage.

## Tools

By default (`GSC_ACCESS_MODE=readwrite`), this server exposes 23 tools. Read-only analytics and reporting tools are marked with MCP's `readOnlyHint`; the write tools below can change Search Console properties, sitemaps, or indexing state. Set `GSC_ACCESS_MODE=readonly` to request only the Search Console read-only scope and expose the 16 tools that do not require either write access or the separate Indexing API scope.

| Tool | Access | What it does |
|---|---|---|
| **`server.capabilities`** | Read | List every tool this server exposes and report local Google credential state. `connected` means a stored refresh credential is present; the response also exposes `auth_status_basis` and `provider_auth_live_verified: false` because this discovery call does not probe Google. A later Google tool call can still require reconnection if the credential expired or was revoked. Takes no arguments. |
| **`sites.list`** | Read | List the Search Console properties the connected Google account can access (`siteUrl`, `permissionLevel`). |
| **`sites.get`** | Read | Retrieve one exact Search Console property and the connected account's permission level for it. |
| **`analytics.query`** | Read | Impressions, clicks, CTR, and average position over a date range, with dimensions, filters, safe pagination, and selectable search type. Pass `dimensions: []` for true site totals; Google's aggregate row may omit `keys`. Search Analytics does not guarantee every data row and can return only top rows, so exhausting local pagination is not proof that the provider dataset is exhaustive. `data_state: "all"` can include fresh preliminary data, while `final` returns only finalized data; responses echo `data_state` plus `preliminary_data_possible`, and date/hour groupings preserve Google's incomplete-data boundary metadata when returned. Search appearance discovery is a two-step workflow: group by `searchAppearance` alone to discover the exact values Google returns for the property, then filter to one returned value in a separate query when grouping by page/query/country/device/date/hour. For `search_type: "discover"` or `"googleNews"`, `position_supported` is `false`; those reports expose clicks, impressions, and CTR but not average position, so returned rows can omit `position`, and query grouping/filtering is unavailable. Search Console's dedicated Generative AI performance reports are not exposed by the current documented Search Analytics API as a dedicated search type or filter selector; `generative_ai_report_isolatable` is therefore `false`. |
| **`insights.page_queries`** / **`insights.query_pages`** | Read | Drill from one exact page to its Search Console queries, or from one exact query to the pages Google surfaced for it, with `row_limit` / `start_row` pagination. These query-centric helpers support web, image, video, and the Search results News tab; Discover and the Google News report are excluded because they do not expose query data. |
| **`urls.inspect`** | Read | Google's URL Inspection report for the version of one page currently known in Google's index. It is not a live URL test; mobile-usability output is deprecated. |
| **`urls.inspect_many`** | Read | Inspect Google's indexed versions of up to 10 URLs with bounded concurrency of 3 in one call while preserving input-order results. Each URL still consumes one Google URL Inspection request and one unit of the server's shared inspection safety budget; this does not run live URL tests. |
| **`sitemaps.list`** / **`sitemaps.get`** | Read | List submitted sitemaps or retrieve one sitemap's details. `lastSubmitted` is when the sitemap was submitted to Search Console; `lastDownloaded` is when Google last downloaded the sitemap. Neither value is the sitemap file's modification/deploy time or a page crawl/indexing timestamp. |
| **`insights.quick_wins`** / **`insights.cannibalization`** / **`insights.content_decay`** | Read | Surface average-position opportunity rows, query/page overlap, and evidence-ranked click declines. Quick-win candidates are observed query/page rows selected by aggregate Search Console average position, not proof of a stable current rank, and CTR is context rather than an eligibility filter. Cannibalization candidate totals/shares are scoped to observed query/page rows rather than true query-level property totals; content-decay results compare only pages returned in both periods and do not turn one-sided row absence into zero traffic. |
| **`indexing.list_pages`** / **`analytics.compare`** | Read | Analyze pages receiving Search Console impressions and compare two periods, optionally using the same search type and query/page/country/device/search-appearance filters for both periods. `analytics.compare` compares only dimension keys returned in both period responses; a key absent from one non-exhaustive Search Analytics response is not assumed to have zero metrics. Because its comparison contract includes average position, it excludes Discover and Google News. `indexing.list_pages` is performance data, not index coverage: a missing URL may still be indexed; use `urls.inspect` / `urls.inspect_many` for URL-level index status. |
| **`reports.weekly_digest`** | Read | Generate a plain-language seven-day performance report with movers, top pages, and one recommended action. Query movers compare only rows returned in both weekly Search Analytics result sets; a query missing from one bounded response is not treated as zero because Google does not guarantee every data row. |
| **`sites.add`** / **`sites.delete`** | Write | Add or remove a property from the connected account's Search Console site set. `sites.add` returns `ownership_verification_performed: false` because ownership verification is a separate Google Site Verification/Search Console workflow. `sites.delete` removes the property from that account's Search Console site set; it does not delete the website itself. |
| **`sitemaps.submit`** / **`sitemaps.delete`** | Write | Submit or remove a sitemap. |
| **`indexing.status`** | Read | Read Google's latest successful Indexing API `URL_UPDATED` / `URL_DELETED` notification receipts for a previously submitted URL. This is notification metadata only, not index coverage, crawl status, indexing completion, or removal completion. It requires `GSC_ACCESS_MODE=readwrite` because Google's metadata endpoint uses the Indexing API OAuth scope. |
| **`indexing.request`** | Write | Requests indexing through Google's Indexing API. Google currently restricts this API to pages containing `JobPosting` structured data or livestream pages containing `BroadcastEvent` inside `VideoObject`. It is not available for general webpage submission. Google's default 200 publish requests/day/project is onboarding/testing capacity rather than ongoing-use approval; additional approval is required for usage/resource provisioning, and submissions are spam-screened. |
| **`indexing.remove`** | Write | Request a `URL_DELETED` notification for a previously eligible Indexing API page. Before removal, the URL must already return HTTP 404/410 or expose a robots `noindex` meta directive. Google's receipt does not prove removal completed; use URL Inspection for indexed-state evidence. |

Search Analytics calendar dates (`start_date`, `end_date`, and comparison-period dates) use Google's Pacific Time calendar (`America/Los_Angeles`, UTC-8/UTC-7 depending on daylight saving time), not the caller's local timezone or UTC. This also governs the server's generated/default Search Analytics date ranges.

> **Platform properties.** Search Console now supports platform properties for social/video accounts such as Instagram, TikTok, X, and YouTube in its UI. Google's current Search Console API documentation still defines `siteUrl` using URL-prefix and `sc-domain:` website-property forms and does not publish a platform-property API identifier contract. `sites.list` therefore preserves every identifier Google returns and marks whether it matches the documented API grammar; the other tools deliberately reject undocumented forms instead of inventing an identifier. Use the Search Console UI/export for a platform property until Google documents API support.

Read-write mode requests the Google Search Console read-write and Indexing API scopes. Read-only mode requests only `https://www.googleapis.com/auth/webmasters.readonly` (plus `openid` and `email`) and does not register the six write tools or the read-only `indexing.status` lookup, because that lookup still requires Google's separate Indexing API scope. Read-write remains the default so existing deployments retain their current behavior; see [SETUP.md](SETUP.md) to select a mode before connecting users.

Large analytics responses are bounded at the MCP boundary instead of being generated and then discarded by clients with structured-content limits. List-style tools expose `start_row` / `next_start_row` where applicable; ranked analytical tools expose `limit`, `start_row`, and `result_page` metadata including `has_more`, `truncated`, and `byte_limit_reached`. Continue paging while `has_more` is true rather than assuming one response is complete.

> **Indexing API eligibility and provider approval.** Google's Indexing API is not a general-purpose page submission tool — as of this writing, Google's own documentation limits it to two content types: pages with `JobPosting` structured data, and livestream pages with `BroadcastEvent` structured data nested inside `VideoObject`. Before `indexing.request`, the server fetches the target URL and checks static JSON-LD, Microdata, and RDFa markup for one of those two types; if neither is present (or the page can't be fetched), it returns an error explaining why the URL is ineligible instead of calling the Indexing API. Structured data injected only after client-side JavaScript runs cannot be confirmed by this bounded preflight and therefore fails closed. Before `indexing.remove`, the server instead confirms Google's removal precondition: the URL must already return HTTP 404/410 or expose a robots `noindex` meta directive. Update and removal notifications share the same publish quota. Google's default 200 publish requests/day/project is for onboarding and submission testing; using the API beyond that onboarding/testing context requires Google's usage/resource-provisioning approval. Google also subjects every submission to spam detection and warns that abuse or attempts to exceed quotas through multiple accounts or other means can revoke access. A successful notification is only an acknowledgment that Google received it — it does not guarantee indexing or removal completed.

## What you can ask

Once connected, ask your assistant things like:

- *"What are my top 20 queries by clicks in the last 28 days?"*
- *"Compare impressions for example.com this month vs last month — which pages dropped?"*
- *"What does Google's indexed version of `https://example.com/pricing` show for index status and last crawl?"*
- *"Which high-impression query/page rows have an average position between 5 and 15? Show me those optimization opportunities."*
- *"Give me a weekly digest for `sc-domain:example.com` ending today."*
- *"Do any of my sitemaps have errors or warnings?"*
- *"Using this brand regex I provide, approximate my clicks as brand vs non-brand."*
- *"How is my site doing in Google Discover vs regular web search?"*

Query regexes are a manual approximation only. Search Console's native Branded/Non-branded filter uses Google's own AI-assisted classification (including language variants, typos, and associated products/services), and that native classifier is not exposed as a Search Analytics API filter.

Search Console also has dedicated Generative AI performance reports for Search and Discover. The current documented Search Analytics API does not expose a dedicated Generative AI search type or filter selector, so this MCP does not guess one. AI Overviews and AI Mode remain included in overall web Search performance data; use the Search Console UI for the dedicated Generative AI report until Google documents API access.

## Connect in your AI client

Once you've deployed the server (see **[SETUP.md](SETUP.md)**), connect it by pasting your Worker's `/mcp` URL into your client:

```
https://<your-worker>.workers.dev/mcp
```

- **Claude.ai / Claude Desktop** — go to **Customize → Connectors**, click **+ → Add custom connector**, enter a name and paste the `/mcp` URL. Leave the optional advanced OAuth Client ID/Secret fields blank. On Team/Enterprise, an Owner or Primary Owner must first add the custom Web connector from **Organization settings → Connectors**; members then connect it from Customize → Connectors. On first connection, Claude opens the Google sign-in flow.
- **Cursor** — add a remote **Streamable HTTP** MCP server pointing at the same `/mcp` URL; Cursor supports OAuth for remote HTTP MCP servers. The Add to Cursor button above targets the local npm launcher's loopback endpoint instead.
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

*Built and maintained by [Tomi Šeregi](https://tomiseregi.si), the builder behind [DigestSEO](https://digestseo.com) - open-source SEO tooling and search visibility software.*
