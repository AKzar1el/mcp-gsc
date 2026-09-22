import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../../src/entrypoint';
import { type Env } from '../../src/index';

type InspectionEnv = Env & {
  GLAMA_INSPECTION_MODE?: string;
};

const workerEnv = env as unknown as InspectionEnv;
const protocolVersion = '2025-06-18';
const modernProtocolVersion = '2026-07-28';

function request(body: Record<string, unknown>) {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': protocolVersion,
  });

  return new Request('https://worker.example/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function modernRequest(method: string, body: Record<string, unknown>) {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': modernProtocolVersion,
    'Mcp-Method': method,
  });

  return new Request('https://worker.example/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function modernParams() {
  return {
    _meta: {
      'io.modelcontextprotocol/protocolVersion': modernProtocolVersion,
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': {
        name: 'mcp-gsc-modern-regression',
        version: '1.0.0',
      },
    },
  };
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
    expect(initialized.headers.get('mcp-session-id')).toBeNull();
    const initializeEnvelope = await readJsonRpc(initialized);
    expect(initializeEnvelope).toHaveProperty('result');

    const listed = await callWorker(
      request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
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
        'insights.page_queries',
        'insights.query_pages',
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
      ),
      inspectionEnv,
    );
    const dataEnvelope = await readJsonRpc(dataCall);
    const dataText = JSON.stringify(dataEnvelope);
    expect(dataText).toContain('Not authenticated');
    expect(dataText).toContain("connector or app settings");
    expect(dataText).not.toContain('Settings → Connectors');
  });

  it('serves the MCP 2026-07-28 stateless lifecycle without initialize', async () => {
    const inspectionEnv: InspectionEnv = {
      ...workerEnv,
      GLAMA_INSPECTION_MODE: 'true',
    };

    const discovered = await callWorker(
      modernRequest('server/discover', {
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: modernParams(),
      }),
      inspectionEnv,
    );
    expect(discovered.status).toBe(200);
    expect(discovered.headers.get('mcp-session-id')).toBeNull();
    const discoverEnvelope = await readJsonRpc(discovered);
    expect(discoverEnvelope).toHaveProperty('result');
    const discoverResult = discoverEnvelope.result as {
      _meta?: Record<string, unknown>;
      supportedVersions?: string[];
    };
    expect(discoverResult.supportedVersions).toContain(modernProtocolVersion);
    expect(discoverResult._meta?.['io.modelcontextprotocol/serverInfo']).toMatchObject({
      name: 'mcp-gsc',
    });

    const listed = await callWorker(
      modernRequest('tools/list', {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: modernParams(),
      }),
      inspectionEnv,
    );
    expect(listed.status).toBe(200);
    expect(listed.headers.get('mcp-session-id')).toBeNull();
    const listEnvelope = await readJsonRpc(listed);
    const result = listEnvelope.result as {
      _meta?: Record<string, unknown>;
      resultType?: string;
      tools: Array<{ name: string }>;
    };
    expect(result.resultType).toBe('complete');
    expect(result._meta?.['io.modelcontextprotocol/serverInfo']).toMatchObject({
      name: 'mcp-gsc',
    });
    expect(result.tools.map((tool) => tool.name)).toContain('analytics.query');
  });

  it('rejects a modern MCP request that omits MCP-Protocol-Version', async () => {
    const inspectionEnv: InspectionEnv = {
      ...workerEnv,
      GLAMA_INSPECTION_MODE: 'true',
    };
    const missingVersionHeader = new Request('https://worker.example/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Method': 'server/discover',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'server/discover',
        params: modernParams(),
      }),
    });

    const response = await callWorker(missingVersionHeader, inspectionEnv);
    expect(response.status).toBe(400);
    const envelope = await readJsonRpc(response);
    expect(envelope).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: -32020,
      },
    });
  });

  it('keeps legacy initialization compatible when no protocol header is sent', async () => {
    const inspectionEnv: InspectionEnv = {
      ...workerEnv,
      GLAMA_INSPECTION_MODE: 'true',
    };
    const legacyWithoutVersionHeader = new Request('https://worker.example/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'initialize',
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'legacy-no-version-header', version: '1.0.0' },
        },
      }),
    });

    const response = await callWorker(legacyWithoutVersionHeader, inspectionEnv);
    expect(response.status).toBe(200);
    const envelope = await readJsonRpc(response);
    expect(envelope).toHaveProperty('result');
  });
});
