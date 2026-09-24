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
          dimension_filter_groups?: Array<{
            groupType: string;
            filters: Array<{ operator: string; expression: string }>;
          }>;
        };
      };
    };
    const analyticsCompareSchema = tools['analytics.compare']
      .inputSchema as typeof analyticsQuerySchema;
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
      expect(serialized).toContain('"provider_exhaustiveness_guaranteed":false');
      expect(serialized).toContain('Google Search Analytics does not guarantee all data rows');
      expect(serialized).toContain('do not prove provider-level exhaustiveness');
      expect(serialized).toContain('"generative_ai_report_isolatable":false');
      expect(serialized).toContain('dedicated Generative AI performance reports');
      expect(serialized).toContain('overall web Search performance data');
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
      expect(analyticsRequests.map((request) => request.startRow ?? 0)).toEqual([
        0,
        0,
      ]);
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
