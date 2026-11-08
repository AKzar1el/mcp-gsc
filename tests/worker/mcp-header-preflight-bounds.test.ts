import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { mcpApiHandler, type Env } from '../../src/index';

const maxBytes = 2 * 1024 * 1024;
const headers = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'Mcp-Method': 'server/discover',
};

function makeBody(bytes: number, id: string | number | null = 27): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    ...(id === null ? {} : { id }),
    method: 'server/discover',
    params: { pad: 'x'.repeat(bytes) },
  });
}

async function send(body: string, additional: Record<string, string> = {}) {
  return mcpApiHandler.fetch(
    new Request('https://worker.example/mcp', {
      method: 'POST',
      headers: { ...headers, ...additional },
      body,
    }),
    env as Env,
    {} as ExecutionContext,
  );
}

describe('MCP version-header preflight body bound', () => {
  it('preserves the original JSON-RPC header mismatch for small requests', async () => {
    const response = await send(makeBody(32, 'sample-id'));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      id: 'sample-id',
      error: { code: -32020 },
    });
  });

  it('rejects oversized advertised content before JSON parsing', async () => {
    const response = await send(makeBody(20), { 'Content-Length': String(maxBytes + 1) });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: -32600 } });
  });

  it('rejects actual oversized content when Content-Length is absent', async () => {
    const response = await send(makeBody(maxBytes + 64));
    expect(response.status).toBe(413);
  });

  it('rejects actual oversized content when Content-Length understates it', async () => {
    const response = await send(makeBody(maxBytes + 64), { 'Content-Length': '32' });
    expect(response.status).toBe(413);
  });

  it('rejects a chunked streaming body that exceeds the limit without Content-Length', async () => {
    let emitted = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const nextBytes = Math.min(64 * 1024, maxBytes + 32 - emitted);
        if (nextBytes <= 0) {
          controller.close();
          return;
        }
        emitted += nextBytes;
        controller.enqueue(new Uint8Array(nextBytes).fill(120));
      },
    });
    const response = await mcpApiHandler.fetch(
      new Request('https://worker.example/mcp', {
        method: 'POST',
        headers,
        body: stream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
      env as Env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(413);
  });

  it('accepts the exact byte limit in the preflight and preserves the header error', async () => {
    const overhead = new TextEncoder().encode(makeBody(0)).byteLength;
    const response = await send(makeBody(maxBytes - overhead));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ id: 27, error: { code: -32020 } });
  });

  it('does not invent a header mismatch for a notification without id', async () => {
    const response = await send(makeBody(12, null));
    const body = await response.text();
    expect(body).not.toContain('HeaderMismatch: MCP-Protocol-Version');
  });

  it('does not apply the missing-version guard to normal versioned requests', async () => {
    const response = await send(makeBody(8), { 'MCP-Protocol-Version': '2025-06-18' });
    const body = await response.text();
    expect(body).not.toContain('HeaderMismatch: MCP-Protocol-Version');
  });
});
