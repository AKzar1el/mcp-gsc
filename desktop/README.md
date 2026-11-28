# DigestSEO Search Console Desktop (read-only) — candidate

This independent Node.js stdio adapter reuses the repository's Google Search Console API implementation. It is not the Cloudflare Worker, not a proxy to the hosted MCP, and does not change its authentication, deployment or existing catalog. Candidate version 0.1.0.

## Configuration

Enable Search Console API in your own Google Cloud project and configure an OAuth consent screen and OAuth client. Using your own OAuth credentials, obtain an offline refresh token explicitly authorized for `https://www.googleapis.com/auth/webmasters.readonly`. If using Google's OAuth Playground, configure your own OAuth client and its required redirect URI; do not rely on a shared temporary Playground token. Google may require consent-screen verification or expire testing-mode refresh tokens. Enter the client ID, client secret and refresh token in the extension's local configuration fields, not in a prompt, issue, repository, or log. Never copy credentials from the hosted service.

This candidate does not yet implement an interactive OAuth enrollment flow. Only test with a property you own or have authorization to read. Reconnect/restart after changing the credentials. OAuth is subject to Google's user-data, consent and quota requirements.

## Tool surface

Seven read-only tools: server.capabilities, sites.list, sites.get, analytics.query, urls.inspect, sitemaps.list, sitemaps.get. There are no indexing, submission, deletion, arbitrary browsing, or property mutation tools. Search analytics are bounded to 100 rows per call, 366 inclusive calendar days, and finalized data. URL inspection reports Google's indexed view, not live crawl status. Google determines accessible properties and available data. The local adapter imposes 30 outbound attempts per minute, 12-second per-attempt timeouts and a 48 KB result limit; it fails closed on missing configuration or provider errors.

## Build and verify

From desktop/: npm ci --ignore-scripts; npm run build; npm test. The build imports the existing ../src/google.ts, ../src/date-validation.ts and ../src/result-bounds.ts. Tests use synthetic OAuth values and mock fetch; no live Google credentials or API traffic. Package a clean staging directory containing the manifest, dist/server.mjs, production node_modules, package.json, LICENSE and privacy/docs (never tests, secrets or development dependencies). Use the pinned official MCPB packer.

Windows candidate tests cover missing-credential handling, MCP initialization, seven-tool discovery and annotations, all tool calls with mocked provider responses, invalid URL/date arguments and unknown mutation rejection. Real read-only OAuth and live API qualification plus actual Claude Desktop installation remain necessary before public release or directory submission.
