import { afterEach, describe, expect, it, vi } from 'vitest';
import { reset, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { generateWeeklyDigest } from '../../src/digest';
import { getSearchConsoleCalendarDate } from '../../src/date-validation';
import { GoogleAccessTokenLifecycle } from '../../src/access-token-lifecycle';
import {
  createGscMcpServer,
  defaultHandler,
  mcpApiHandler,
  PendingAuthState,
  type Env,
} from '../../src/index';
import {
  GSC_ACCESS_REVOKED_MESSAGE,
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
  it('denies all four property/sitemap metadata reads before requesting Google credentials', async () => {
    const take = vi.fn(async (_bucket: string, _policy: { category: string }, _units: number) => (
      { allowed: false, retry_after_ms: 30_000 }
    ));
    const limiter = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ take })),
    };
    const getAccessToken = vi.fn(async () => {
      throw new Error('Denied requests must not reach credential refresh');
    });
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly', TOOL_RATE_LIMITER: limiter } as unknown as Env,
      { google_id: 'metadata-budget-user', email: 'metadata@example.test' },
      { getAccessToken } as unknown as GoogleAccessTokenLifecycle,
    );
    const tools = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, string>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
      }>;
    })._registeredTools;
    const requests = [
      ['sites.list', {}],
      ['sites.get', { site_url: 'sc-domain:example.com' }],
      ['sitemaps.list', { site_url: 'sc-domain:example.com' }],
      ['sitemaps.get', { site_url: 'sc-domain:example.com', feedpath: 'https://example.com/sitemap.xml' }],
    ] as const;

    for (const [name, args] of requests) {
      const result = await tools[name].handler(args);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(`Rate limit reached for ${name}`);
    }
    expect(take).toHaveBeenCalledTimes(4);
    expect(take.mock.calls.every((call) => call[1]?.category === 'search-console-metadata-read')).toBe(true);
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('charges indexing write ownership checks to the shared metadata budget', async () => {
    const take = vi.fn(async (_bucket: string, policy: { category: string }) => ({
      allowed: policy.category !== 'search-console-metadata-read',
      retry_after_ms: 30_000,
    }));
    const getAccessToken = vi.fn(async () => {
      throw new Error('Denied metadata reads must not request Google credentials');
    });
    const server = await createGscMcpServer(
      {
        GSC_ACCESS_MODE: 'readwrite',
        TOOL_RATE_LIMITER: {
          idFromName: (name: string) => name,
          get: () => ({ take }),
        },
      } as unknown as Env,
      { google_id: 'indexing-owner-budget-user', email: 'indexing-owner@example.test' },
      { getAccessToken } as unknown as GoogleAccessTokenLifecycle,
    );
    const tools = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: { site_url: string; url: string }) => Promise<{
          isError?: boolean;
          content?: Array<{ text?: string }>;
        }>;
      }>;
    })._registeredTools;

    for (const name of ['indexing.request', 'indexing.remove']) {
      const result = await tools[name].handler({
        site_url: 'sc-domain:example.com',
        url: 'https://example.com/careers/engineer',
      });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain('Rate limit reached for sites.list');
    }
    expect(take.mock.calls.map((call) => call[1].category)).toEqual([
      'indexing-request',
      'search-console-metadata-read',
      'indexing-request',
      'search-console-metadata-read',
    ]);
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('stops indexing write ownership retries when the metadata budget is exhausted', async () => {
    const originalFetch = globalThis.fetch;
    try {
      for (const name of ['indexing.request', 'indexing.remove']) {
        let metadataReservations = 0;
        const take = vi.fn(async (_bucket: string, policy: { category: string }) => {
          if (policy.category === 'search-console-metadata-read') {
            metadataReservations += 1;
            return { allowed: metadataReservations === 1, retry_after_ms: 30_000 };
          }
          return { allowed: true };
        });
        const server = await createGscMcpServer(
          {
            GSC_ACCESS_MODE: 'readwrite',
            TOOL_RATE_LIMITER: {
              idFromName: (key: string) => key,
              get: () => ({ take }),
            },
          } as unknown as Env,
          { google_id: `indexing-retry-${name}`, email: 'indexing-retry@example.test' },
          { getAccessToken: async () => 'access-token' } as unknown as GoogleAccessTokenLifecycle,
        );
        const handler = (server as unknown as {
          _registeredTools: Record<string, {
            handler: (args: { site_url: string; url: string }) => Promise<unknown>;
          }>;
        })._registeredTools[name].handler;
        const outboundUrls: string[] = [];
        globalThis.fetch = async (input: RequestInfo | URL) => {
          const url = requestUrl(input);
          outboundUrls.push(url);
          if (url === 'https://www.googleapis.com/webmasters/v3/sites') {
            return new Response('transient', {
              status: 503,
              headers: { 'retry-after': '0' },
            });
          }
          throw new Error(`Unexpected outbound request: ${url}`);
        };

        await expect(handler({
          site_url: 'sc-domain:example.com',
          url: 'https://example.com/careers/engineer',
        })).rejects.toThrow('Search Console metadata retry budget exhausted');
        expect(outboundUrls).toEqual(['https://www.googleapis.com/webmasters/v3/sites']);
        expect(take.mock.calls.map((call) => call[1].category)).toEqual([
          'indexing-request',
          'search-console-metadata-read',
          'search-console-metadata-read',
        ]);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('charges a separate Search Analytics budget unit before a retry', async () => {
    const take = vi.fn(async () => ({ allowed: true }));
    const server = await createGscMcpServer(
      {
        GSC_ACCESS_MODE: 'readonly',
        TOOL_RATE_LIMITER: { idFromName: (name: string) => name, get: () => ({ take }) },
      } as unknown as Env,
      { google_id: 'analytics-retry-user', email: 'analytics-retry@example.test' },
      { getAccessToken: async () => 'access-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools['analytics.query'].handler;
    const originalFetch = globalThis.fetch;
    let requests = 0;
    try {
      globalThis.fetch = async () => {
        requests += 1;
        if (requests === 1) {
          return new Response('transient', { status: 503, headers: { 'retry-after': '0' } });
        }
        return response({ rows: [] });
      };
      await handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-09-01',
        end_date: '2026-09-07',
        dimensions: ['query'],
        row_limit: 5,
        start_row: 0,
        search_type: 'web',
        data_state: 'final',
      });
      expect(requests).toBe(2);
      expect(take).toHaveBeenCalledTimes(2);
      expect(take.mock.calls.map((call) => [call[1].category, call[2]])).toEqual([
        ['search-analytics', 1], ['search-analytics', 1],
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('pages and sorts property lists without breaking the legacy text array', async () => {
    const server = await createGscMcpServer(
      {
        GSC_ACCESS_MODE: 'readonly',
        TOOL_RATE_LIMITER: {
          idFromName: (name: string) => name,
          get: () => ({ take: async () => ({ allowed: true }) }),
        },
      } as unknown as Env,
      { google_id: 'many-properties-user', email: 'many@example.test' },
      { getAccessToken: async () => 'access-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<{
          content: Array<{ text: string }>;
          structuredContent: {
            sites: Array<{ siteUrl: string }>;
            result_page: { has_more: boolean; next_start_row?: number; total_count: number };
          };
        }>;
      }>;
    })._registeredTools['sites.list'].handler;
    const originalFetch = globalThis.fetch;
    const properties = Array.from({ length: 145 }, (_, i) => ({
      siteUrl: `sc-domain:site-${String(144 - i).padStart(3, '0')}.example`,
      permissionLevel: 'siteOwner',
    }));
    try {
      globalThis.fetch = async () => response({ siteEntry: properties });
      const first = await handler({ limit: 50 });
      const second = await handler({ start_row: 50, limit: 50 });
      const last = await handler({ start_row: 100, limit: 50 });
      expect(first.structuredContent.sites).toHaveLength(50);
      expect(second.structuredContent.sites).toHaveLength(50);
      expect(last.structuredContent.sites).toHaveLength(45);
      expect(last.structuredContent.result_page.has_more).toBe(false);
      expect(first.structuredContent.result_page).toMatchObject({
        has_more: true, next_start_row: 50, total_count: 145,
      });
      expect(first.structuredContent.sites[0].siteUrl).toBe('sc-domain:site-000.example');
      expect(second.structuredContent.sites[0].siteUrl).toBe('sc-domain:site-050.example');
      expect(JSON.parse(first.content[0].text)).toEqual(first.structuredContent.sites);
      expect(JSON.parse(first.content[1].text)).toEqual({
        result_page: first.structuredContent.result_page,
      });
      const largeProperties = Array.from({ length: 90 }, (_, i) => ({
        siteUrl: `sc-domain:site-${String(i).padStart(3, '0')}-${'x'.repeat(1100)}.example`,
        permissionLevel: 'siteOwner',
      }));
      globalThis.fetch = async () => response({ siteEntry: largeProperties });
      const bounded = await handler({ limit: 90 });
      expect(bounded.structuredContent.result_page.has_more).toBe(true);
      expect(bounded.structuredContent.result_page.next_start_row).toBeGreaterThan(0);
      expect(new TextEncoder().encode(bounded.content[0].text).byteLength).toBeLessThan(48_000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('bounds sitemap list payload bytes and supports deterministic continuation', async () => {
    const server = await createGscMcpServer(
      {
        GSC_ACCESS_MODE: 'readonly',
        TOOL_RATE_LIMITER: {
          idFromName: (name: string) => name,
          get: () => ({ take: async () => ({ allowed: true }) }),
        },
      } as unknown as Env,
      { google_id: 'many-sitemaps-user', email: 'sitemaps@example.test' },
      { getAccessToken: async () => 'access-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<{
          isError?: boolean;
          content: Array<{ text: string }>;
          structuredContent: {
            sitemaps: Array<{ path: string }>;
            result_page: {
              has_more: boolean; byte_limit_reached: boolean;
              next_start_row?: number; total_count: number;
            };
          };
        }>;
      }>;
    })._registeredTools['sitemaps.list'].handler;
    const originalFetch = globalThis.fetch;
    const sitemaps = Array.from({ length: 90 }, (_, i) => ({
      path: `https://example.com/${String(89 - i).padStart(3, '0')}/${'x'.repeat(1200)}.xml`,
      errors: '0',
    }));
    try {
      globalThis.fetch = async () => response({ sitemap: sitemaps });
      const first = await handler({ site_url: 'sc-domain:example.com', limit: 90 });
      const page = first.structuredContent.result_page;
      expect(first.isError).not.toBe(true);
      expect(page.has_more).toBe(true);
      expect(page.byte_limit_reached).toBe(true);
      expect(page.next_start_row).toBe(first.structuredContent.sitemaps.length);
      expect(first.structuredContent.sitemaps[0].path).toContain('/000/');
      expect(new TextEncoder().encode(first.content[0].text).byteLength).toBeLessThan(48_000);
      const next = await handler({
        site_url: 'sc-domain:example.com', limit: 90, start_row: page.next_start_row,
      });
      expect(next.structuredContent.sitemaps[0].path).toContain(
        `/${String(page.next_start_row).padStart(3, '0')}/`,
      );
      expect(next.structuredContent.result_page.total_count).toBe(90);
      globalThis.fetch = async () => response({
        sitemap: [{ path: `https://example.com/${'x'.repeat(55_000)}.xml` }],
      });
      const oversize = await handler({ site_url: 'sc-domain:example.com' });
      expect(oversize.isError).toBe(true);
      expect(oversize.content[0].text).toContain('exceeds the response byte limit');
      globalThis.fetch = async () => response({ sitemap: [] });
      const empty = await handler({ site_url: 'sc-domain:example.com' });
      expect(empty.structuredContent.sitemaps).toHaveLength(0);
      expect(empty.structuredContent.result_page).toMatchObject({
        has_more: false, total_count: 0, byte_limit_reached: false,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not send a Search Analytics retry when the additional unit is denied', async () => {
    const take = vi.fn(async () => (
      take.mock.calls.length === 1
        ? { allowed: true }
        : { allowed: false, retry_after_ms: 2_000 }
    ));
    const server = await createGscMcpServer(
      {
        GSC_ACCESS_MODE: 'readonly',
        TOOL_RATE_LIMITER: { idFromName: (name: string) => name, get: () => ({ take }) },
      } as unknown as Env,
      { google_id: 'analytics-denied-user', email: 'analytics-denied@example.test' },
      { getAccessToken: async () => 'access-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools['analytics.query'].handler;
    const originalFetch = globalThis.fetch;
    let requests = 0;
    try {
      globalThis.fetch = async () => {
        requests += 1;
        return new Response('retryable', { status: 429, headers: { 'retry-after': '0' } });
      };
      await expect(handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-09-01',
        end_date: '2026-09-07',
        dimensions: ['query'],
        row_limit: 5,
        start_row: 0,
        search_type: 'web',
        data_state: 'final',
      })).rejects.toThrow(/Search Analytics retry budget exhausted/);
      expect(requests).toBe(1);
      expect(take).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps the root discovery response deployment-neutral', async () => {
    const result = await defaultHandler.fetch(
      new Request('http://127.0.0.1:8080/'),
      workerEnv,
    );

    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toContain('text/plain');
    await expect(result.text()).resolves.toBe(
      'mcp-gsc — Google Search Console MCP server.\n' +
        'MCP endpoint: http://127.0.0.1:8080/mcp\n' +
        'Setup: https://github.com/AKzar1el/mcp-gsc#readme\n',
    );
  });

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
        responseType: 'code',
        clientId: 'mcp-client',
        redirectUri: 'https://client.example/callback',
        scope: ['openid'],
        state: 'client-state',
        issuer: 'https://worker.example',
      }),
      lookupClient: async () => ({
        clientId: 'mcp-client',
        clientName: 'Test MCP client',
        redirectUris: ['https://client.example/callback'],
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
      expect(authorize.status).toBe(200);
      const consentHtml = await authorize.text();
      const consentNonce = consentHtml.match(
        /name="consent_nonce" value="([^"]+)"/,
      )?.[1];
      expect(consentNonce).toBeTruthy();
      const consentCookie = authorize.headers.get('set-cookie')?.split(';', 1)[0];
      expect(consentCookie).toBeTruthy();
      expect(authorize.headers.get('set-cookie')).toContain('__Host-MCP_GSC_CONSENT=');
      expect(authorize.headers.get('set-cookie')).toContain('Secure');

      const approved = await defaultHandler.fetch(
        new Request('https://worker.example/authorize', {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            cookie: consentCookie!,
          },
          body: new URLSearchParams({
            consent_nonce: consentNonce!,
            decision: 'allow',
          }),
        }),
        oauthEnv,
      );
      expect(approved.status).toBe(302);

      const state = new URL(approved.headers.get('location')!).searchParams.get(
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
        'indexing.status',
        'indexing.request',
        'indexing.remove',
      ]),
    );
    expect(tools['analytics.query'].inputSchema).toBeDefined();
    expect(tools['insights.page_queries'].inputSchema).toBeDefined();
    expect(tools['insights.query_pages'].inputSchema).toBeDefined();
    const analyticsQuerySchema = tools['analytics.query'].inputSchema as {
      safeParse: (value: unknown) => {
        success: boolean;
        data?: {
          data_state?: string;
          dimension_filter_groups?: Array<{
            groupType: string;
            filters: Array<{ operator: string; expression: string }>;
          }>;
        };
      };
    };
    const analyticsCompareSchema = tools['analytics.compare']
      .inputSchema as typeof analyticsQuerySchema;
    const compareDefaults = analyticsCompareSchema.safeParse({
      site_url: 'sc-domain:example.com',
      start_date_a: '2026-09-01',
      end_date_a: '2026-09-07',
      start_date_b: '2026-08-25',
      end_date_b: '2026-08-31',
    });
    expect(compareDefaults.success).toBe(true);
    expect(compareDefaults.data?.data_state).toBe('final');
    expect(
      analyticsCompareSchema.safeParse({
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-09-01',
        end_date_a: '2026-09-07',
        start_date_b: '2026-08-25',
        end_date_b: '2026-08-31',
        data_state: 'hourly_all',
      }).success,
    ).toBe(false);
    const requiredAnalyticsQueryInput = {
      site_url: 'sc-domain:example.com',
      start_date: '2026-09-01',
      end_date: '2026-09-07',
    };
    expect(
      analyticsQuerySchema.safeParse({
        ...requiredAnalyticsQueryInput,
        dimensions: ['query', 'query'],
      }).success,
    ).toBe(false);
    expect(
      analyticsQuerySchema.safeParse({
        ...requiredAnalyticsQueryInput,
        dimensions: ['searchAppearance', 'page'],
      }).success,
    ).toBe(false);
    const filterInput = {
      dimension_filter_groups: [
        {
          filters: [{ dimension: 'country', expression: 'usa' }],
        },
      ],
    };
    for (const [schema, requiredInput] of [
      [
        analyticsQuerySchema,
        {
          site_url: 'sc-domain:example.com',
          start_date: '2026-09-01',
          end_date: '2026-09-07',
        },
      ],
      [
        analyticsCompareSchema,
        {
          site_url: 'sc-domain:example.com',
          start_date_a: '2026-09-01',
          end_date_a: '2026-09-07',
          start_date_b: '2026-08-25',
          end_date_b: '2026-08-31',
        },
      ],
    ] as const) {
      const parsed = schema.safeParse({ ...requiredInput, ...filterInput });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.dimension_filter_groups?.[0]).toEqual({
        groupType: 'and',
        filters: [
          {
            dimension: 'country',
            operator: 'equals',
            expression: 'usa',
          },
        ],
      });
      expect(
        schema.safeParse({
          ...requiredInput,
          dimension_filter_groups: [
            {
              filters: [
                {
                  dimension: 'country',
                  expression: 'x'.repeat(4097),
                },
              ],
            },
          ],
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          ...requiredInput,
          dimension_filter_groups: [
            {
              filters: [
                {
                  dimension: 'country',
                  operator: 'equals',
                  expression: 'us',
                },
              ],
            },
          ],
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          ...requiredInput,
          dimension_filter_groups: [
            {
              filters: [
                {
                  dimension: 'device',
                  operator: 'equals',
                  expression: 'PHONE',
                },
              ],
            },
          ],
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          ...requiredInput,
          dimension_filter_groups: [
            {
              filters: [
                {
                  dimension: 'device',
                  operator: 'includingRegex',
                  expression: 'MOB.*',
                },
              ],
            },
          ],
        }).success,
      ).toBe(true);
    }
    expect(tools['sites.add'].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(tools['sitemaps.submit'].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
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
    expect(tools['indexing.remove'].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(tools['indexing.status'].annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
    });
  });

  it('rejects incompatible Search Analytics requests before budget or credential work', async () => {
    const limiterIdFromName = vi.fn(() => {
      throw new Error('rate limiter should not run');
    });
    const getAccessToken = vi.fn(async () => {
      throw new Error('access-token lifecycle should not run');
    });
    const server = await createGscMcpServer(
      {
        GSC_ACCESS_MODE: 'readwrite',
        TOOL_RATE_LIMITER: { idFromName: limiterIdFromName },
      } as unknown as Env,
      {
        google_id: 'analytics-preflight-user',
        email: 'analytics-preflight@example.test',
      },
      { getAccessToken } as unknown as GoogleAccessTokenLifecycle,
    );
    const analyticsQuery = (server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (input: {
            site_url: string;
            start_date: string;
            end_date: string;
            dimensions: ['hour'];
            row_limit: number;
            start_row: number;
            data_state: 'all';
            search_type: 'web';
            aggregation_type: 'auto';
          }) => Promise<unknown>;
        }
      >;
    })._registeredTools['analytics.query'];

    await expect(
      analyticsQuery.handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-09-01',
        end_date: '2026-09-07',
        dimensions: ['hour'],
        row_limit: 100,
        start_row: 0,
        data_state: 'all',
        search_type: 'web',
        aggregation_type: 'auto',
      }),
    ).rejects.toThrow('Search Analytics hour dimension requires dataState hourly_all.');
    expect(limiterIdFromName).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('rejects future Search Analytics ranges before budget or credential work', async () => {
    const limiterIdFromName = vi.fn(() => {
      throw new Error('rate limiter should not run');
    });
    const getAccessToken = vi.fn(async () => {
      throw new Error('access-token lifecycle should not run');
    });
    const server = await createGscMcpServer(
      {
        GSC_ACCESS_MODE: 'readonly',
        TOOL_RATE_LIMITER: { idFromName: limiterIdFromName },
      } as unknown as Env,
      {
        google_id: 'analytics-future-date-user',
        email: 'analytics-future-date@example.test',
      },
      { getAccessToken } as unknown as GoogleAccessTokenLifecycle,
    );
    const analyticsQuery = (server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (input: {
            site_url: string;
            start_date: string;
            end_date: string;
            dimensions: ['query'];
            row_limit: number;
            start_row: number;
            data_state: 'all';
            search_type: 'web';
            aggregation_type: 'auto';
          }) => Promise<unknown>;
        }
      >;
    })._registeredTools['analytics.query'];

    await expect(
      analyticsQuery.handler({
        site_url: 'sc-domain:example.com',
        start_date: '2999-01-01',
        end_date: '2999-01-02',
        dimensions: ['query'],
        row_limit: 100,
        start_row: 0,
        data_state: 'all',
        search_type: 'web',
        aggregation_type: 'auto',
      }),
    ).rejects.toThrow('end_date must be today or earlier');
    expect(limiterIdFromName).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('rejects page-query URLs outside site_url before budget or credential work', async () => {
    const limiterIdFromName = vi.fn(() => {
      throw new Error('rate limiter should not run');
    });
    const getAccessToken = vi.fn(async () => {
      throw new Error('access-token lifecycle should not run');
    });
    const server = await createGscMcpServer(
      {
        GSC_ACCESS_MODE: 'readonly',
        TOOL_RATE_LIMITER: { idFromName: limiterIdFromName },
      } as unknown as Env,
      {
        google_id: 'page-query-preflight-user',
        email: 'page-query-preflight@example.test',
      },
      { getAccessToken } as unknown as GoogleAccessTokenLifecycle,
    );
    const pageQueries = (server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (input: {
            site_url: string;
            page_url: string;
            start_date: string;
            end_date: string;
            search_type: 'web';
          }) => Promise<unknown>;
        }
      >;
    })._registeredTools['insights.page_queries'];

    await expect(
      pageQueries.handler({
        site_url: 'https://example.com/docs/',
        page_url: 'https://example.com/blog/outside-prefix/',
        start_date: '2026-09-01',
        end_date: '2026-09-07',
        search_type: 'web',
      }),
    ).rejects.toThrow(
      'page_url must belong to the site_url Search Console property.',
    );
    expect(limiterIdFromName).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('rejects Indexing API URLs outside site_url before budget or credential work', async () => {
    const limiterIdFromName = vi.fn(() => {
      throw new Error('rate limiter should not run');
    });
    const getAccessToken = vi.fn(async () => {
      throw new Error('access-token lifecycle should not run');
    });
    const server = await createGscMcpServer(
      {
        GSC_ACCESS_MODE: 'readwrite',
        TOOL_RATE_LIMITER: { idFromName: limiterIdFromName },
      } as unknown as Env,
      {
        google_id: 'indexing-preflight-user',
        email: 'indexing-preflight@example.test',
      },
      { getAccessToken } as unknown as GoogleAccessTokenLifecycle,
    );
    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (input: { site_url: string; url: string }) => Promise<unknown>;
        }
      >;
    })._registeredTools;

    for (const toolName of ['indexing.status', 'indexing.request', 'indexing.remove']) {
      await expect(
        tools[toolName].handler({
          site_url: 'sc-domain:example.com',
          url: 'https://outside.example.net/job',
        }),
      ).rejects.toThrow('url must belong to the site_url Search Console property.');
    }
    expect(limiterIdFromName).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('rejects duplicate urls.inspect_many inputs before provider work', async () => {
    const originalFetch = globalThis.fetch;
    let outboundRequests = 0;
    globalThis.fetch = async () => {
      outboundRequests += 1;
      throw new Error('Duplicate inspection input must not reach a provider request.');
    };

    try {
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
            id: 81,
            method: 'tools/call',
            params: {
              name: 'urls.inspect_many',
              arguments: {
                site_url: 'sc-domain:example.com',
                inspection_urls: [
                  'https://example.com/page',
                  'https://example.com/page',
                ],
              },
            },
          }),
        }),
        workerEnv,
        {
          props: {
            google_id: 'duplicate-inspection-user',
            email: 'duplicate-inspection@example.test',
          },
        } as unknown as ExecutionContext,
      );

      expect(result.status).toBe(200);
      const serialized = JSON.stringify(await readMcpJsonRpc(result));
      expect(serialized).toContain('inspection_urls must not contain duplicate URLs');
      expect(outboundRequests).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('charges URL Inspection retries separately from first attempts', async () => {
    const take = vi.fn(async () => ({ allowed: true }));
    const limiter = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ take })),
    };
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly', TOOL_RATE_LIMITER: limiter } as unknown as Env,
      { google_id: 'inspection-retry-user', email: 'inspection-retry@example.test' },
      { getAccessToken: async () => 'test-access-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools['urls.inspect'].handler;
    const originalFetch = globalThis.fetch;
    const attempts = new Map<string, number>();

    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const inspectionUrl = (JSON.parse(String(init?.body)) as { inspectionUrl: string }).inspectionUrl;
        const count = (attempts.get(inspectionUrl) ?? 0) + 1;
        attempts.set(inspectionUrl, count);
        if (inspectionUrl.endsWith('/retry') && count === 1) {
          return new Response('temporarily unavailable', {
            status: 503,
            headers: { 'retry-after': '0' },
          });
        }
        return response({ inspectionResult: { indexStatusResult: { verdict: 'PASS' } } });
      };

      for (const inspectionUrl of ['https://example.com/stable', 'https://example.com/retry']) {
        await handler({ site_url: 'sc-domain:example.com', inspection_url: inspectionUrl });
      }
      expect(attempts.get('https://example.com/stable')).toBe(1);
      expect(attempts.get('https://example.com/retry')).toBe(2);
      expect(take).toHaveBeenCalledTimes(3);
      expect(take.mock.calls.map((call) => call[2])).toEqual([1, 1, 1]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('stops URL Inspection before a retry when the daily budget is exhausted', async () => {
    let reservations = 0;
    const take = vi.fn(async () => (
      ++reservations === 1 ? { allowed: true } : { allowed: false, retry_after_ms: 5_000 }
    ));
    const limiter = {
      idFromName: (name: string) => name,
      get: () => ({ take }),
    };
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly', TOOL_RATE_LIMITER: limiter } as unknown as Env,
      { google_id: 'inspection-denied-user', email: 'inspection-denied@example.test' },
      { getAccessToken: async () => 'test-access-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools['urls.inspect'].handler;
    const originalFetch = globalThis.fetch;
    let providerCalls = 0;

    try {
      globalThis.fetch = async () => {
        providerCalls += 1;
        return providerCalls === 1
          ? new Response('try again', { status: 429, headers: { 'retry-after': '0' } })
          : response({ inspectionResult: { indexStatusResult: { verdict: 'PASS' } } });
      };

      await expect(handler({
        site_url: 'sc-domain:example.com',
        inspection_url: 'https://example.com/denied',
      })).rejects.toThrow(/URL Inspection retry budget exhausted/);
      expect(providerCalls).toBe(1);
      expect(take).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accounts for concurrent batch retries and returns per-URL budget failures', async () => {
    let usedUnits = 0;
    const take = vi.fn(async (_bucket: string, _policy: unknown, units: number) => {
      if (usedUnits + units > 3) return { allowed: false, retry_after_ms: 5_000 };
      usedUnits += units;
      return { allowed: true };
    });
    const limiter = {
      idFromName: (name: string) => name,
      get: () => ({ take }),
    };
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly', TOOL_RATE_LIMITER: limiter } as unknown as Env,
      { google_id: 'inspection-batch-retry-user', email: 'inspection-batch@example.test' },
      { getAccessToken: async () => 'test-access-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools['urls.inspect_many'].handler;
    const originalFetch = globalThis.fetch;
    const attempts = new Map<string, number>();

    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const inspectionUrl = (JSON.parse(String(init?.body)) as { inspectionUrl: string }).inspectionUrl;
        const count = (attempts.get(inspectionUrl) ?? 0) + 1;
        attempts.set(inspectionUrl, count);
        return count === 1
          ? new Response('transient', { status: 503, headers: { 'retry-after': '0' } })
          : response({ inspectionResult: { indexStatusResult: { verdict: 'PASS' } } });
      };

      const result = await handler({
        site_url: 'sc-domain:example.com',
        inspection_urls: ['https://example.com/a', 'https://example.com/b'],
      }) as {
        structuredContent: {
          requested_count: number;
          succeeded_count: number;
          failed_count: number;
          results: Array<{ error?: string }>;
        };
      };
      expect(result.structuredContent.requested_count).toBe(2);
      expect(result.structuredContent.succeeded_count).toBe(1);
      expect(result.structuredContent.failed_count).toBe(1);
      expect(result.structuredContent.results.filter((entry) => entry.error)).toEqual([
        expect.objectContaining({ error: expect.stringContaining('URL Inspection retry budget exhausted') }),
      ]);
      expect(Array.from(attempts.values()).sort()).toEqual([1, 2]);
      expect(take.mock.calls.map((call) => call[2])).toEqual([2, 1, 1]);
      expect(usedUnits).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('bounds oversized single URL Inspection results without losing indexed state', async () => {
    const take = vi.fn(async () => ({ allowed: true }));
    const limiter = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ take })),
    };
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly', TOOL_RATE_LIMITER: limiter } as unknown as Env,
      { google_id: 'single-inspection-bound-user', email: 'single-inspection@example.test' },
      { getAccessToken: async () => 'test-access-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools['urls.inspect'].handler;
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => response({
        inspectionResult: {
          indexStatusResult: { verdict: 'PASS', coverageState: 'large-status-'.repeat(5_000) },
          richResultsResult: { details: 'x'.repeat(65_000) },
        },
      });

      const result = await handler({
        site_url: 'sc-domain:example.com',
        inspection_url: 'https://example.com/large',
      }) as {
        content: Array<{ text: string }>;
        structuredContent: {
          inspection_result?: unknown;
          inspection_result_omitted?: boolean;
          summary_fields_omitted?: boolean;
          index_status_summary: { indexed_state: string };
          note: string;
        };
      };

      expect(result.structuredContent.index_status_summary.indexed_state).toBe('indexed');
      expect(result.structuredContent.inspection_result).toBeUndefined();
      expect(result.structuredContent.inspection_result_omitted).toBe(true);
      expect(result.structuredContent.summary_fields_omitted).toBe(true);
      expect(result.structuredContent.note).toContain('does not run a live URL test');
      expect(new TextEncoder().encode(JSON.stringify(result.structuredContent)).byteLength).toBeLessThanOrEqual(48_000);
      expect(new TextEncoder().encode(result.content[0].text).byteLength).toBeLessThanOrEqual(48_000);
      expect(take).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('bounds large URL Inspection batches while preserving every URL status', async () => {
    const take = vi.fn(async () => ({ allowed: true }));
    const limiter = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ take })),
    };
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly', TOOL_RATE_LIMITER: limiter } as unknown as Env,
      { google_id: 'inspection-output-user', email: 'inspection-output@example.test' },
      { getAccessToken: async () => 'test-access-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools['urls.inspect_many'].handler;
    const originalFetch = globalThis.fetch;
    const inspectionUrls = [
      'https://example.com/huge-a',
      'https://example.com/small',
      'https://example.com/failed',
      'https://example.com/huge-b',
      'https://example.com/huge-c',
    ];
    let providerCalls = 0;

    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        providerCalls += 1;
        const inspectionUrl = (JSON.parse(String(init?.body)) as { inspectionUrl: string }).inspectionUrl;
        if (inspectionUrl.endsWith('/failed')) return new Response('not found', { status: 404 });
        return response({
          inspectionResult: {
            indexStatusResult: {
              verdict: inspectionUrl.endsWith('/huge-b')
                ? 'NEUTRAL'
                : inspectionUrl.endsWith('/huge-c') ? 'PARTIAL' : 'PASS',
              coverageState: inspectionUrl.endsWith('/huge-a')
                ? 'oversized-status-'.repeat(5_000)
                : 'Submitted and indexed',
            },
            richResultsResult: {
              details: inspectionUrl.endsWith('/small') ? 'normal' : 'x'.repeat(65_000),
            },
          },
        });
      };

      const result = await handler({
        site_url: 'sc-domain:example.com',
        inspection_urls: inspectionUrls,
      }) as {
        content: Array<{ text: string }>;
        structuredContent: {
          requested_count: number;
          succeeded_count: number;
          failed_count: number;
          index_status_counts: { indexed: number; not_indexed: number; unknown: number };
          raw_results_omitted_count: number;
          results: Array<{
            inspection_url: string;
            inspection_result?: unknown;
            index_status_summary?: { indexed_state: string };
            inspection_result_omitted?: boolean;
            error?: string;
          }>;
        };
      };

      const payload = result.structuredContent;
      expect(providerCalls).toBe(inspectionUrls.length);
      expect(payload.requested_count).toBe(5);
      expect(payload.succeeded_count).toBe(4);
      expect(payload.failed_count).toBe(1);
      expect(payload.index_status_counts).toEqual({ indexed: 2, not_indexed: 1, unknown: 1 });
      expect(payload.results.map((entry) => entry.inspection_url)).toEqual(inspectionUrls);
      expect(payload.results.filter((entry) => entry.index_status_summary?.indexed_state === 'indexed')).toHaveLength(2);
      expect(payload.results.filter((entry) => entry.index_status_summary?.indexed_state === 'not_indexed')).toHaveLength(1);
      expect(payload.results.filter((entry) => entry.index_status_summary?.indexed_state === 'unknown')).toHaveLength(1);
      expect(JSON.parse(result.content[0].text).index_status_counts).toEqual(payload.index_status_counts);
      expect(payload.results[2].error).toContain('404');
      expect(payload.results[1].inspection_result).toBeDefined();
      expect(payload.raw_results_omitted_count).toBe(3);
      expect(payload.results.filter((entry) => entry.inspection_result_omitted)).toHaveLength(3);
      expect(payload.results[0]).toMatchObject({ summary_fields_omitted: true });
      expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThanOrEqual(48_000);
      expect(new TextEncoder().encode(result.content[0].text).byteLength).toBeLessThanOrEqual(48_000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns a schema-discoverable URL Inspection index-status summary alongside the raw provider result', async () => {
    await saveUser(
      workerEnv,
      'inspection-summary-user',
      'inspection-summary@example.test',
      'inspection-summary-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'inspection-summary-user',
        email: 'inspection-summary@example.test',
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

    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'inspection-summary-access-token', expires_in: 3600 });
        }
        if (url === 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect') {
          return response({
            inspectionResult: {
              indexStatusResult: {
                verdict: 'PASS',
                coverageState: 'Submitted and indexed',
                robotsTxtState: 'ALLOWED',
                indexingState: 'INDEXING_ALLOWED',
                pageFetchState: 'SUCCESSFUL',
                googleCanonical: 'https://example.com/page',
              },
              richResultsResult: { verdict: 'PASS' },
            },
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const result = await tools['urls.inspect'].handler({
        site_url: 'sc-domain:example.com',
        inspection_url: 'https://example.com/page',
        language_code: 'en-US',
      }) as {
        structuredContent: {
          inspection_result: Record<string, unknown>;
          index_status_summary: Record<string, unknown>;
          note: string;
        };
      };

      expect(result.structuredContent.index_status_summary).toEqual({
        indexed_state: 'indexed',
        verdict: 'PASS',
        coverage_state: 'Submitted and indexed',
        robots_txt_state: 'ALLOWED',
        indexing_state: 'INDEXING_ALLOWED',
        page_fetch_state: 'SUCCESSFUL',
        google_canonical: 'https://example.com/page',
      });
      expect(result.structuredContent.inspection_result).toMatchObject({
        indexStatusResult: { verdict: 'PASS' },
        richResultsResult: { verdict: 'PASS' },
      });
      expect(result.structuredContent.note).toContain('does not run a live URL test');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('adds a Search Console property without implying ownership verification', async () => {
    await saveUser(
      workerEnv,
      'site-add-user',
      'site-add@example.test',
      'site-add-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'site-add-user',
        email: 'site-add@example.test',
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
    const requestedUrls: string[] = [];

    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        requestedUrls.push(url);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'site-add-access-token', expires_in: 3600 });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com'
        ) {
          expect(init?.method).toBe('PUT');
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const result = await tools['sites.add'].handler({
        site_url: 'sc-domain:example.com',
      }) as {
        structuredContent: {
          message: string;
          ownership_verification_performed: boolean;
          ownership_verification_note: string;
        };
      };

      expect(requestedUrls).toContain(
        'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com',
      );
      expect(result.structuredContent.ownership_verification_performed).toBe(false);
      expect(result.structuredContent.ownership_verification_note).toContain(
        'does not verify ownership',
      );
      expect(result.structuredContent.ownership_verification_note).toContain(
        'separate Google Site Verification/Search Console workflow',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('removes a Search Console property from the connected account without implying website deletion', async () => {
    await saveUser(
      workerEnv,
      'site-delete-user',
      'site-delete@example.test',
      'site-delete-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'site-delete-user',
        email: 'site-delete@example.test',
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

    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({
            access_token: 'site-delete-access-token',
            expires_in: 3600,
          });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com'
        ) {
          expect(init?.method).toBe('DELETE');
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const result = await tools['sites.delete'].handler({
        site_url: 'sc-domain:example.com',
      }) as {
        structuredContent: {
          message: string;
          removed_from_connected_account_site_set: boolean;
          website_content_deleted: boolean;
          provider_scope_note: string;
        };
      };

      expect(result.structuredContent.message).toContain(
        "removed site property from the connected account's Search Console site set",
      );
      expect(result.structuredContent.removed_from_connected_account_site_set).toBe(true);
      expect(result.structuredContent.website_content_deleted).toBe(false);
      expect(result.structuredContent.provider_scope_note).toContain(
        "removes the property from the connected user's Search Console site set",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps sitemap write receipts scoped to Search Console effects', async () => {
    await saveUser(
      workerEnv,
      'sitemap-write-user',
      'sitemap-write@example.test',
      'sitemap-write-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'sitemap-write-user',
        email: 'sitemap-write@example.test',
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
    const sitemapUrl = 'https://example.com/sitemap.xml';
    const sitemapEndpoint =
      'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml';

    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({
            access_token: 'sitemap-write-access-token',
            expires_in: 3600,
          });
        }
        if (url === sitemapEndpoint) {
          expect(init?.method === 'PUT' || init?.method === 'DELETE').toBe(true);
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const submitResult = await tools['sitemaps.submit'].handler({
        site_url: 'sc-domain:example.com',
        feedpath: sitemapUrl,
      }) as {
        structuredContent: {
          message: string;
          submitted_to_search_console: boolean;
          sitemap_processing_completion_proven: boolean;
          page_indexing_proven: boolean;
          provider_scope_note: string;
        };
      };
      const deleteResult = await tools['sitemaps.delete'].handler({
        site_url: 'sc-domain:example.com',
        feedpath: sitemapUrl,
      }) as {
        structuredContent: {
          message: string;
          removed_from_search_console: boolean;
          sitemap_file_deleted: boolean;
          page_deindexing_proven: boolean;
          provider_scope_note: string;
        };
      };

      expect(submitResult.structuredContent.submitted_to_search_console).toBe(true);
      expect(
        submitResult.structuredContent.sitemap_processing_completion_proven,
      ).toBe(false);
      expect(submitResult.structuredContent.page_indexing_proven).toBe(false);
      expect(submitResult.structuredContent.provider_scope_note).toContain(
        'not completed sitemap processing or page indexing',
      );

      expect(deleteResult.structuredContent.removed_from_search_console).toBe(true);
      expect(deleteResult.structuredContent.sitemap_file_deleted).toBe(false);
      expect(deleteResult.structuredContent.page_deindexing_proven).toBe(false);
      expect(deleteResult.structuredContent.provider_scope_note).toContain(
        'does not delete the remotely hosted sitemap file',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reads Indexing API notification metadata without implying index coverage', async () => {
    await saveUser(
      workerEnv,
      'indexing-status-user',
      'indexing-status@example.test',
      'indexing-status-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'indexing-status-user',
        email: 'indexing-status@example.test',
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
    const targetUrl = 'https://example.com/careers/senior-engineer';
    let siteListRequests = 0;

    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({
            access_token: 'indexing-status-access-token',
            expires_in: 3600,
          });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites') {
          siteListRequests += 1;
          return response({
            siteEntry: [
              { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
            ],
          });
        }
        const parsed = new URL(url);
        if (
          `${parsed.origin}${parsed.pathname}` ===
          'https://indexing.googleapis.com/v3/urlNotifications/metadata'
        ) {
          expect(parsed.searchParams.get('url')).toBe(targetUrl);
          return response({
            url: targetUrl,
            latestUpdate: {
              url: targetUrl,
              type: 'URL_UPDATED',
              notifyTime: '2026-09-22T07:30:00Z',
            },
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const result = await tools['indexing.status'].handler({
        site_url: 'sc-domain:example.com',
        url: targetUrl,
      }) as {
        structuredContent: {
          notification_metadata: {
            latestUpdate?: { type?: string; notifyTime?: string };
          };
          notification_receipt_only: boolean;
          index_coverage_report: boolean;
          indexing_or_removal_completion_proven: boolean;
          note: string;
        };
      };

      expect(result.structuredContent.notification_metadata.latestUpdate).toMatchObject({
        type: 'URL_UPDATED',
        notifyTime: '2026-09-22T07:30:00Z',
      });
      expect(result.structuredContent.notification_receipt_only).toBe(true);
      expect(result.structuredContent.index_coverage_report).toBe(false);
      expect(result.structuredContent.indexing_or_removal_completion_proven).toBe(false);
      expect(result.structuredContent.note).toContain('does not report whether Google crawled, indexed, or removed');

      // The owner preflight is itself a Google sites.list request. It must
      // consume the same shared metadata budget as explicit property reads.
      for (let index = 0; index < 9; index += 1) {
        const listResult = await tools['sites.list'].handler({}) as { isError?: boolean };
        expect(listResult.isError).not.toBe(true);
      }
      const exhausted = await tools['sites.list'].handler({}) as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
      };
      expect(exhausted.isError).toBe(true);
      expect(exhausted.content?.[0]?.text).toContain('Rate limit reached for sites.list');
      expect(siteListRequests).toBe(10);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('explains sitemap provider timestamps without rewriting provider values', async () => {
    await saveUser(
      workerEnv,
      'sitemap-user',
      'sitemap@example.test',
      'sitemap-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'sitemap-user',
        email: 'sitemap@example.test',
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
    const sitemap = {
      path: 'https://example.com/sitemap.xml',
      lastSubmitted: '2026-08-03T10:00:00Z',
      lastDownloaded: '2026-09-14T08:30:00Z',
      isPending: false,
      warnings: '0',
      errors: '0',
      contents: [{ type: 'web', submitted: '321' }],
    };

    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'sitemap-access-token', expires_in: 3600 });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps'
        ) {
          return response({ sitemap: [sitemap] });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml'
        ) {
          return response(sitemap);
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const listResult = await tools['sitemaps.list'].handler({
        site_url: 'sc-domain:example.com',
      }) as {
        structuredContent: {
          sitemaps: Array<typeof sitemap>;
          provider_note: string;
        };
      };
      const getResult = await tools['sitemaps.get'].handler({
        site_url: 'sc-domain:example.com',
        feedpath: sitemap.path,
      }) as {
        structuredContent: {
          sitemap: typeof sitemap;
          provider_note: string;
        };
      };

      expect(listResult.structuredContent.sitemaps[0].lastSubmitted).toBe(
        '2026-08-03T10:00:00Z',
      );
      expect(listResult.structuredContent.sitemaps[0].lastDownloaded).toBe(
        '2026-09-14T08:30:00Z',
      );
      expect(getResult.structuredContent.sitemap.lastSubmitted).toBe(
        '2026-08-03T10:00:00Z',
      );
      expect(getResult.structuredContent.sitemap.lastDownloaded).toBe(
        '2026-09-14T08:30:00Z',
      );
      for (const note of [
        listResult.structuredContent.provider_note,
        getResult.structuredContent.provider_note,
      ]) {
        expect(note).toContain('submitted to Search Console');
        expect(note).toContain('last downloaded the sitemap');
        expect(note).toContain('not a page crawl or indexing timestamp');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
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
          if ((body.startRow as number | undefined ?? 0) > 0) {
            return response({ rows: [] });
          }
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
      expect(analyticsRequests.map((request) => request.startRow ?? 0)).toEqual([
        0,
        0,
      ]);
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

  it('scopes exact-page query drilldowns by topic at Google before source pagination', async () => {
    await saveUser(workerEnv, 'page-topic-user', 'page-topic@example.test', 'page-topic-refresh');
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'page-topic-user', email: 'page-topic@example.test' },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'page-topic-access-token', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          requests.push(body);
          const groups = body.dimensionFilterGroups as Array<{
            filters: Array<{ dimension: string; operator: string; expression: string }>;
          }>;
          const topicScoped = groups[0]?.filters.some((filter) =>
            filter.dimension === 'query' && filter.operator === 'contains' && filter.expression === 'seo');
          return response({
            rows: [{
              keys: [topicScoped ? 'seo audit' : 'brand name'],
              clicks: 4,
              impressions: 80,
              ctr: 0.05,
              position: 8,
            }],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };
      const input = {
        site_url: 'sc-domain:example.com',
        page_url: 'https://example.com/de/guides/',
        start_date: '2026-08-01',
        end_date: '2026-08-31',
        search_type: 'web',
      };
      const unfiltered = await tools['insights.page_queries'].handler(input) as {
        structuredContent: { query_contains: string | null; device: string | null; queries: Array<{ query: string }> };
      };
      const scoped = await tools['insights.page_queries'].handler({ ...input, query_contains: 'seo', country: 'deu', device: 'mobile' }) as {
        structuredContent: {
          query_contains: string | null;
          country: string | null;
          device: string | null;
          scope_note: string;
          queries: Array<{ query: string }>;
        };
      };
      expect(unfiltered.structuredContent).toMatchObject({
        query_contains: null,
        device: null,
        queries: [{ query: 'brand name' }],
      });
      expect(scoped.structuredContent).toMatchObject({
        query_contains: 'seo',
        country: 'DEU',
        device: 'mobile',
        queries: [{ query: 'seo audit' }],
      });
      expect(scoped.structuredContent.scope_note).toContain('not all queries');
      expect(scoped.structuredContent.scope_note).toContain('searcher country');
      expect(scoped.structuredContent.scope_note).toContain('device');
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        dimensions: ['query'],
        dimensionFilterGroups: [{
          filters: [{ dimension: 'page', operator: 'equals', expression: input.page_url }],
        }],
      });
      expect(requests[1]).toMatchObject({
        dimensions: ['query'],
        dimensionFilterGroups: [{
          groupType: 'and',
          filters: [
            { dimension: 'page', operator: 'equals', expression: input.page_url },
            { dimension: 'query', operator: 'contains', expression: 'seo' },
            { dimension: 'country', operator: 'equals', expression: 'DEU' },
            { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
          ],
        }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('scopes exact-query page drilldowns at Google before source pagination', async () => {
    await saveUser(
      workerEnv,
      'localized-query-user',
      'localized-query@example.test',
      'localized-query-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'localized-query-user',
        email: 'localized-query@example.test',
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
          return response({ access_token: 'localized-query-access-token', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          analyticsRequests.push(body);
          const groups = body.dimensionFilterGroups as Array<{
            filters: Array<{ dimension: string; operator: string; expression: string }>;
          }>;
          const scoped = groups[0]?.filters.some((filter) =>
            filter.dimension === 'page' && filter.operator === 'contains' && filter.expression === '/de/');
          return response({
            rows: [{
              keys: [scoped ? 'https://example.com/de/preise/' : 'https://example.com/en/pricing/'],
              clicks: 5,
              impressions: 100,
              ctr: 0.05,
              position: 9,
            }],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };
      const input = {
        site_url: 'sc-domain:example.com',
        query: 'pricing',
        start_date: '2026-08-01',
        end_date: '2026-08-31',
        search_type: 'web',
      };
      const unfiltered = await tools['insights.query_pages'].handler(input) as {
        structuredContent: { page_contains: string | null; device: string | null; pages: Array<{ page: string }> };
      };
      const scoped = await tools['insights.query_pages'].handler({
        ...input,
        page_contains: '/de/',
        country: 'deu',
        device: 'mobile',
      }) as {
        structuredContent: {
          page_contains: string | null;
          country: string | null;
          device: string | null;
          scope_note: string;
          pages: Array<{ page: string }>;
        };
      };
      expect(unfiltered.structuredContent.page_contains).toBeNull();
      expect(unfiltered.structuredContent.device).toBeNull();
      expect(unfiltered.structuredContent.pages[0]?.page).toBe('https://example.com/en/pricing/');
      expect(scoped.structuredContent).toMatchObject({
        page_contains: '/de/',
        country: 'DEU',
        device: 'mobile',
        pages: [{ page: 'https://example.com/de/preise/' }],
      });
      expect(scoped.structuredContent.scope_note).toContain('not property-wide');
      expect(scoped.structuredContent.scope_note).toContain('searcher country');
      expect(scoped.structuredContent.scope_note).toContain('device');
      expect(analyticsRequests).toHaveLength(2);
      expect(analyticsRequests[0]).toMatchObject({
        dimensions: ['page'],
        dimensionFilterGroups: [{
          filters: [{ dimension: 'query', operator: 'equals', expression: 'pricing' }],
        }],
      });
      expect(analyticsRequests[1]).toMatchObject({
        dimensions: ['page'],
        dimensionFilterGroups: [{
          groupType: 'and',
          filters: [
            { dimension: 'query', operator: 'equals', expression: 'pricing' },
            { dimension: 'page', operator: 'contains', expression: '/de/' },
            { dimension: 'country', operator: 'equals', expression: 'DEU' },
            { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
          ],
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
              { siteUrl: 'https://pending.example.com/', permissionLevel: 'siteUnverifiedUser' },
            ],
          });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com'
        ) {
          return response({
            siteUrl: 'sc-domain:example.com',
            permissionLevel: 'siteOwner',
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
      const serializedList = JSON.stringify(envelope);
      expect(serializedList).toContain('sc-domain:example.com');
      expect(serializedList).toContain('api_identifier_kind');
      expect(serializedList).toContain('mcp_site_url_accepted');
      expect(serializedList).toContain('"verification_state":"verified"');
      expect(serializedList).toContain('"verification_state":"unverified"');
      expect(serializedList).toContain('"owner":true');
      expect(serializedList).toContain('"owner":false');
      expect(serializedList).not.toContain('Not authenticated');

      const detailResult = await mcpApiHandler.fetch(
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
              name: 'sites.get',
              arguments: { site_url: 'sc-domain:example.com' },
            },
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
      expect(detailResult.status).toBe(200);
      const detailEnvelope = await readMcpJsonRpc(detailResult);
      const serializedDetail = JSON.stringify(detailEnvelope);
      expect(serializedDetail).toContain('"verification_state":"verified"');
      expect(serializedDetail).toContain('"owner":true');
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
                dimension_filter_groups: [{
                  groupType: 'and',
                  filters: [{ dimension: 'query', operator: 'contains', expression: 'private-topic-fixture' }],
                }],
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
      expect(serialized).toContain('\"dimensions\":[]');
      expect(serialized).toContain('\"search_type\":\"web\"');
      expect(serialized).toContain('\"site_url\":\"sc-domain:example.com\"');
      expect(serialized).toContain('\"start_date\":\"2026-08-22\"');
      expect(serialized).toContain('\"end_date\":\"2026-09-18\"');
      expect(serialized).toContain('\"filter_group_count\":1');
      expect(serialized).not.toContain('private-topic-fixture');
      expect(serialized).toContain('"provider_exhaustiveness_guaranteed":false');
      expect(serialized).toContain('Google Search Analytics does not guarantee all data rows');
      expect(serialized).toContain('do not prove provider-level exhaustiveness');
      expect(serialized).toContain('"generative_ai_report_isolatable":false');
      expect(serialized).toContain('dedicated Generative AI performance reports');
      expect(serialized).toContain('overall web Search performance data');
      expect(serialized).toContain('"multimodal_report_isolatable":false');
      expect(serialized).toContain('web multimodal performance filter');
      expect(serialized).toContain("search_type='multimodal'");
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
        dataState: 'all' | 'final' = 'all',
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
                  data_state: dataState,
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
      expect(querySerialized).toContain('\"dimensions\":[\"query\"]');
      expect(querySerialized).toContain('\"search_type\":\"web\"');
      expect(querySerialized).toContain('\"has_more\":true');
      expect(querySerialized).toContain('\"next_start_row\":1');
      expect(querySerialized).toContain('\"data_state\":\"all\"');
      expect(querySerialized).toContain('\"preliminary_data_possible\":true');
      expect(querySerialized).not.toContain('Output validation error');

      const pageResponse = await callAnalytics(['page'], 10, 'final');
      expect(pageResponse.status).toBe(200);
      const pageSerialized = JSON.stringify(await readMcpJsonRpc(pageResponse));
      expect(pageSerialized).toContain('https://example.com/gsc-mcp/');
      expect(pageSerialized).toContain('\"dimensions\":[\"page\"]');
      expect(pageSerialized).toContain('\"search_type\":\"web\"');
      expect(pageSerialized).toContain('\"has_more\":true');
      expect(pageSerialized).toContain('\"next_start_row\":11');
      expect(pageSerialized).toContain('\"data_state\":\"final\"');
      expect(pageSerialized).toContain('\"preliminary_data_possible\":false');
      expect(pageSerialized).not.toContain('Output validation error');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('marks analytics.query terminal after a short non-empty provider page', async () => {
    await saveUser(
      workerEnv,
      'short-page-user',
      'short-page@example.test',
      'short-page-refresh-token',
    );
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'short-page-access-token', expires_in: 3600 });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query'
        ) {
          const body = JSON.parse(String(init?.body)) as {
            startRow?: number;
            rowLimit: number;
          };
          expect(body.rowLimit).toBe(10);
          if ((body.startRow ?? 0) === 10) {
            return response({ rows: [] });
          }
          expect(body.startRow ?? 0).toBe(0);
          return response({
            rows: [
              {
                keys: ['short provider page'],
                clicks: 2,
                impressions: 20,
                ctr: 0.1,
                position: 5,
              },
            ],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const callAnalytics = async (startRow: number) =>
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
              id: 40 + startRow,
              method: 'tools/call',
              params: {
                name: 'analytics.query',
                arguments: {
                  site_url: 'sc-domain:example.com',
                  start_date: '2026-08-22',
                  end_date: '2026-09-18',
                  dimensions: ['query'],
                  row_limit: 10,
                  start_row: startRow,
                },
              },
            }),
          }),
          workerEnv,
          {
            props: {
              google_id: 'short-page-user',
              email: 'short-page@example.test',
            },
          } as unknown as ExecutionContext,
        );

      const first = JSON.stringify(await readMcpJsonRpc(await callAnalytics(0)));
      expect(first).toContain('short provider page');
      expect(first).toContain('\\"has_more\\":false');
      expect(first).not.toContain('\\"next_start_row\\"');
      expect(first).not.toContain('Output validation error');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('marks average position unavailable for Discover Search Analytics results', async () => {
    await saveUser(
      workerEnv,
      'discover-user',
      'discover@example.test',
      'discover-refresh-token',
    );
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'discover-access-token', expires_in: 3600 });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query'
        ) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(body.type).toBe('discover');
          return response({
            rows: [
              {
                keys: ['https://example.com/discover-story/'],
                clicks: 12,
                impressions: 340,
                ctr: 0.035,
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
            id: 29,
            method: 'tools/call',
            params: {
              name: 'analytics.query',
              arguments: {
                site_url: 'sc-domain:example.com',
                start_date: '2026-08-22',
                end_date: '2026-09-18',
                dimensions: ['page'],
                search_type: 'discover',
                row_limit: 10,
              },
            },
          }),
        }),
        workerEnv,
        {
          props: {
            google_id: 'discover-user',
            email: 'discover@example.test',
          },
        } as unknown as ExecutionContext,
      );

      expect(result.status).toBe(200);
      const serialized = JSON.stringify(await readMcpJsonRpc(result));
      expect(serialized).toContain('\"position_supported\":false');
      expect(serialized).toContain('Google Discover does not support average position');
      expect(serialized).not.toContain('Output validation error');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('marks average position unavailable for Google News Search Analytics results', async () => {
    await saveUser(
      workerEnv,
      'google-news-user',
      'google-news@example.test',
      'google-news-refresh-token',
    );
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'google-news-access-token', expires_in: 3600 });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query'
        ) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(body.type).toBe('googleNews');
          return response({
            rows: [
              {
                keys: ['https://example.com/google-news-story/'],
                clicks: 9,
                impressions: 210,
                ctr: 0.043,
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
            id: 30,
            method: 'tools/call',
            params: {
              name: 'analytics.query',
              arguments: {
                site_url: 'sc-domain:example.com',
                start_date: '2026-08-22',
                end_date: '2026-09-18',
                dimensions: ['page'],
                search_type: 'googleNews',
                row_limit: 10,
              },
            },
          }),
        }),
        workerEnv,
        {
          props: {
            google_id: 'google-news-user',
            email: 'google-news@example.test',
          },
        } as unknown as ExecutionContext,
      );

      expect(result.status).toBe(200);
      const serialized = JSON.stringify(await readMcpJsonRpc(result));
      expect(serialized).toContain('\"position_supported\":false');
      expect(serialized).toContain('Google News does not support average position');
      expect(serialized).not.toContain('Output validation error');
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
            startRow?: number;
          };
          if ((body.startRow ?? 0) > 0) {
            return response({ rows: [] });
          }
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
        end_date_a: '2026-09-23',
        start_date_b: '2026-08-01',
        end_date_b: '2026-08-31',
        dimension: 'page',
        search_type: 'web',
        limit: 100,
        start_row: 0,
      })) as {
        structuredContent: {
          result_page: { has_more: boolean; next_start_row?: number };
          comparison_note: string;
        };
      };
      expect(comparison.structuredContent.result_page.has_more).toBe(true);
      expect(comparison.structuredContent.result_page.next_start_row).toBeGreaterThan(0);
      expect(comparison.structuredContent.comparison_note).toContain('dimension=page');
      expect(comparison.structuredContent.comparison_note).toContain('search_type=web');
      expect(comparison.structuredContent.comparison_note).toContain('dimension_filter_groups=0');
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

      const topicCandidates = (await registered['insights.cannibalization'].handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-07-01',
        end_date: '2026-07-31',
        min_impressions: 1,
        min_page_percentage: 1,
        query_contains: 'QUERY-17-',
        limit: 100,
        start_row: 0,
      })) as {
        structuredContent: {
          candidates: Array<{ query: string; page_count: number }>;
          result_page: { has_more: boolean };
        };
      };
      expect(topicCandidates.structuredContent.candidates).toHaveLength(1);
      expect(topicCandidates.structuredContent.candidates[0].query).toMatch(/^query-17-/);
      expect(topicCandidates.structuredContent.candidates[0].page_count).toBe(2);
      expect(topicCandidates.structuredContent.result_page.has_more).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('scopes quick wins at Google before pagination while retaining the unfiltered default', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'quick-wins-locale-user', email: 'quick-wins-locale@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const rows = [
      { keys: ['seo basics', 'https://example.com/en/guide'], impressions: 900 },
      { keys: ['seo grundlagen', 'https://example.com/de/guide'], impressions: 150 },
      { keys: ['seo tipps', 'https://example.com/de/tips'], impressions: 75 },
    ].map((row) => ({ ...row, clicks: 10, ctr: 0.05, position: 12 }));
    let requests = 0;
    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          dimensions: string[];
          dimensionFilterGroups?: Array<{ filters: Array<{ dimension: string; operator: string; expression: string }> }>;
        };
        expect(body.dimensions).toEqual(['query', 'page']);
        requests += 1;
        const filter = body.dimensionFilterGroups?.[0]?.filters?.[0];
        if (requests === 1) {
          expect(filter).toEqual({ dimension: 'page', operator: 'contains', expression: '/de/' });
        } else {
          expect(filter).toBeUndefined();
        }
        return response({
          rows: filter
            ? rows.filter((row) => row.keys[1].toLowerCase().includes(filter.expression.toLowerCase()))
            : rows,
        });
      };

      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 100, min_position: 8, max_position: 20, limit: 20, start_row: 0,
      };
      const scoped = (await registered['insights.quick_wins'].handler({ ...args, page_contains: '/de/' })) as {
        structuredContent: { page_contains: string | null; scope_note: string; quick_wins: Array<{ page: string }> };
      };
      expect(scoped.structuredContent.page_contains).toBe('/de/');
      expect(scoped.structuredContent.scope_note).toMatch(/not property-wide/i);
      expect(scoped.structuredContent.quick_wins.map((row) => row.page)).toEqual(['https://example.com/de/guide']);

      const defaultResult = (await registered['insights.quick_wins'].handler(args)) as {
        structuredContent: { page_contains: string | null; quick_wins: Array<{ page: string }> };
      };
      expect(defaultResult.structuredContent.page_contains).toBeNull();
      expect(defaultResult.structuredContent.quick_wins).toHaveLength(2);
      expect(requests).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('filters quick-win query topics at Google with optional page scope', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'quick-wins-topic-user', email: 'quick-wins-topic@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const rows = [
      { keys: ['brand guide', 'https://example.com/de/brand'], impressions: 950 },
      { keys: ['technical seo', 'https://example.com/en/technical'], impressions: 850 },
      { keys: ['technical seo', 'https://example.com/de/technical'], impressions: 210 },
    ].map((row) => ({ ...row, clicks: 10, ctr: 0.05, position: 12 }));
    const requests: Array<Array<{ dimension: string; operator: string; expression: string }>> = [];
    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          dimensions: string[];
          dimensionFilterGroups?: Array<{ groupType: string; filters: Array<{
            dimension: string; operator: string; expression: string;
          }> }>;
        };
        expect(body.dimensions).toEqual(['query', 'page']);
        const filters = body.dimensionFilterGroups?.[0]?.filters ?? [];
        if (filters.length) expect(body.dimensionFilterGroups?.[0]?.groupType).toBe('and');
        requests.push(filters);
        return response({ rows: rows.filter((row) => filters.every((filter) =>
          row.keys[filter.dimension === 'query' ? 0 : 1]
            .toLowerCase().includes(filter.expression.toLowerCase())
        )) });
      };
      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 100, min_position: 8, max_position: 20, limit: 20, start_row: 0,
      };
      const scoped = (await registered['insights.quick_wins'].handler({
        ...args, page_contains: '/de/', query_contains: 'SEO',
      })) as { structuredContent: {
        query_contains: string | null; scope_note: string; quick_wins: Array<{ page: string }>;
      } };
      expect(requests[0]).toEqual([
        { dimension: 'page', operator: 'contains', expression: '/de/' },
        { dimension: 'query', operator: 'contains', expression: 'SEO' },
      ]);
      expect(scoped.structuredContent.query_contains).toBe('SEO');
      expect(scoped.structuredContent.scope_note).toMatch(/not property-wide/i);
      expect(scoped.structuredContent.quick_wins.map((row) => row.page))
        .toEqual(['https://example.com/de/technical']);
      const topicOnly = (await registered['insights.quick_wins'].handler({
        ...args, query_contains: 'seo',
      })) as { structuredContent: { quick_wins: Array<{ page: string }> } };
      expect(requests[1]).toEqual([{ dimension: 'query', operator: 'contains', expression: 'seo' }]);
      expect(topicOnly.structuredContent.quick_wins).toHaveLength(2);
      const all = (await registered['insights.quick_wins'].handler(args)) as {
        structuredContent: { query_contains: string | null; quick_wins: Array<{ page: string }> };
      };
      expect(requests[2]).toEqual([]);
      expect(all.structuredContent.query_contains).toBeNull();
      expect(all.structuredContent.quick_wins).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('scopes quick wins to searcher country alongside page and query before pagination', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'quick-wins-country-user', email: 'quick-wins-country@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const rows = [
      { country: 'DEU', keys: ['technical seo', 'https://example.com/de/guide'], impressions: 210 },
      { country: 'USA', keys: ['technical seo', 'https://example.com/de/other'], impressions: 320 },
    ].map((row) => ({ ...row, clicks: 10, ctr: 0.05, position: 12 }));
    const requests: Array<Array<{ dimension: string; operator: string; expression: string }>> = [];
    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          dimensions: string[];
          dimensionFilterGroups?: Array<{ groupType: string; filters: Array<{
            dimension: string; operator: string; expression: string;
          }> }>;
        };
        expect(body.dimensions).toEqual(['query', 'page']);
        const filters = body.dimensionFilterGroups?.[0]?.filters ?? [];
        if (filters.length) expect(body.dimensionFilterGroups?.[0]?.groupType).toBe('and');
        requests.push(filters);
        return response({ rows: rows.filter((row) => filters.every((filter) => {
          const value = filter.dimension === 'country'
            ? row.country : row.keys[filter.dimension === 'query' ? 0 : 1];
          return filter.operator === 'equals'
            ? value.toUpperCase() === filter.expression.toUpperCase()
            : value.toLowerCase().includes(filter.expression.toLowerCase());
        })) });
      };
      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 100, min_position: 8, max_position: 20, limit: 20, start_row: 0,
      };
      const scoped = (await registered['insights.quick_wins'].handler({
        ...args, page_contains: '/de/', query_contains: 'SEO', country: 'deu',
      })) as { structuredContent: {
        country: string | null; scope_note: string; quick_wins: Array<{ page: string }>;
      } };
      expect(requests[0]).toEqual([
        { dimension: 'page', operator: 'contains', expression: '/de/' },
        { dimension: 'query', operator: 'contains', expression: 'SEO' },
        { dimension: 'country', operator: 'equals', expression: 'DEU' },
      ]);
      expect(scoped.structuredContent.country).toBe('DEU');
      expect(scoped.structuredContent.scope_note).toMatch(/searcher country.*not property-wide/i);
      expect(scoped.structuredContent.quick_wins.map((row) => row.page))
        .toEqual(['https://example.com/de/guide']);
      const unfiltered = (await registered['insights.quick_wins'].handler(args)) as {
        structuredContent: { country: string | null; quick_wins: unknown[] };
      };
      expect(requests[1]).toEqual([]);
      expect(unfiltered.structuredContent.country).toBeNull();
      expect(unfiltered.structuredContent.quick_wins).toHaveLength(2);
      expect(requests).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('scopes mobile quick wins before pagination without changing the unfiltered request', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'quick-wins-device-user', email: 'quick-wins-device@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const rows = [
      { device: 'MOBILE', keys: ['seo audit', 'https://example.com/de/audit'], impressions: 210 },
      { device: 'DESKTOP', keys: ['seo audit', 'https://example.com/de/desktop'], impressions: 320 },
    ].map((row) => ({ ...row, clicks: 10, ctr: 0.05, position: 12 }));
    const requests: Array<Array<{ dimension: string; operator: string; expression: string }>> = [];
    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          dimensionFilterGroups?: Array<{ groupType: string; filters: Array<{
            dimension: string; operator: string; expression: string;
          }> }>;
        };
        const filters = body.dimensionFilterGroups?.[0]?.filters ?? [];
        if (filters.length) expect(body.dimensionFilterGroups?.[0]?.groupType).toBe('and');
        requests.push(filters);
        return response({ rows: rows.filter((row) => filters.every((filter) => {
          const value = filter.dimension === 'device' ? row.device
            : row.keys[filter.dimension === 'query' ? 0 : 1];
          return filter.operator === 'equals'
            ? value.toUpperCase() === filter.expression.toUpperCase()
            : value.toLowerCase().includes(filter.expression.toLowerCase());
        })) });
      };
      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 100, min_position: 8, max_position: 20, limit: 20, start_row: 0,
      };
      const mobile = (await registered['insights.quick_wins'].handler({
        ...args, device: 'mobile', page_contains: '/de/', query_contains: 'seo',
      })) as { structuredContent: {
        device: string | null; scope_note: string; quick_wins: Array<{ page: string }>;
      } };
      expect(requests[0]).toEqual([
        { dimension: 'page', operator: 'contains', expression: '/de/' },
        { dimension: 'query', operator: 'contains', expression: 'seo' },
        { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
      ]);
      expect(mobile.structuredContent.device).toBe('mobile');
      expect(mobile.structuredContent.scope_note).toMatch(/device.*not property-wide/i);
      expect(mobile.structuredContent.quick_wins.map((row) => row.page))
        .toEqual(['https://example.com/de/audit']);
      const all = (await registered['insights.quick_wins'].handler(args)) as {
        structuredContent: { device: string | null; quick_wins: unknown[] };
      };
      expect(requests[1]).toEqual([]);
      expect(all.structuredContent.device).toBeNull();
      expect(all.structuredContent.quick_wins).toHaveLength(2);
      expect(requests).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('finds image/video/news quick wins on the selected Search surface while preserving Web default', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'quick-wins-surface-user', email: 'quick-wins-surface@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<{ type?: string; filters: Array<{ dimension: string; expression: string }> }> = [];
    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          type?: string;
          dimensionFilterGroups?: Array<{ filters: Array<{ dimension: string; expression: string }> }>;
        };
        requests.push({ type: body.type, filters: body.dimensionFilterGroups?.[0]?.filters ?? [] });
        return response({ rows: [{
          keys: [body.type === 'image' ? 'image seo' : 'search seo', 'https://example.com/de/guide'],
          clicks: 10, impressions: 150, ctr: 10 / 150, position: 12,
        }] });
      };
      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 100, min_position: 8, max_position: 20, limit: 20, start_row: 0,
      };
      const image = (await registered['insights.quick_wins'].handler({
        ...args, search_type: 'image', page_contains: '/de/', device: 'mobile',
      })) as { structuredContent: { search_type: string; note: string; quick_wins: Array<{ query: string }> } };
      expect(requests[0]).toEqual({ type: 'image', filters: [
        { dimension: 'page', operator: 'contains', expression: '/de/' },
        { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
      ] });
      expect(image.structuredContent.search_type).toBe('image');
      expect(image.structuredContent.quick_wins[0]?.query).toBe('image seo');
      expect(image.structuredContent.note).toMatch(/selected search surface/i);
      const video = (await registered['insights.quick_wins'].handler({ ...args, search_type: 'video' })) as {
        structuredContent: { search_type: string };
      };
      const news = (await registered['insights.quick_wins'].handler({ ...args, search_type: 'news' })) as {
        structuredContent: { search_type: string };
      };
      const web = (await registered['insights.quick_wins'].handler(args)) as {
        structuredContent: { search_type: string };
      };
      expect(requests.slice(1).map((entry) => entry.type ?? 'web')).toEqual(['video', 'news', 'web']);
      expect([video.structuredContent.search_type, news.structuredContent.search_type, web.structuredContent.search_type])
        .toEqual(['video', 'news', 'web']);
      expect(requests).toHaveLength(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('scopes cannibalization to one locale before aggregating candidate page shares', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'cannibal-locale-user', email: 'cannibal-locale@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    let requests = 0;
    const rows = [
      { keys: ['pricing', 'https://example.com/de/pricing'], impressions: 400 },
      { keys: ['pricing', 'https://example.com/de/preise'], impressions: 200 },
      { keys: ['pricing', 'https://example.com/en/pricing'], impressions: 700 },
      { keys: ['support', 'https://example.com/de/support'], impressions: 200 },
      { keys: ['support', 'https://example.com/en/support'], impressions: 250 },
    ].map((row) => ({ ...row, clicks: 10, ctr: 0.05, position: 12 }));
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(requestUrl(input)).toBe(
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query',
        );
        const body = JSON.parse(String(init?.body)) as {
          dimensions: string[];
          dimensionFilterGroups?: Array<{ filters: Array<{ dimension: string; operator: string; expression: string }> }>;
        };
        expect(body.dimensions).toEqual(['query', 'page']);
        requests += 1;
        const filter = body.dimensionFilterGroups?.[0]?.filters?.[0];
        if (requests === 1) {
          expect(filter).toEqual({ dimension: 'page', operator: 'contains', expression: '/de/' });
        } else {
          expect(filter).toBeUndefined();
        }
        return response({
          rows: filter
            ? rows.filter((row) => row.keys[1].toLowerCase().includes(filter.expression.toLowerCase()))
            : rows,
        });
      };

      const filtered = (await registered['insights.cannibalization'].handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-07-01',
        end_date: '2026-07-31',
        min_impressions: 1,
        min_page_percentage: 1,
        page_contains: '/de/',
        limit: 20,
        start_row: 0,
      })) as {
        structuredContent: {
          page_contains: string | null;
          scope_note: string;
          candidates: Array<{ query: string; total_impressions: number; page_count: number; pages: Array<{ page: string; impression_share: number }> }>;
        };
      };
      expect(filtered.structuredContent.page_contains).toBe('/de/');
      expect(filtered.structuredContent.scope_note).toMatch(/not property-wide/i);
      expect(filtered.structuredContent.candidates).toHaveLength(1);
      expect(filtered.structuredContent.candidates[0]).toMatchObject({
        query: 'pricing', total_impressions: 600, page_count: 2,
      });
      expect(filtered.structuredContent.candidates[0].pages.map((page) => page.impression_share)).toEqual([66.7, 33.3]);

      const unfiltered = (await registered['insights.cannibalization'].handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-07-01',
        end_date: '2026-07-31',
        min_impressions: 1,
        min_page_percentage: 1,
        limit: 20,
        start_row: 0,
      })) as { structuredContent: { page_contains: string | null; candidates: Array<{ query: string }> } };
      expect(unfiltered.structuredContent.page_contains).toBeNull();
      expect(unfiltered.structuredContent.candidates.map((candidate) => candidate.query)).toEqual(['pricing', 'support']);
      expect(requests).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('filters cannibalization query topics at Google before pagination and combines URL scope', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'cannibal-topic-user', email: 'cannibal-topic@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<{
      groupType?: string;
      filters: Array<{ dimension: string; operator: string; expression: string }>;
    } | undefined> = [];
    const rows = [
      { keys: ['pricing calculator', 'https://example.com/de/pricing'], impressions: 400 },
      { keys: ['pricing calculator', 'https://example.com/de/preise'], impressions: 200 },
      { keys: ['pricing calculator', 'https://example.com/en/pricing'], impressions: 700 },
      { keys: ['support options', 'https://example.com/de/support'], impressions: 250 },
      { keys: ['support options', 'https://example.com/en/support'], impressions: 200 },
    ].map((row) => ({ ...row, clicks: 10, ctr: 0.05, position: 12 }));
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(requestUrl(input)).toBe(
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query',
        );
        const body = JSON.parse(String(init?.body)) as {
          dimensions: string[];
          dimensionFilterGroups?: typeof requests;
        };
        expect(body.dimensions).toEqual(['query', 'page']);
        const group = body.dimensionFilterGroups?.[0];
        requests.push(group);
        const filteredRows = rows.filter((row) => (group?.filters ?? []).every((filter) => {
          const value = row.keys[filter.dimension === 'query' ? 0 : 1];
          return filter.operator === 'contains' && value.toLowerCase().includes(filter.expression.toLowerCase());
        }));
        return response({ rows: filteredRows });
      };

      const args = {
        site_url: 'sc-domain:example.com',
        start_date: '2026-07-01',
        end_date: '2026-07-31',
        min_impressions: 1,
        min_page_percentage: 1,
        limit: 20,
        start_row: 0,
      };
      const scoped = (await registered['insights.cannibalization'].handler({
        ...args, page_contains: '/de/', query_contains: 'PRICING',
      })) as { structuredContent: { candidates: Array<{ query: string; page_count: number; total_impressions: number }> } };
      expect(requests[0]).toEqual({
        groupType: 'and',
        filters: [
          { dimension: 'page', operator: 'contains', expression: '/de/' },
          { dimension: 'query', operator: 'contains', expression: 'PRICING' },
        ],
      });
      expect(scoped.structuredContent.candidates).toMatchObject([
        { query: 'pricing calculator', page_count: 2, total_impressions: 600 },
      ]);

      const queryOnly = (await registered['insights.cannibalization'].handler({
        ...args, query_contains: 'PRICING',
      })) as { structuredContent: { candidates: Array<{ query: string; page_count: number }> } };
      expect(requests[1]).toEqual({
        groupType: 'and',
        filters: [{ dimension: 'query', operator: 'contains', expression: 'PRICING' }],
      });
      expect(queryOnly.structuredContent.candidates[0]).toMatchObject({
        query: 'pricing calculator', page_count: 3,
      });

      const defaultResult = (await registered['insights.cannibalization'].handler(args)) as {
        structuredContent: { candidates: Array<{ query: string }> };
      };
      expect(requests[2]).toBeUndefined();
      expect(defaultResult.structuredContent.candidates).toHaveLength(2);
      expect(requests).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('filters cannibalization by searcher country alongside locale and query before pagination', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'cannibal-country-user', email: 'cannibal-country@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<{ groupType: string; filters: Array<{ dimension: string; operator: string; expression: string }> } | undefined> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(requestUrl(input)).toBe(
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query',
        );
        const body = JSON.parse(String(init?.body)) as {
          dimensions: string[];
          dimensionFilterGroups?: typeof requests;
        };
        expect(body.dimensions).toEqual(['query', 'page']);
        requests.push(body.dimensionFilterGroups?.[0]);
        return response({ rows: [
          { keys: ['pricing', 'https://example.com/de/pricing'], impressions: 250, clicks: 15, ctr: 0.06, position: 11 },
          { keys: ['pricing', 'https://example.com/de/preise'], impressions: 150, clicks: 10, ctr: 0.067, position: 12 },
        ] });
      };
      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 1, min_page_percentage: 1, limit: 20, start_row: 0,
      };
      const scoped = (await registered['insights.cannibalization'].handler({
        // Direct handler invocation bypasses MCP's Zod trim; test normalized input separately.
        ...args, page_contains: '/de/', query_contains: 'pricing', country: 'deu',
      })) as { structuredContent: { country: string | null; scope_note: string; candidates: Array<{ page_count: number }> } };
      expect(requests[0]).toEqual({
        groupType: 'and',
        filters: [
          { dimension: 'page', operator: 'contains', expression: '/de/' },
          { dimension: 'query', operator: 'contains', expression: 'pricing' },
          { dimension: 'country', operator: 'equals', expression: 'DEU' },
        ],
      });
      expect(scoped.structuredContent.country).toBe('DEU');
      expect(scoped.structuredContent.scope_note).toMatch(/searcher country/i);
      expect(scoped.structuredContent.scope_note).toMatch(/not property-wide/i);
      expect(scoped.structuredContent.candidates[0].page_count).toBe(2);

      const unfiltered = (await registered['insights.cannibalization'].handler(args)) as {
        structuredContent: { country: string | null };
      };
      expect(requests[1]).toBeUndefined();
      expect(unfiltered.structuredContent.country).toBeNull();
      expect(requests).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves device scope when investigating query/page overlap', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'cannibal-device-user', email: 'cannibal-device@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<Array<{ dimension: string; operator: string; expression: string }> | undefined> = [];
    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          dimensionFilterGroups?: Array<{ groupType: string; filters: Array<{ dimension: string; operator: string; expression: string }> }>;
        };
        if (body.dimensionFilterGroups?.length) expect(body.dimensionFilterGroups[0].groupType).toBe('and');
        requests.push(body.dimensionFilterGroups?.[0]?.filters);
        return response({ rows: [
          { keys: ['pricing', 'https://example.com/de/pricing'], impressions: 250, clicks: 15, ctr: 0.06, position: 11 },
          { keys: ['pricing', 'https://example.com/de/preise'], impressions: 150, clicks: 10, ctr: 0.067, position: 12 },
        ] });
      };
      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 1, min_page_percentage: 1, limit: 20, start_row: 0,
      };
      const scoped = (await registered['insights.cannibalization'].handler({
        ...args, page_contains: '/de/', query_contains: 'pricing', country: 'deu', device: 'mobile',
      })) as { structuredContent: { device: string | null; scope_note: string; candidates: Array<{ page_count: number }> } };
      expect(requests[0]).toEqual([
        { dimension: 'page', operator: 'contains', expression: '/de/' },
        { dimension: 'query', operator: 'contains', expression: 'pricing' },
        { dimension: 'country', operator: 'equals', expression: 'DEU' },
        { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
      ]);
      expect(scoped.structuredContent.device).toBe('mobile');
      expect(scoped.structuredContent.scope_note).toMatch(/device/i);
      expect(scoped.structuredContent.scope_note).toMatch(/not property-wide/i);
      expect(scoped.structuredContent.candidates[0].page_count).toBe(2);
      const allDevices = (await registered['insights.cannibalization'].handler(args)) as { structuredContent: { device: string | null } };
      expect(requests[1]).toBeUndefined();
      expect(allDevices.structuredContent.device).toBeNull();
      expect(requests).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps Image/Video/News-tab cannibalization on its selected search surface', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'cannibal-surface-user', email: 'cannibal-surface@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return response({ rows: [
          { keys: ['visual seo', 'https://example.com/de/visual'], impressions: 230, clicks: 12, ctr: 0.052, position: 11 },
          { keys: ['visual seo', 'https://example.com/de/gallery'], impressions: 130, clicks: 6, ctr: 0.046, position: 13 },
        ] });
      };
      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 1, min_page_percentage: 1, limit: 20, start_row: 0,
      };
      const image = (await registered['insights.cannibalization'].handler({
        ...args, search_type: 'image', page_contains: '/de/', query_contains: 'visual', country: 'deu', device: 'mobile',
      })) as { structuredContent: { search_type: string; scope_note: string; candidates: Array<{ page_count: number }> } };
      expect(requests[0].type).toBe('image');
      expect(requests[0].dimensions).toEqual(['query', 'page']);
      expect(requests[0].dimensionFilterGroups).toEqual([{
        groupType: 'and', filters: [
          { dimension: 'page', operator: 'contains', expression: '/de/' },
          { dimension: 'query', operator: 'contains', expression: 'visual' },
          { dimension: 'country', operator: 'equals', expression: 'DEU' },
          { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
        ],
      }]);
      expect(image.structuredContent.search_type).toBe('image');
      expect(image.structuredContent.scope_note).toMatch(/Image.*not.*all-search|Image.*not property-wide/i);
      expect(image.structuredContent.candidates[0].page_count).toBe(2);

      for (const search_type of ['video', 'news']) {
        const scoped = (await registered['insights.cannibalization'].handler({
          ...args, search_type,
        })) as { structuredContent: { search_type: string; candidates: Array<{ page_count: number }> } };
        expect(requests[requests.length - 1].type).toBe(search_type);
        expect(scoped.structuredContent.search_type).toBe(search_type);
        expect(scoped.structuredContent.candidates[0].page_count).toBe(2);
      }

      const web = (await registered['insights.cannibalization'].handler(args)) as { structuredContent: { search_type: string } };
      expect(requests[3].type).toBeUndefined();
      expect(web.structuredContent.search_type).toBe('web');
      expect(requests).toHaveLength(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('focuses content decay on one locale without treating other pages as missing data', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'decay-locale-user', email: 'decay-locale@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    let searchRequests = 0;
    let expectedSearchType = 'image';
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url !== 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          throw new Error(`Unexpected outbound request: ${url}`);
        }
        const body = JSON.parse(String(init?.body)) as {
          dimensions: string[];
          type?: string;
          dimensionFilterGroups?: Array<{
            groupType: string;
            filters: Array<{ dimension: string; operator: string; expression: string }>;
          }>;
        };
        expect(body.dimensions).toEqual(['page']);
        expect(body.type).toBe(expectedSearchType);
        if (expectedSearchType === 'image') {
          expect(body.dimensionFilterGroups).toEqual([{
            groupType: 'and',
            filters: [
              { dimension: 'page', operator: 'contains', expression: '/DE/' },
              { dimension: 'query', operator: 'contains', expression: 'TECHNICAL SEO' },
              { dimension: 'country', operator: 'equals', expression: 'DEU' },
              { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
            ],
          }]);
        } else if (expectedSearchType === 'news') {
          expect(body.dimensionFilterGroups).toEqual([{
            groupType: 'and',
            filters: [{ dimension: 'query', operator: 'contains', expression: 'seo' }],
          }]);
        } else {
          expect(body.dimensionFilterGroups).toBeUndefined();
        }
        searchRequests += 1;
        const recent = searchRequests % 2 === 1;
        return response({
          rows: (expectedSearchType === 'image'
            ? ['/de/pricing']
            : ['/de/pricing', '/en/pricing']).map((path) => ({
            keys: [`https://example.com${path}`],
            clicks: recent ? 12 : 100,
            impressions: recent ? 400 : 1000,
            ctr: recent ? 0.03 : 0.1,
            position: recent ? 12 : 4,
          })),
        });
      };

      const result = (await registered['insights.content_decay'].handler({
        site_url: 'sc-domain:example.com',
        compare_days: 14,
        search_type: 'image',
        page_contains: '/DE/',
        query_contains: 'TECHNICAL SEO',
        country: 'deu',
        device: 'mobile',
        limit: 20,
        start_row: 0,
      })) as {
        structuredContent: {
          search_type: string;
          page_contains: string | null;
          query_contains: string | null;
          country: string | null;
          device: string | null;
          scope_note: string;
          decay_results: Array<{ page: string; previous_clicks: number; recent_clicks: number }>;
          assessment_count: number;
          result_page: { total_count: number; has_more: boolean };
        };
      };

      expect(result.structuredContent.decay_results).toHaveLength(1);
      expect(result.structuredContent.search_type).toBe('image');
      expect(result.structuredContent.page_contains).toBe('/DE/');
      expect(result.structuredContent.query_contains).toBe('TECHNICAL SEO');
      expect(result.structuredContent.country).toBe('DEU');
      expect(result.structuredContent.device).toBe('mobile');
      expect(result.structuredContent.scope_note).toContain('not property-wide totals');
      expect(result.structuredContent.scope_note).toMatch(/searcher country/i);
      expect(result.structuredContent.scope_note).toMatch(/device/i);
      expect(result.structuredContent.decay_results[0]).toMatchObject({
        page: 'https://example.com/de/pricing',
        previous_clicks: 100,
        recent_clicks: 12,
      });
      expect(result.structuredContent.assessment_count).toBe(1);
      expect(result.structuredContent.result_page.has_more).toBe(false);
      expect(searchRequests).toBe(2);

      expectedSearchType = 'web';
      const defaultResult = (await registered['insights.content_decay'].handler({
        site_url: 'sc-domain:example.com',
        compare_days: 14,
        limit: 20,
        start_row: 0,
      })) as { structuredContent: { search_type: string; page_contains: string | null; query_contains: string | null; country: string | null; device: string | null; decay_results: unknown[] } };
      expect(defaultResult.structuredContent.search_type).toBe('web');
      expect(defaultResult.structuredContent.page_contains).toBeNull();
      expect(defaultResult.structuredContent.query_contains).toBeNull();
      expect(defaultResult.structuredContent.country).toBeNull();
      expect(defaultResult.structuredContent.device).toBeNull();
      expect(defaultResult.structuredContent.decay_results).toHaveLength(2);
      expect(searchRequests).toBe(4);

      expectedSearchType = 'news';
      const queryOnlyResult = (await registered['insights.content_decay'].handler({
        site_url: 'sc-domain:example.com', compare_days: 14, search_type: 'news', query_contains: 'seo',
      })) as { structuredContent: { query_contains: string; page_contains: string | null; scope_note: string } };
      expect(queryOnlyResult.structuredContent.query_contains).toBe('seo');
      expect(queryOnlyResult.structuredContent.page_contains).toBeNull();
      expect(queryOnlyResult.structuredContent.scope_note).toContain('not property-wide totals');
      expect(searchRequests).toBe(6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('anchors content decay to a historical finalized end date and rejects unavailable periods', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'historical-decay-user', email: 'historical-decay@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const today = getSearchConsoleCalendarDate();
    const daysAgo = (days: number) => {
      const date = new Date(`${today}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() - days);
      return date.toISOString().slice(0, 10);
    };
    const sourceRequests: Array<{ startDate: string; endDate: string }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(requestUrl(input)).toBe('https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query');
        const body = JSON.parse(String(init?.body)) as { startDate: string; endDate: string };
        sourceRequests.push({ startDate: body.startDate, endDate: body.endDate });
        return response({ rows: [{
          keys: ['https://example.com/de/guide'],
          clicks: 12, impressions: 500, ctr: 0.024, position: 12,
        }] });
      };
      const result = (await registered['insights.content_decay'].handler({
        site_url: 'sc-domain:example.com', compare_days: 7, end_date: daysAgo(35),
      })) as { structuredContent: {
        comparison_periods: { recent: { start: string; end: string }; previous: { start: string; end: string } };
      } };
      expect(result.structuredContent.comparison_periods).toEqual({
        recent: { start: daysAgo(41), end: daysAgo(35) },
        previous: { start: daysAgo(48), end: daysAgo(42) },
      });
      expect(sourceRequests).toEqual([
        { startDate: daysAgo(41), endDate: daysAgo(35) },
        { startDate: daysAgo(48), endDate: daysAgo(42) },
      ]);
      await expect(registered['insights.content_decay'].handler({
        site_url: 'sc-domain:example.com', compare_days: 7, end_date: today,
      })).rejects.toThrow(/finalized/i);
      await expect(registered['insights.content_decay'].handler({
        site_url: 'sc-domain:example.com', compare_days: 7, end_date: '2020-01-01',
      })).rejects.toThrow(/16.month/i);
      expect(sourceRequests).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('marks indexing.list_pages terminal after a short non-empty Search Analytics page', async () => {
    await saveUser(
      workerEnv,
      'short-list-user',
      'short-list@example.test',
      'short-list-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'short-list-user',
        email: 'short-list@example.test',
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
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'short-list-access-token', expires_in: 3600 });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query'
        ) {
          const body = JSON.parse(String(init?.body)) as {
            startRow?: number;
            rowLimit: number;
          };
          expect(body.rowLimit).toBe(500);
          if ((body.startRow ?? 0) === 500) {
            return response({ rows: [] });
          }
          expect(body.startRow ?? 0).toBe(0);
          return response({
            rows: [
              {
                keys: ['https://example.com/short-provider-page/'],
                clicks: 3,
                impressions: 30,
                ctr: 0.1,
                position: 7,
              },
            ],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const first = (await registered['indexing.list_pages'].handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        row_limit: 1000,
        start_row: 0,
      })) as {
        structuredContent: {
          pages: Array<{ page: string }>;
          result_page: { has_more: boolean; next_start_row?: number };
        };
      };
      expect(first.structuredContent.pages[0]?.page).toBe(
        'https://example.com/short-provider-page/',
      );
      expect(first.structuredContent.result_page).toMatchObject({
        has_more: false,
      });
      expect(first.structuredContent.result_page.next_start_row).toBeUndefined();
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
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          analyticsRequests.push(body);
          if ((body.startRow as number | undefined ?? 0) > 0) {
            return response({ rows: [] });
          }
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

      const result = (await tools['analytics.compare'].handler({
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-09-01',
        end_date_a: '2026-09-07',
        start_date_b: '2026-08-25',
        end_date_b: '2026-08-31',
        dimension: 'query',
        search_type: 'image',
        data_state: 'final',
        dimension_filter_groups: filters,
      })) as {
        structuredContent: {
          data_state: string;
          preliminary_data_possible: boolean;
          comparison_note: string;
        };
      };

      expect(analyticsRequests).toHaveLength(2);
      expect(analyticsRequests.map((request) => request.startRow ?? 0)).toEqual([
        0,
        0,
      ]);
      expect(analyticsRequests.map((request) => request.type)).toEqual([
        'image',
        'image',
      ]);
      expect(analyticsRequests.map((request) => request.dataState)).toEqual([
        'final',
        'final',
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
      expect(result.structuredContent).toMatchObject({
        data_state: 'final',
        preliminary_data_possible: false,
      });
      const scopeNote = result.structuredContent.comparison_note;
      expect(scopeNote).toContain('dimension=query');
      expect(scopeNote).toContain('search_type=image');
      expect(scopeNote).toContain('period_a=2026-09-01..2026-09-07');
      expect(scopeNote).toContain('period_b=2026-08-25..2026-08-31');
      expect(scopeNote).toContain('dimension_filter_groups=1');
      expect(scopeNote).not.toContain('example|brand');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not reuse a Google access token across distinct Worker environments', async () => {
    const makeEnvironment = () => {
      const users = new Map<string, string>();
      return {
        GSC_ACCESS_MODE: 'readonly',
        GOOGLE_CLIENT_ID: 'test-client',
        GOOGLE_CLIENT_SECRET: 'test-secret',
        TOKEN_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
        USER_KV: {
          get: async (key: string) => users.get(key) ?? null,
          put: async (key: string, value: string) => { users.set(key, value); },
        },
        TOOL_RATE_LIMITER: {
          idFromName: (name: string) => name,
          get: () => ({ take: async () => ({ allowed: true }) }),
        },
      } as unknown as Env;
    };
    const firstEnv = makeEnvironment();
    const secondEnv = makeEnvironment();
    const googleId = 'same-account-in-two-environments';
    await saveUser(firstEnv, googleId, 'user@example.test', 'refresh-first-env');
    await saveUser(secondEnv, googleId, 'user@example.test', 'refresh-second-env');
    const props = { google_id: googleId, email: 'user@example.test' };
    const firstServer = await createGscMcpServer(firstEnv, props);
    const secondServer = await createGscMcpServer(secondEnv, props);
    const handler = (server: Awaited<ReturnType<typeof createGscMcpServer>>) =>
      (server as unknown as {
        _registeredTools: Record<string, {
          handler: (args: Record<string, never>) => Promise<unknown>;
        }>;
      })._registeredTools['sites.list'].handler;

    const originalFetch = globalThis.fetch;
    const observedAuth: string[] = [];
    const observedRefreshGrants: string[] = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          const refresh = new URLSearchParams(String(init?.body)).get('refresh_token');
          observedRefreshGrants.push(refresh ?? '');
          return response({ access_token: `access:${refresh}`, expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites') {
          observedAuth.push(new Headers(init?.headers).get('authorization') ?? '');
          return response({ siteEntry: [] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      await handler(firstServer)({});
      await handler(secondServer)({});
      const repeatedFirstServer = await createGscMcpServer(firstEnv, props);
      await handler(repeatedFirstServer)({});
      expect(observedAuth).toEqual([
        'Bearer access:refresh-first-env',
        'Bearer access:refresh-second-env',
        'Bearer access:refresh-first-env',
      ]);
      expect(observedRefreshGrants).toEqual([
        'refresh-first-env',
        'refresh-second-env',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses the normal tool token cache and preserves stored credentials on invalid_grant', async () => {
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
        GSC_ACCESS_REVOKED_MESSAGE,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(await getUser(workerEnv, 'revoked-user')).not.toBeNull();
    expect(await getUser(workerEnv, 'cached-user')).not.toBeNull();
  });

  it('does not erase a newer Google grant when an older refresh fails late', async () => {
    await saveUser(workerEnv, 'reconnected-user', 'user@example.test', 'old-refresh');
    const lifecycle = new GoogleAccessTokenLifecycle(workerEnv);
    const originalFetch = globalThis.fetch;
    let resolveOldRefresh!: (value: Response) => void;
    let oldRefreshStarted!: () => void;
    const oldRefreshReachedGoogle = new Promise<void>((resolve) => {
      oldRefreshStarted = resolve;
    });

    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (requestUrl(input) !== GOOGLE_TOKEN_URL) {
          throw new Error(`Unexpected outbound request: ${requestUrl(input)}`);
        }
        const body = String(init?.body ?? '');
        if (body.includes('old-refresh')) {
          oldRefreshStarted();
          return new Promise<Response>((resolve) => {
            resolveOldRefresh = resolve;
          });
        }
        expect(body).toContain('new-refresh');
        return response({ access_token: 'new-access', expires_in: 3600 });
      };

      const staleRefresh = lifecycle.getAccessToken('reconnected-user');
      await oldRefreshReachedGoogle;
      await saveUser(workerEnv, 'reconnected-user', 'user@example.test', 'new-refresh');
      resolveOldRefresh(response({ error: 'invalid_grant' }, 400));
      await expect(staleRefresh).rejects.toThrow(GSC_ACCESS_REVOKED_MESSAGE);

      expect(await getDecryptedRefreshToken(workerEnv, 'reconnected-user')).toBe('new-refresh');
      await expect(lifecycle.getAccessToken('reconnected-user')).resolves.toBe('new-access');
    } finally {
      globalThis.fetch = originalFetch;
    }
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

      analyticsRequests.length = 0;
      const imageMarkdown = await generateWeeklyDigest(
        new GoogleAccessTokenLifecycle(workerEnv),
        'digest-user',
        'https://example.com/',
        '2026-01-14',
        undefined,
        '2026-01-17',
        undefined,
        'image',
      );
      expect(analyticsRequests).toHaveLength(5);
      expect(analyticsRequests.every((request) => request.type === 'image')).toBe(true);
      expect(imageMarkdown).toContain('**Search type:** Image search');
      expect(imageMarkdown).toContain('Review this search surface before changing content');
      expect(imageMarkdown).not.toContain('Change the title or meta description');

      analyticsRequests.length = 0;
      const desktopMarkdown = await generateWeeklyDigest(
        new GoogleAccessTokenLifecycle(workerEnv),
        'digest-user',
        'https://example.com/',
        '2026-01-14',
        undefined,
        '2026-01-17',
        undefined,
        'web',
        'desktop',
      );
      expect(analyticsRequests).toHaveLength(5);
      expect(analyticsRequests.every((request) => JSON.stringify(request.dimensionFilterGroups) === JSON.stringify([{
        groupType: 'and',
        filters: [{ dimension: 'device', operator: 'equals', expression: 'DESKTOP' }],
      }]))).toBe(true);
      expect(desktopMarkdown).toContain('**Device filter:** Desktop');
      expect(desktopMarkdown).toContain('## Quick numbers');
      expect(desktopMarkdown).not.toContain('**Search type:**');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('withholds a weekly traffic comparison when Google returns no aggregate row', async () => {
    await saveUser(workerEnv, 'digest-no-rows', 'digest-no-rows@example.test', 'digest-no-rows-refresh');
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'digest-no-rows-access', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as { startDate: string; dimensions: string[] };
          if (body.dimensions.length === 0 && body.startDate === '2026-01-01') {
            return response({ rows: [{ keys: [], clicks: 30, impressions: 300, ctr: 0.1, position: 10 }] });
          }
          return response({ rows: [] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const markdown = await generateWeeklyDigest(
        new GoogleAccessTokenLifecycle(workerEnv),
        'digest-no-rows',
        'https://example.com/',
        '2026-01-14',
      );
      expect(markdown).toContain('## Data availability');
      expect(markdown).toContain('2026-01-08 to 2026-01-14');
      expect(markdown).toContain('withheld rather than treating absent rows');
      expect(markdown).toContain('Search Analytics alone does not tell us whether Google crawled or indexed');
      expect(markdown).toContain("use this server's `urls.inspect` tool");
      expect(markdown).not.toContain('## Quick numbers');
      expect(markdown).not.toContain('No Google Search impressions were recorded this week');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it('reserves five shared Search Analytics units before running a weekly digest', async () => {
    const take = vi.fn(async (_bucket: string, policy: { category: string }, _units: number) => ({
      allowed: policy.category !== 'search-analytics',
      retry_after_ms: 20_000,
    }));
    const limiter = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ take })),
    };
    const getAccessToken = vi.fn(async () => {
      throw new Error('Shared budget rejection must happen before credential work');
    });
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly', TOOL_RATE_LIMITER: limiter } as unknown as Env,
      { google_id: 'digest-budget-user', email: 'digest-budget@example.test' },
      { getAccessToken } as unknown as GoogleAccessTokenLifecycle,
    );
    const tools = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, string>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
      }>;
    })._registeredTools;

    const result = await tools['reports.weekly_digest'].handler({
      site_url: 'sc-domain:example.com',
      end_date: '2026-09-17',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Rate limit reached for reports.weekly_digest');
    expect(take.mock.calls.map(([, policy, units]) => [policy.category, units])).toEqual([
      ['weekly-digest', 1],
      ['search-analytics', 5],
    ]);
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('reserves only three shared Search Analytics units for preliminary weekly digests', async () => {
    const take = vi.fn(async (_bucket: string, policy: { category: string }) => ({
      allowed: policy.category !== 'search-analytics',
      retry_after_ms: 20_000,
    }));
    const limiter = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ take })),
    };
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly', TOOL_RATE_LIMITER: limiter } as unknown as Env,
      { google_id: 'digest-preliminary-user', email: 'preliminary@example.test' },
      { getAccessToken: async () => {
        throw new Error('Quota must be reserved before credentials');
      } } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, string>) => Promise<{ isError?: boolean }>;
      }>;
    })._registeredTools['reports.weekly_digest'].handler;

    const result = await handler({
      site_url: 'sc-domain:example.com',
      end_date: getSearchConsoleCalendarDate(),
    });
    expect(result.isError).toBe(true);
    expect(take.mock.calls.map(([, policy, units]) => [policy.category, units])).toEqual([
      ['weekly-digest', 1],
      ['search-analytics', 3],
    ]);
  });

  it('charges a weekly digest retry in addition to its five upfront Analytics units', async () => {
    const take = vi.fn(async () => ({ allowed: true }));
    const server = await createGscMcpServer(
      {
        GSC_ACCESS_MODE: 'readonly',
        TOOL_RATE_LIMITER: { idFromName: (name: string) => name, get: () => ({ take }) },
      } as unknown as Env,
      { google_id: 'digest-retry-user', email: 'digest-retry@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools['reports.weekly_digest'].handler;
    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    try {
      globalThis.fetch = async () => {
        providerCalls += 1;
        return providerCalls === 1
          ? new Response('transient', { status: 503, headers: { 'retry-after': '0' } })
          : response({ rows: [] });
      };
      await handler({ site_url: 'sc-domain:example.com', end_date: '2026-09-17' });
      expect(providerCalls).toBe(6);
      expect(take.mock.calls.map((call) => [call[1].category, call[2]])).toEqual([
        ['weekly-digest', 1],
        ['search-analytics', 5],
        ['search-analytics', 1],
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
      expect(analyticsRequests.every((request) => request.type === undefined)).toBe(true);
      expect(analyticsRequests.every((request) => request.dimensionFilterGroups === undefined)).toBe(true);

      analyticsRequests.length = 0;
      const imageDigest = await tools['reports.weekly_digest'].handler({
        site_url: 'https://example.com/',
        search_type: 'image',
        page_contains: '/de/',
        device: 'mobile',
        query_contains: 'technical seo',
        country: 'deu',
      }) as { content: Array<{ text: string }> };
      expect(analyticsRequests).toHaveLength(5);
      expect(analyticsRequests.every((request) => request.type === 'image')).toBe(true);
      expect(analyticsRequests.every((request) => JSON.stringify(request.dimensionFilterGroups) === JSON.stringify([{
        groupType: 'and',
        filters: [
          { dimension: 'page', operator: 'contains', expression: '/de/' },
          { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
          { dimension: 'query', operator: 'contains', expression: 'technical seo' },
          { dimension: 'country', operator: 'equals', expression: 'DEU' },
        ],
      }]))).toBe(true);
      expect(imageDigest.content[0]?.text).toContain('**Search type:** Image search');
      expect(imageDigest.content[0]?.text).toContain('Page URL filter');
      expect(imageDigest.content[0]?.text).toContain('**Device filter:** Mobile');
      expect(imageDigest.content[0]?.text).toContain('**Query topic filter:** technical seo');
      expect(imageDigest.content[0]?.text).toContain('**Country filter:** DEU');
      expect(imageDigest.content[0]?.text).toContain('not property-wide totals');
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });
});
