// Smoke tests for the deployed mcp-gsc Worker.
//
// Runs structural checks against the live deployment. Uses only Node's
// built-in test runner and global fetch — no npm dependencies, no jq,
// no bash. Works on Windows, macOS, Linux.
//
// Run with:
//   npm run test:smoke
//
// Configuration (set in shell or in tests/../.env.test):
//   MCP_BASE_URL      base URL of the deployed Worker, no trailing slash
//                     (default: https://your-worker.workers.dev)
//   MCP_ACCESS_TOKEN  optional. Required only for checks 5-6. Without it
//                     those checks are skipped.
//
// See tests/README.md for what these tests assert (structure only —
// never specific GSC numbers) and how to obtain MCP_ACCESS_TOKEN.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const envFile = resolve(projectRoot, '.env.test');

if (existsSync(envFile)) {
  const content = readFileSync(envFile, 'utf-8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const MCP_BASE_URL = (
  process.env.MCP_BASE_URL ||
  'https://your-worker.workers.dev'
).replace(/\/$/, '');
const MCP_ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN || '';

const skipReason = MCP_ACCESS_TOKEN
  ? false
  : 'MCP_ACCESS_TOKEN not set; skipping authenticated checks';

async function mcpInitSession() {
  const resp = await fetch(`${MCP_BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MCP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'mcp-gsc-smoke', version: '1.0.0' },
      },
    }),
  });
  return resp.headers.get('mcp-session-id') || '';
}

async function mcpCall(sessionId, body) {
  const resp = await fetch(`${MCP_BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MCP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/event-stream') || text.includes('\ndata: ') || text.startsWith('data: ')) {
    const dataLines = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length));
    return JSON.parse(dataLines.join(''));
  }
  return JSON.parse(text);
}

test('CHECK 1: GET / returns 200 and contains "mcp-gsc"', async () => {
  const resp = await fetch(`${MCP_BASE_URL}/`);
  assert.equal(resp.status, 200);
  const body = await resp.text();
  assert.ok(
    body.includes('mcp-gsc'),
    `body did not contain 'mcp-gsc': ${body.slice(0, 200)}`,
  );
});

test('CHECK 2: GET /healthz returns 200 with body "ok"', async () => {
  const resp = await fetch(`${MCP_BASE_URL}/healthz`);
  assert.equal(resp.status, 200);
  const body = await resp.text();
  assert.equal(body, 'ok');
});

test('CHECK 3: GET /authorize without params is 4xx (not 200, not 500)', async () => {
  const resp = await fetch(`${MCP_BASE_URL}/authorize`);
  assert.ok(
    resp.status >= 400 && resp.status < 500,
    `expected 4xx, got ${resp.status}`,
  );
});

test('CHECK 4: POST /mcp without auth returns 401', async () => {
  const resp = await fetch(`${MCP_BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'unauth', version: '1' },
      },
    }),
  });
  assert.equal(resp.status, 401);
});

test(
  'CHECK 5: tools/list contains all 5 expected tool names',
  { skip: skipReason },
  async () => {
    const session = await mcpInitSession();
    assert.ok(session, 'no Mcp-Session-Id returned from initialize');
    const env = await mcpCall(session, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    assert.ok(!env.error, `tools/list returned error: ${JSON.stringify(env.error)}`);
    const tools = env?.result?.tools ?? [];
    const names = new Set(tools.map((t) => t.name));
    const expected = [
      'list_sites',
      'query_search_analytics',
      'inspect_url',
      'list_sitemaps',
      'get_capabilities',
    ];
    for (const name of expected) {
      assert.ok(
        names.has(name),
        `tools/list missing tool '${name}' (got: ${[...names].sort().join(', ')})`,
      );
    }
  },
);

test(
  'CHECK 6: list_sites returns a JSON array',
  { skip: skipReason },
  async () => {
    const session = await mcpInitSession();
    assert.ok(session, 'no Mcp-Session-Id returned from initialize');
    const env = await mcpCall(session, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_sites', arguments: {} },
    });
    assert.ok(!env.error, `list_sites returned error: ${JSON.stringify(env.error)}`);
    const text = env?.result?.content?.[0]?.text ?? '';
    assert.ok(text, 'list_sites returned no content');
    const parsed = JSON.parse(text);
    assert.ok(
      Array.isArray(parsed),
      `list_sites payload is not a JSON array: ${text.slice(0, 200)}`,
    );
  },
);
