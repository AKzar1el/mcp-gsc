import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker, {
  GscMcpAgent,
  PendingAuthState,
} from '../../src/index';
import { saveUser } from '../../src/storage';
import { ToolRateLimiter } from '../../src/tool-rate-limit';

const workerEnv = env as unknown as import('../../src/index').Env;

function makeGoogleTokenResponse(accessToken: string, refreshToken?: string) {
  return {
    access_token: accessToken,
    expires_in: 3600,
    token_type: 'Bearer',
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  };
}

describe('Worker orchestration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uses configured KV and Durable Object bindings to consume OAuth state once', async () => {
    await expect(
      runInDurableObject(workerEnv.PENDING_AUTH_STATE.newUniqueId(), async (instance) => {
        const durableObject = instance as unknown as PendingAuthState;
        return durableObject.fetch(
          new Request('https://pending-auth-state.test/store', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              state: 'worker-state',
              client_id: 'worker-client',
              code_verifier: 'worker-verifier',
              redirect_uri: 'https://client.example/callback',
            }),
          }),
        );
      }),
    ).resolves.toMatchObject({ status: 204 });

    const firstConsume = await worker.fetch(
      new Request('https://worker.example/consume-pending-auth?state=worker-state'),
      workerEnv,
      {} as ExecutionContext,
    );
    expect(firstConsume.status).toBe(200);
    await expect(firstConsume.json()).resolves.toMatchObject({
      client_id: 'worker-client',
      code_verifier: 'worker-verifier',
    });

    const secondConsume = await worker.fetch(
      new Request('https://worker.example/consume-pending-auth?state=worker-state'),
      workerEnv,
      {} as ExecutionContext,
    );
    expect(secondConsume.status).toBe(404);
  });

  it('persists the OAuth callback credential through Worker KV and rejects a reused state', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeGoogleTokenResponse('oauth-access', 'oauth-refresh')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 'google-user-1', email: 'user@example.com' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );

    const state = 'callback-state';
    const pendingStateResponse = await worker.fetch(
      new Request('https://worker.example/store-pending-auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          state,
          client_id: 'callback-client',
          code_verifier: 'callback-verifier',
          redirect_uri: 'https://client.example/callback',
        }),
      }),
      workerEnv,
      {} as ExecutionContext,
    );
    expect(pendingStateResponse.status).toBe(204);

    const callbackResponse = await worker.fetch(
      new Request(`https://worker.example/callback?code=google-code&state=${state}`),
      workerEnv,
      {} as ExecutionContext,
    );
    expect(callbackResponse.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const storedUser = await workerEnv.USER_KV.get('user:google-user-1');
    expect(storedUser).not.toBeNull();

    const reusedResponse = await worker.fetch(
      new Request(`https://worker.example/callback?code=google-code&state=${state}`),
      workerEnv,
      {} as ExecutionContext,
    );
    expect(reusedResponse.status).toBe(400);
  });

  it('registers the MCP tool catalog in the agent Durable Object and applies write annotations', async () => {
    await runInDurableObject(workerEnv.MCP_OBJECT.newUniqueId(), async (instance) => {
      const agent = instance as unknown as GscMcpAgent;
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
      'cached@example.com',
      'cached-refresh-token',
    );

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'cached-access-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ siteEntry: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await runInDurableObject(workerEnv.MCP_OBJECT.newUniqueId(), async (instance) => {
      const agent = instance as unknown as GscMcpAgent;
      Object.assign(agent, { props: { google_id: 'cached-user', email: 'cached@example.com' } });
      await agent.init();

      const tools = (agent.server as unknown as {
        _registeredTools: Record<string, { callback: () => Promise<unknown> }>;
      })._registeredTools;

      await tools['sites.list'].callback();
      await tools['sites.list'].callback();
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await workerEnv.USER_KV.get('user:cached-user')).toBeNull();
  });

  it('orchestrates the weekly digest through stored credentials and deterministic analytics responses', async () => {
    await saveUser(
      workerEnv,
      'digest-user',
      'digest@example.com',
      'digest-refresh-token',
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'digest-access-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const row = (query: string, clicks: number, impressions: number) => ({
        keys: [query],
        clicks,
        impressions,
        ctr: impressions === 0 ? 0 : clicks / impressions,
        position: 10,
      });

      const rows = body.startDate < body.endDate
        ? [row('query-a', 10, 100), row('query-b', 5, 50)]
        : [];
      return new Response(JSON.stringify({ rows }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const response = await worker.fetch(
      new Request('https://worker.example/weekly-digest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          google_id: 'digest-user',
          site_url: 'sc-domain:example.com',
          start_date: '2026-06-01',
          end_date: '2026-06-07',
        }),
      }),
      workerEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    const markdown = await response.text();
    expect(markdown).toContain('query-a');
  });
});
