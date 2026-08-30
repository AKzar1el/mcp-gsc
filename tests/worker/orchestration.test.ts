import { afterEach, describe, expect, it } from 'vitest';
import { reset, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { generateWeeklyDigest } from '../../src/digest';
import { GoogleAccessTokenLifecycle } from '../../src/access-token-lifecycle';
import {
  defaultHandler,
  GscMcpAgent,
  type Env,
} from '../../src/index';
import {
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
} from '../../src/google';
import { PendingAuthState } from '../../src/pending-auth-state';
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

  it('registers the MCP tool catalog in the agent Durable Object and applies write annotations', async () => {
    const stub = workerEnv.MCP_OBJECT.get(
      workerEnv.MCP_OBJECT.idFromName('tool-registration'),
    );

    await runInDurableObject(stub, async (agent: GscMcpAgent) => {
      await agent.updateProps({
        google_id: 'tool-user',
        email: 'tool@example.test',
      });
      await agent.init();

      const tools = (agent.server as unknown as {
        _registeredTools: Record<
          string,
          { annotations?: Record<string, boolean>; inputSchema?: unknown }
        >;
      })._registeredTools;

      expect(Object.keys(tools)).toEqual(
        expect.arrayContaining([
          'analytics.query',
          'reports.weekly_digest',
          'sites.add',
          'sites.delete',
          'sitemaps.submit',
          'sitemaps.delete',
          'indexing.request',
        ]),
      );
      expect(tools['analytics.query'].inputSchema).toBeDefined();
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
    const stub = workerEnv.MCP_OBJECT.get(
      workerEnv.MCP_OBJECT.idFromName('token-lifecycle'),
    );

    await runInDurableObject(stub, async (agent: GscMcpAgent) => {
      await agent.updateProps({
        google_id: 'cached-user',
        email: 'cached@example.test',
      });
      await agent.init();

      const tools = (agent.server as unknown as {
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

        await tools['sites.list'].handler({});
        await tools['sites.list'].handler({});
        expect(cachedRefreshes).toBe(1);

        await agent.updateProps({
          google_id: 'revoked-user',
          email: 'revoked@example.test',
        });
        await expect(tools['sites.list'].handler({})).rejects.toThrow(
          'Google access revoked',
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

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
});
