import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const expectedTools = [
  'analytics.compare',
  'analytics.query',
  'indexing.list_pages',
  'indexing.request',
  'insights.cannibalization',
  'insights.content_decay',
  'insights.quick_wins',
  'reports.weekly_digest',
  'server.capabilities',
  'sitemaps.delete',
  'sitemaps.get',
  'sitemaps.list',
  'sitemaps.submit',
  'sites.add',
  'sites.delete',
  'sites.list',
  'urls.inspect',
];

test('Glama stdio entrypoint exposes the production tool catalog', async () => {
  const client = new Client({ name: 'glama-stdio-regression', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['tsx', 'scripts/glama-stdio.ts'],
    stderr: 'inherit',
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const actualTools = tools.map((tool) => tool.name).sort();

    assert.deepEqual(actualTools, expectedTools);
    for (const tool of tools) {
      assert.ok(tool.description, `tool '${tool.name}' is missing a description`);
      assert.ok(tool.inputSchema, `tool '${tool.name}' is missing an input schema`);
    }
  } finally {
    await client.close();
  }
});
