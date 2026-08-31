# Windsurf / Devin Desktop

mcp-gsc works with Windsurf / Devin Desktop through Cascade's native MCP support.

## Hosted setup (recommended)

Open `~/.codeium/windsurf/mcp_config.json` and merge this server into the existing `mcpServers` object:

```json
{
  "mcpServers": {
    "mcp-gsc": {
      "serverUrl": "https://mcp-gsc.digestseo.com/mcp"
    }
  }
}
```

The hosted endpoint uses Streamable HTTP and completes Google authentication through its normal MCP/OAuth flow. Do not replace existing MCP entries when adding this configuration.

## Verify

Reload Windsurf after changing the config, open Cascade's MCP settings, confirm `mcp-gsc` connects, complete Google sign-in if prompted, then inspect the available tools before invoking one.

- Product: https://digestseo.com/gsc-mcp/
- npm: https://www.npmjs.com/package/@digestseo/mcp-gsc
- Official MCP Registry ID: `io.github.AKzar1el/mcp-gsc`
- Windsurf MCP docs: https://docs.devin.ai/desktop/cascade/mcp
