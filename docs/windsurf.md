# Windsurf / Devin Desktop

mcp-gsc works with Windsurf / Devin Desktop through Cascade's native MCP support.

## Local npm launcher setup (recommended)

First supply the Google OAuth and token-encryption environment variables described in [`SETUP.md`](../SETUP.md), then start the verified package launcher:

```bash
npx -y @digestseo/mcp-gsc
```

Open `~/.codeium/windsurf/mcp_config.json` and merge this server into the existing `mcpServers` object:

```json
{
  "mcpServers": {
    "mcp-gsc": {
      "serverUrl": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

The npm launcher serves Streamable HTTP on loopback and completes Google authentication through its normal MCP/OAuth flow. Keep the launcher running while Windsurf uses the server, and do not replace existing MCP entries when adding this configuration.

## Verify

Reload Windsurf after changing the config, open Cascade's MCP settings, confirm `mcp-gsc` connects, complete Google sign-in if prompted, then inspect the available tools before invoking one.

- Product: https://digestseo.com/gsc-mcp/
- npm: https://www.npmjs.com/package/@digestseo/mcp-gsc
- Official MCP Registry ID: `io.github.AKzar1el/mcp-gsc`
- Windsurf MCP docs: https://docs.devin.ai/desktop/cascade/mcp
