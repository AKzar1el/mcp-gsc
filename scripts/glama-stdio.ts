import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GscMcpAgent } from '../src/index';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

// Glama evaluates local repository builds by wrapping the configured command
// with mcp-proxy, which expects the child process to speak MCP over stdio.
// Reuse the production agent's registration path so Glama inspects the exact
// same tool names, descriptions, schemas, and annotations without weakening
// the OAuth-protected HTTP /mcp endpoint used in production.
const server = new McpServer({ name: 'mcp-gsc', version });
const catalogAgent = Object.create(GscMcpAgent.prototype) as GscMcpAgent;

Object.defineProperties(catalogAgent, {
  server: { value: server, configurable: true },
  env: {
    value: { GSC_ACCESS_MODE: 'readwrite' },
    configurable: true,
  },
});

await GscMcpAgent.prototype.init.call(catalogAgent);
await server.connect(new StdioServerTransport());
