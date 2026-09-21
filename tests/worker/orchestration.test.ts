import { afterEach, describe, expect, it, vi } from 'vitest';
import { reset, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { generateWeeklyDigest } from '../../src/digest';
import { GoogleAccessTokenLifecycle } from '../../src/access-token-lifecycle';
import {
  createGscMcpServer,
  defaultHandler,
  mcpApiHandler,
  PendingAuthState,
  type Env,
} from '../../src/index';
import {
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
} from '../../src/google';
import { getDecryptedRefreshToken, getUser, saveUser } from '../../src/storage';

const workerEnv = env as unknown as Env;

afterEach(async () => {
  await reset();
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

async function readMcpJsonRpc(response: Response) {
  const text = await response.text();
  const dataLines = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));
  return JSON.parse(dataLines.length ? dataLines.join('') : text) as Record<string, unknown>;
}

function createPendingStateBinding() {
  const pending = new Map<string, { claudeAuthRequest: unknown }>();
  return {
    idFromName: (nonce: string) => nonce,
    get: (nonce: string) => ({
      store: async (claudeAuthRequest: unknown) => {
        pending.set(nonce, { claudeAuthRequest });
      },
      consume: async () => {
        const value = pending.get(nonce) ?? null;
        pending.delete(nonce);
        return value;
      },
    }),
  };
}

describe('Worker orchestration', () => {
  it('uses configured KV and Durable Object bindings to consume OAuth state once', async () => {
    expect(workerEnv.OAUTH_KV).toBeDefined();
    expect(workerEnv.USER_KV).toBeDefined();
    expect(workerEnv.PENDING_AUTH_STATE).toBeDefined();
    expect(workerEnv.MCP_OBJECT).toBeDefined();

    const nonce = 'concurrent-state';
    const request = { client_id: 'mcp-client', scope: 'openid' };
    const stub = workerEnv.PENDING_AUTH_STATE.get(
      workerEnv.PENDING_AUTH_STATE.idFromName(nonce),
    );
    await runInDurableObject(stub, (instance: PendingAuthState) =>
      instance.store(request),
    );

    const consumed = await Promise.all([
      runInDurableObject(stub, (instance: PendingAuthState) =>
        instance.consume(),
      ),
      runInDurableObject(stub, (instance: PendingAuthState) =>
        instance.consume(),
      ),
    ]);

    expect(consumed.filter((value) => value !== null)).toHaveLength(1);
    expect(consumed.find((value) => value !== null)?.claudeAuthRequest).toEqual(
      request,
    );
    expect(
      await runInDurableObject(stub, (instance: PendingAuthState) =>
        instance.consume(),
      ),
    ).toBeNull();
  });

  it('persists the OAuth callback credential through Worker KV and rejects a reused state', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === GOOGLE_TOKEN_URL) {
        return response({
          access_token: 'callback-access-token',
          refresh_token: 'callback-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'openid email',
        });
      }
      if (url === GOOGLE_USERINFO_URL) {
        return response({ id: 'callback-user', email: 'user@example.test' });
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    };

    const completed: unknown[] = [];
    const oauthProvider = {
      parseAuthRequest: async () => ({
        client_id: 'mcp-client',
        scope: ['openid'],
      }),
      completeAuthorization: async (authorization: unknown) => {
        completed.push(authorization);
        return { redirectTo: 'https://client.example/callback?code=issued' };
      },
    };
    const oauthEnv = {
      ...workerEnv,
      OAUTH_PROVIDER: oauthProvider,
      PENDING_AUTH_STATE: createPendingStateBinding(),
    } as Env;

    try {
      const authorize = await defaultHandler.fetch(
        new Request('https://worker.example/authorize'),
        oauthEnv,
      );
      expect(authorize.status).toBe(302);

      const state = new URL(authorize.headers.get('location')!).searchParams.get(
        'state',
      );
      expect(state).toBeTruthy();

      const callback = await defaultHandler.fetch(
        new Request(
          `https://worker.example/google/callback?code=google-code&state=${state}`,
        ),
        oauthEnv,
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get('location')).toBe(
        'https://client.example/callback?code=issued',
      );
      expect(completed).toHaveLength(1);
      expect(await getDecryptedRefreshToken(workerEnv, 'callback-user')).toBe(
        'callback-refresh-token',
      );

      const reused = await defaultHandler.fetch(
        new Request(
          `https://worker.example/google/callback?code=google-code&state=${state}`,
        ),
        oauthEnv,
      );
      expect(reused.status).toBe(400);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('registers the MCP tool catalog on a stateless server and applies write annotations', async () => {
    const server = await createGscMcpServer(workerEnv, {
      google_id: 'tool-user',
      email: 'tool@example.test',
    });
    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        { annotations?: Record<string, boolean>; inputSchema?: unknown }
      >;
    })._registeredTools;

    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining([
        'analytics.query',
        'insights.page_queries',
        'insights.query_pages',
        'reports.weekly_digest',
        'sites.add',
        'sites.delete',
        'sitemaps.submit',
        'sitemaps.delete',
        'indexing.request',
      ]),
    );
    expect(tools['analytics.query'].inputSchema).toBeDefined();
    expect(tools['insights.page_queries'].inputSchema).toBeDefined();
    expect(tools['insights.query_pages'].inputSchema).toBeDefined();
    expect(tools['sites.add'].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(tools['sites.delete'].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(tools['indexing.request'].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
  });

  it('routes exact page/query drilldowns through Search Analytics filters', async () => {
    await saveUser(
      workerEnv,
      'drilldown-user',
      'drilldown@example.test',
      'drilldown-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'drilldown-user',
        email: 'drilldown@example.test',
      },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<unknown> }
      >;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const analyticsRequests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'drilldown-access-token', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          analyticsRequests.push(body);
          const dimensions = body.dimensions as string[];
          return response({
            rows: dimensions[0] === 'query'
              ? [{ keys: ['seo audit'], clicks: 7, impressions: 90, ctr: 0.077, position: 8.2 }]
              : [{ keys: ['https://example.com/seo-audit/'], clicks: 7, impressions: 90, ctr: 0.077, position: 8.2 }],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const pageResult = await tools['insights.page_queries'].handler({
        site_url: 'sc-domain:example.com',
        page_url: 'https://example.com/seo-audit/',
        start_date: '2026-08-01',
        end_date: '2026-08-31',
        search_type: 'web',
      }) as { structuredContent: { page: string; queries: Array<{ query: string }> } };
      const queryResult = await tools['insights.query_pages'].handler({
        site_url: 'sc-domain:example.com',
        query: 'seo audit',
        start_date: '2026-08-01',
        end_date: '2026-08-31',
        search_type: 'web',
      }) as { structuredContent: { query: string; pages: Array<{ page: string }> } };

      expect(pageResult.structuredContent).toMatchObject({
        page: 'https://example.com/seo-audit/',
        queries: [{ query: 'seo audit' }],
      });
      expect(queryResult.structuredContent).toMatchObject({
        query: 'seo audit',
        pages: [{ page: 'https://example.com/seo-audit/' }],
      });
      expect(analyticsRequests).toHaveLength(2);
      expect(analyticsRequests[0]).toMatchObject({
        dimensions: ['query'],
        type: 'web',
        dimensionFilterGroups: [{
          groupType: 'and',
          filters: [{ dimension: 'page', operator: 'equals', expression: 'https://example.com/seo-audit/' }],
        }],
      });
      expect(analyticsRequests[1]).toMatchObject({
        dimensions: ['page'],
        type: 'web',
        dimensionFilterGroups: [{
          groupType: 'and',
          filters: [{ dimension: 'query', operator: 'equals', expression: 'seo audit' }],
        }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('propagates OAuth application props through the stateless MCP handler', async () => {
    await saveUser(
      workerEnv,
      'handler-user',
      'handler@example.test',
      'handler-refresh-token',
    );
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'handler-access-token', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites') {
          return response({
            siteEntry: [
              { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
            ],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const result = await mcpApiHandler.fetch(
        new Request('https://worker.example/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-06-18',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'sites.list', arguments: {} },
          }),
        }),
        workerEnv,
        {
          props: {
            google_id: 'handler-user',
            email: 'handler@example.test',
          },
        } as unknown as ExecutionContext,
      );

      expect(result.status).toBe(200);
      const envelope = await readMcpJsonRpc(result);
      expect(JSON.stringify(envelope)).toContain('sc-domain:example.com');
      expect(JSON.stringify(envelope)).not.toContain('Not authenticated');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts a true site-total Search Analytics row when Google omits keys', async () => {
    await saveUser(
      workerEnv,
      'aggregate-user',
      'aggregate@example.test',
      'aggregate-refresh-token',
    );
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'aggregate-access-token', expires_in: 3600 });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query'
        ) {
          return response({
            rows: [
              {
                clicks: 73,
                impressions: 121404,
                ctr: 0.000601,
                position: 58.36,
              },
            ],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const result = await mcpApiHandler.fetch(
        new Request('https://worker.example/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-06-18',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'analytics.query',
              arguments: {
                site_url: 'sc-domain:example.com',
                start_date: '2026-08-22',
                end_date: '2026-09-18',
                dimensions: [],
                row_limit: 1,
              },
            },
          }),
        }),
        workerEnv,
        {
          props: {
            google_id: 'aggregate-user',
            email: 'aggregate@example.test',
          },
        } as unknown as ExecutionContext,
      );

      expect(result.status).toBe(200);
      const envelope = await readMcpJsonRpc(result);
      const serialized = JSON.stringify(envelope);
      expect(serialized).toContain('121404');
      expect(serialized).not.toContain('Output validation error');
      expect(serialized).not.toContain('\"keys\"');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps query/page dimension keys and exposes usable analytics pagination metadata', async () => {
    await saveUser(
      workerEnv,
      'dimension-user',
      'dimension@example.test',
      'dimension-refresh-token',
    );
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'dimension-access-token', expires_in: 3600 });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query'
        ) {
          const body = JSON.parse(String(init?.body)) as {
            dimensions: string[];
          };
          const key =
            body.dimensions[0] === 'query'
              ? 'gsc mcp'
              : 'https://example.com/gsc-mcp/';
          return response({
            rows: [
              {
                keys: [key],
                clicks: 2,
                impressions: 100,
                ctr: 0.02,
                position: 9,
              },
            ],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const callAnalytics = async (
        dimensions: ['query'] | ['page'],
        startRow: number,
      ) =>
        mcpApiHandler.fetch(
          new Request('https://worker.example/mcp', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              'MCP-Protocol-Version': '2025-06-18',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: startRow + 10,
              method: 'tools/call',
              params: {
                name: 'analytics.query',
                arguments: {
                  site_url: 'sc-domain:example.com',
                  start_date: '2026-08-22',
                  end_date: '2026-09-18',
                  dimensions,
                  row_limit: 1,
                  start_row: startRow,
                },
              },
            }),
          }),
          workerEnv,
          {
            props: {
              google_id: 'dimension-user',
              email: 'dimension@example.test',
            },
          } as unknown as ExecutionContext,
        );

      const queryResponse = await callAnalytics(['query'], 0);
      expect(queryResponse.status).toBe(200);
      const querySerialized = JSON.stringify(
        await readMcpJsonRpc(queryResponse),
      );
      expect(querySerialized).toContain('gsc mcp');
      expect(querySerialized).toContain('\"has_more\":true');
      expect(querySerialized).toContain('\"next_start_row\":1');
      expect(querySerialized).not.toContain('Output validation error');

      const pageResponse = await callAnalytics(['page'], 10);
      expect(pageResponse.status).toBe(200);
      const pageSerialized = JSON.stringify(await readMcpJsonRpc(pageResponse));
      expect(pageSerialized).toContain('https://example.com/gsc-mcp/');
      expect(pageSerialized).toContain('\"has_more\":true');
      expect(pageSerialized).toContain('\"next_start_row\":11');
      expect(pageSerialized).not.toContain('Output validation error');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('bounds structured output for comparison, impression-page proxy, and cannibalization', async () => {
    await saveUser(
      workerEnv,
      'bounded-user',
      'bounded@example.test',
      'bounded-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'bounded-user',
        email: 'bounded@example.test',
      },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const registered = (server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<unknown> }
      >;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const longSuffix = 'x'.repeat(220);
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'bounded-access-token', expires_in: 3600 });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query'
        ) {
          const body = JSON.parse(String(init?.body)) as {
            startDate: string;
            dimensions: string[];
          };
          if (body.dimensions.length === 2) {
            return response({
              rows: Array.from({ length: 800 }, (_, index) => {
                const queryIndex = Math.floor(index / 2);
                return {
                  keys: [
                    `query-${queryIndex}-${longSuffix}`,
                    `https://example.com/candidate-${index}-${longSuffix}`,
                  ],
                  clicks: 1,
                  impressions: 1000 - queryIndex,
                  ctr: 0.001,
                  position: 20 + (index % 2),
                };
              }),
            });
          }
          const isListPageCall = body.startDate === '2026-06-01';
          const rowCount = isListPageCall ? 500 : 700;
          const multiplier = body.startDate === '2026-09-01' ? 2 : 1;
          return response({
            rows: Array.from({ length: rowCount }, (_, index) => ({
              keys: [`https://example.com/page-${index}-${longSuffix}`],
              clicks: (index % 20) * multiplier,
              impressions: 2000 - index,
              ctr: 0.01,
              position: 10 + (index % 40),
            })),
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const indexed = (await registered['indexing.list_pages'].handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        row_limit: 1000,
        start_row: 0,
      })) as {
        structuredContent: {
          result_page: { has_more: boolean; next_start_row?: number };
        };
      };
      expect(indexed.structuredContent.result_page.has_more).toBe(true);
      expect(indexed.structuredContent.result_page.next_start_row).toBeGreaterThan(0);
      expect(
        new TextEncoder().encode(JSON.stringify(indexed.structuredContent)).byteLength,
      ).toBeLessThan(55_000);

      const comparison = (await registered['analytics.compare'].handler({
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-09-01',
        end_date_a: '2026-09-30',
        start_date_b: '2026-08-01',
        end_date_b: '2026-08-31',
        dimension: 'page',
        search_type: 'web',
        limit: 100,
        start_row: 0,
      })) as {
        structuredContent: {
          result_page: { has_more: boolean; next_start_row?: number };
        };
      };
      expect(comparison.structuredContent.result_page.has_more).toBe(true);
      expect(comparison.structuredContent.result_page.next_start_row).toBeGreaterThan(0);
      expect(
        new TextEncoder().encode(JSON.stringify(comparison.structuredContent)).byteLength,
      ).toBeLessThan(55_000);

      const cannibalization = (await registered['insights.cannibalization'].handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-07-01',
        end_date: '2026-07-31',
        min_impressions: 1,
        min_page_percentage: 1,
        limit: 100,
        start_row: 0,
      })) as {
        structuredContent: {
          result_page: { has_more: boolean; next_start_row?: number };
        };
      };
      expect(cannibalization.structuredContent.result_page.has_more).toBe(true);
      expect(cannibalization.structuredContent.result_page.next_start_row).toBeGreaterThan(0);
      expect(
        new TextEncoder().encode(JSON.stringify(cannibalization.structuredContent)).byteLength,
      ).toBeLessThan(55_000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('applies the same Search Analytics segment to both comparison periods', async () => {
    await saveUser(
      workerEnv,
      'compare-user',
      'compare@example.test',
      'compare-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'compare-user',
        email: 'compare@example.test',
      },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<unknown> }
      >;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const analyticsRequests: Array<Record<string, unknown>> = [];
    const filters = [
      {
        groupType: 'and',
        filters: [
          {
            dimension: 'query',
            operator: 'includingRegex',
            expression: 'example|brand',
          },
        ],
      },
    ];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'compare-access-token', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          analyticsRequests.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>,
          );
          return response({
            rows: [
              {
                keys: ['example query'],
                clicks: 10,
                impressions: 100,
                ctr: 0.1,
                position: 5,
              },
            ],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      await tools['analytics.compare'].handler({
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-09-01',
        end_date_a: '2026-09-07',
        start_date_b: '2026-08-25',
        end_date_b: '2026-08-31',
        dimension: 'query',
        search_type: 'web',
        dimension_filter_groups: filters,
      });

      expect(analyticsRequests).toHaveLength(2);
      expect(analyticsRequests.map((request) => request.type)).toEqual([
        'web',
        'web',
      ]);
      expect(
        analyticsRequests.map((request) => request.dimensionFilterGroups),
      ).toEqual([filters, filters]);
      expect(analyticsRequests.map((request) => request.dimensions)).toEqual([
        ['query'],
        ['query'],
      ]);
      expect(analyticsRequests.map((request) => request.startDate)).toEqual([
        '2026-09-01',
        '2026-08-25',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses the normal tool token cache and deletes a revoked stored credential', async () => {
    await saveUser(
      workerEnv,
      'cached-user',
      'cached@example.test',
      'cached-refresh-token',
    );
    await saveUser(
      workerEnv,
      'revoked-user',
      'revoked@example.test',
      'revoked-refresh-token',
    );
    const lifecycle = new GoogleAccessTokenLifecycle(workerEnv);
    const cachedServer = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'cached-user',
        email: 'cached@example.test',
      },
      lifecycle,
    );
    const cachedTools = (cachedServer as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, never>) => Promise<unknown> }
      >;
    })._registeredTools;
    const revokedServer = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'revoked-user',
        email: 'revoked@example.test',
      },
      lifecycle,
    );
    const revokedTools = (revokedServer as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: Record<string, never>) => Promise<unknown> }
        >;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    let cachedRefreshes = 0;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          const body = String(init?.body ?? '');
          if (body.includes('revoked-refresh-token')) {
            return response({ error: 'invalid_grant' }, 400);
          }
          cachedRefreshes += 1;
          return response({ access_token: 'cached-access-token', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites') {
          return response({ siteEntry: [] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      await cachedTools['sites.list'].handler({});
      await cachedTools['sites.list'].handler({});
      expect(cachedRefreshes).toBe(1);

      await expect(revokedTools['sites.list'].handler({})).rejects.toThrow(
        "Google access revoked. Please reconnect this server from your MCP client's connector or app settings.",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(await getUser(workerEnv, 'revoked-user')).toBeNull();
    expect(await getUser(workerEnv, 'cached-user')).not.toBeNull();
  });

  it('orchestrates the weekly digest through stored credentials and deterministic analytics responses', async () => {
    await saveUser(
      workerEnv,
      'digest-user',
      'digest@example.test',
      'digest-refresh-token',
    );
    const originalFetch = globalThis.fetch;
    const analyticsRequests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'digest-access-token', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          analyticsRequests.push(body);
          const dimensions = body.dimensions as string[];
          if (dimensions.length === 0) {
            return response({ rows: [{ keys: [], clicks: 20, impressions: 200, ctr: 0.1, position: 8 }] });
          }
          if (dimensions[0] === 'query') {
            return response({
              rows: [
                {
                  keys: ['example query'],
                  clicks: body.startDate === '2026-01-08' ? 10 : 1,
                  impressions: 100,
                  ctr: 0.1,
                  position: 9,
                },
              ],
            });
          }
          return response({ rows: [{ keys: ['https://example.com/page'], clicks: 10, impressions: 100, ctr: 0.1, position: 9 }] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const markdown = await generateWeeklyDigest(
        new GoogleAccessTokenLifecycle(workerEnv),
        'digest-user',
        'https://example.com/',
        '2026-01-14',
      );

      expect(markdown).toContain('Week of 2026-01-08 to 2026-01-14');
      expect(markdown).toContain('example query');
      expect(analyticsRequests).toHaveLength(5);
      expect(analyticsRequests.map((request) => request.dimensions)).toEqual([
        [],
        [],
        ['query'],
        ['query'],
        ['page'],
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('defaults the weekly digest to the latest usually-complete Search Console date', async () => {
    await saveUser(
      workerEnv,
      'digest-default-user',
      'digest-default@example.test',
      'digest-default-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'digest-default-user',
        email: 'digest-default@example.test',
      },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<unknown> }
      >;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const analyticsRequests: Array<Record<string, unknown>> = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T06:30:00Z'));

    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'digest-default-access-token', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query') {
          analyticsRequests.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>,
          );
          return response({ rows: [] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      await tools['reports.weekly_digest'].handler({
        site_url: 'https://example.com/',
      });

      expect(analyticsRequests).toHaveLength(5);
      expect(analyticsRequests.map((request) => request.startDate)).toEqual([
        '2026-09-10',
        '2026-09-03',
        '2026-09-10',
        '2026-09-03',
        '2026-09-10',
      ]);
      expect(analyticsRequests.map((request) => request.endDate)).toEqual([
        '2026-09-16',
        '2026-09-09',
        '2026-09-16',
        '2026-09-09',
        '2026-09-16',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });
});
