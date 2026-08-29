import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../../src/entrypoint';
import { type Env } from '../../src/index';

type InspectionEnv = Env & {
  GLAMA_INSPECTION_MODE?: string;
};

const workerEnv = env as unknown as InspectionEnv;
const protocolVersion = '2025-06-18';

function request(body: Record<string, unknown>, sessionId?: string) {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': protocolVersion,
  });
  if (sessionId) headers.set('Mcp-Session-Id', sessionId);

  return new Request('https://worker.example/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function callWorker(req: Request, runtimeEnv: InspectionEnv) {
  return (worker as unknown as {
    fetch(
      request: Request,
      env: InspectionEnv,
      ctx: ExecutionContext,
    ): Promise<Response>;
  }).fetch(req, runtimeEnv, {} as ExecutionContext);
}

async function readJsonRpc(response: Response) {
  const text = await response.text();
  const dataLines = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));
  return JSON.parse(dataLines.length ? dataLines.join('') : text) as Record<string, unknown>;
}

describe('Glama inspection mode', () => {
  it('allows unauthenticated discovery only when explicitly enabled', async () => {
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'glama-inspector', version: '1.0.0' },
      },
    };

    const normal = await callWorker(request(initialize), workerEnv);
    expect(normal.status).toBe(401);

    const inspectionEnv: InspectionEnv = {
      ...workerEnv,
      GLAMA_INSPECTION_MODE: 'true',
    };
    const initialized = await callWorker(request(initialize), inspectionEnv);
    expect(initialized.status).toBe(200);

    const sessionId = initialized.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    const initializeEnvelope = await readJsonRpc(initialized);
    expect(initializeEnvelope).toHaveProperty('result');

    const listed = await callWorker(
      request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionId!),
      inspectionEnv,
    );
    expect(listed.status).toBe(200);
    const envelope = await readJsonRpc(listed);
    const tools = (envelope.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'server.capabilities',
        'sites.list',
        'analytics.query',
        'urls.inspect',
        'reports.weekly_digest',
        'indexing.request',
      ]),
    );

    const dataCall = await callWorker(
      request(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'sites.list', arguments: {} },
        },
        sessionId!,
      ),
      inspectionEnv,
    );
    const dataEnvelope = await readJsonRpc(dataCall);
    expect(JSON.stringify(dataEnvelope)).toContain('Not authenticated');
  });
});
