import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import worker from '../../src/entrypoint';
import { GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL } from '../../src/google';
import { type Env } from '../../src/index';

const workerEnv = env as unknown as Env;

afterEach(async () => {
  await reset();
});

async function callWorker(input: string | Request, init?: RequestInit) {
  const request = input instanceof Request
    ? input
    : new Request(`https://worker.example${input}`, init);
  return (worker as unknown as {
    fetch(
      request: Request,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<Response>;
  }).fetch(
    request,
    workerEnv,
    {} as ExecutionContext,
  );
}

async function submitConsent(
  consent: Response,
  decision: 'allow' | 'deny' = 'allow',
): Promise<Response> {
  expect(consent.status).toBe(200);
  expect(consent.headers.get('content-type')).toContain('text/html');
  expect(consent.headers.get('content-security-policy')).toContain("form-action 'self'");
  const html = await consent.text();
  const nonce = html.match(/name="consent_nonce" value="([^"]+)"/)?.[1];
  expect(nonce).toBeTruthy();
  const cookie = consent.headers.get('set-cookie')?.split(';', 1)[0];
  expect(cookie).toBeTruthy();
  return callWorker(
    new Request('https://worker.example/authorize', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookie!,
      },
      body: new URLSearchParams({
        consent_nonce: nonce!,
        decision,
      }),
    }),
  );
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

describe('OAuth discovery', () => {
  it('advertises the current MCP protected-resource and authorization-server contract', async () => {
    const challenge = await callWorker('/mcp');
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://worker.example/.well-known/oauth-protected-resource/mcp"',
    );

    const protectedResource = await callWorker(
      '/.well-known/oauth-protected-resource/mcp',
    );
    expect(protectedResource.status).toBe(200);
    await expect(protectedResource.json()).resolves.toMatchObject({
      resource: 'https://worker.example/mcp',
      authorization_servers: ['https://worker.example'],
      bearer_methods_supported: ['header'],
    });

    const authorizationServer = await callWorker(
      '/.well-known/oauth-authorization-server',
    );
    expect(authorizationServer.status).toBe(200);
    const metadata = await authorizationServer.json() as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer: 'https://worker.example',
      authorization_endpoint: 'https://worker.example/authorize',
      token_endpoint: 'https://worker.example/token',
      registration_endpoint: 'https://worker.example/register',
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    });
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('completes a DCR authorization flow and revokes the previous bearer token on reconnect', async () => {
    const redirectUri = 'https://client.example/callback';
    const resource = 'https://worker.example/mcp';
    const verifier = 'mcp-gsc-worker-pkce-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
    const challenge = await pkceChallenge(verifier);

    const registration = await callWorker(
      new Request('https://worker.example/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'mcp-gsc worker integration test',
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'none',
        }),
      }),
    );
    expect(registration.status).toBe(201);
    const client = await registration.json() as { client_id?: string };
    expect(client.client_id).toBeTruthy();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === GOOGLE_TOKEN_URL) {
        return Response.json({
          access_token: 'google-access-token',
          refresh_token: 'google-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'openid email',
        });
      }
      if (url === GOOGLE_USERINFO_URL) {
        return Response.json({ id: 'reconnect-user', email: 'reconnect@example.test' });
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    };

    const authorize = async (state: string): Promise<string> => {
      const url = new URL('https://worker.example/authorize');
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', client.client_id!);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('resource', resource);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');

      const consent = await callWorker(new Request(url));
      const authorization = await submitConsent(consent);
      expect(authorization.status).toBe(302);
      const googleRedirect = new URL(authorization.headers.get('location')!);
      const providerState = googleRedirect.searchParams.get('state');
      expect(providerState).toBeTruthy();

      const callback = await callWorker(
        new Request(
          `https://worker.example/google/callback?code=google-code&state=${providerState}`,
        ),
      );
      expect(callback.status).toBe(302);
      const clientRedirect = new URL(callback.headers.get('location')!);
      expect(`${clientRedirect.origin}${clientRedirect.pathname}`).toBe(redirectUri);
      expect(clientRedirect.searchParams.get('state')).toBe(state);
      expect(clientRedirect.searchParams.get('iss')).toBe('https://worker.example');
      const code = clientRedirect.searchParams.get('code');
      expect(code).toBeTruthy();
      return code!;
    };

    const exchangeCode = (code: string) => callWorker(
      new Request('https://worker.example/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: client.client_id!,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          resource,
        }),
      }),
    );

    const probeBearer = (token: string) => callWorker(
      new Request(resource, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );

    try {
      const firstCode = await authorize('first-connect');
      const firstExchange = await exchangeCode(firstCode);
      expect(firstExchange.status).toBe(200);
      const firstTokens = await firstExchange.json() as { access_token?: string };
      expect(firstTokens.access_token).toBeTruthy();
      expect((await probeBearer(firstTokens.access_token!)).status).not.toBe(401);

      const secondCode = await authorize('reconnect');
      expect((await probeBearer(firstTokens.access_token!)).status).toBe(401);

      const secondExchange = await exchangeCode(secondCode);
      expect(secondExchange.status).toBe(200);
      const secondTokens = await secondExchange.json() as { access_token?: string };
      expect(secondTokens.access_token).toBeTruthy();
      expect((await probeBearer(secondTokens.access_token!)).status).not.toBe(401);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps CIMD installations independent while revoking only the reconnected installation', async () => {
    const clientId = 'https://client.example/oauth/client.json';
    const redirectUriA = 'https://client.example/install-a/callback';
    const redirectUriB = 'https://client.example/install-b/callback';
    const resource = 'https://worker.example/mcp';
    const verifier = 'mcp-gsc-cimd-pkce-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
    const challenge = await pkceChallenge(verifier);
    let cimdFetches = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === clientId) {
        cimdFetches += 1;
        return Response.json(
          {
            client_id: clientId,
            client_name: 'mcp-gsc CIMD integration test',
            redirect_uris: [redirectUriA, redirectUriB],
            token_endpoint_auth_method: 'none',
          },
          { headers: { 'cache-control': 'no-store' } },
        );
      }
      if (url === GOOGLE_TOKEN_URL) {
        return Response.json({
          access_token: 'google-access-token',
          refresh_token: 'google-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'openid email',
        });
      }
      if (url === GOOGLE_USERINFO_URL) {
        return Response.json({ id: 'cimd-user', email: 'cimd@example.test' });
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    };

    const authorize = async (redirectUri: string, state: string): Promise<string> => {
      const url = new URL('https://worker.example/authorize');
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('resource', resource);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');

      const consent = await callWorker(new Request(url));
      const authorization = await submitConsent(consent);
      expect(authorization.status).toBe(302);
      const googleRedirect = new URL(authorization.headers.get('location')!);
      const providerState = googleRedirect.searchParams.get('state');
      expect(providerState).toBeTruthy();

      const callback = await callWorker(
        new Request(
          `https://worker.example/google/callback?code=google-code&state=${providerState}`,
        ),
      );
      expect(callback.status).toBe(302);
      const clientRedirect = new URL(callback.headers.get('location')!);
      expect(`${clientRedirect.origin}${clientRedirect.pathname}`).toBe(redirectUri);
      expect(clientRedirect.searchParams.get('state')).toBe(state);
      expect(clientRedirect.searchParams.get('iss')).toBe('https://worker.example');
      const code = clientRedirect.searchParams.get('code');
      expect(code).toBeTruthy();
      return code!;
    };

    const exchangeCode = (redirectUri: string, code: string) => callWorker(
      new Request('https://worker.example/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          resource,
        }),
      }),
    );

    const probeBearer = (token: string) => callWorker(
      new Request(resource, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );

    try {
      const codeA1 = await authorize(redirectUriA, 'install-a-first');
      const exchangeA1 = await exchangeCode(redirectUriA, codeA1);
      expect(exchangeA1.status).toBe(200);
      const tokensA1 = await exchangeA1.json() as { access_token?: string };
      expect(tokensA1.access_token).toBeTruthy();

      const codeB1 = await authorize(redirectUriB, 'install-b-first');
      const exchangeB1 = await exchangeCode(redirectUriB, codeB1);
      expect(exchangeB1.status).toBe(200);
      const tokensB1 = await exchangeB1.json() as { access_token?: string };
      expect(tokensB1.access_token).toBeTruthy();

      expect((await probeBearer(tokensA1.access_token!)).status).not.toBe(401);
      expect((await probeBearer(tokensB1.access_token!)).status).not.toBe(401);

      const codeA2 = await authorize(redirectUriA, 'install-a-reconnect');
      expect((await probeBearer(tokensA1.access_token!)).status).toBe(401);
      expect((await probeBearer(tokensB1.access_token!)).status).not.toBe(401);

      const exchangeA2 = await exchangeCode(redirectUriA, codeA2);
      expect(exchangeA2.status).toBe(200);
      const tokensA2 = await exchangeA2.json() as { access_token?: string };
      expect(tokensA2.access_token).toBeTruthy();
      expect((await probeBearer(tokensA2.access_token!)).status).not.toBe(401);
      expect((await probeBearer(tokensB1.access_token!)).status).not.toBe(401);
      expect(cimdFetches).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('requires explicit client consent and returns denial to the validated OAuth client', async () => {
    const redirectUri = 'https://client.example/callback';
    const registration = await callWorker(
      new Request('https://worker.example/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: '<script>alert(1)</script>',
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'none',
        }),
      }),
    );
    expect(registration.status).toBe(201);
    const client = await registration.json() as { client_id?: string };
    expect(client.client_id).toBeTruthy();

    const url = new URL('https://worker.example/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', client.client_id!);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', 'deny-state');
    url.searchParams.set('resource', 'https://worker.example/mcp');
    url.searchParams.set('code_challenge', await pkceChallenge('consent-deny-verifier-0123456789-abcdefghijklmnopqrstuvwxyz'));
    url.searchParams.set('code_challenge_method', 'S256');

    const consent = await callWorker(new Request(url));
    expect(consent.status).toBe(200);
    const clone = consent.clone();
    const html = await clone.text();
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('webmasters');
    expect(html).toContain('indexing');

    const consentNonce = html.match(/name="consent_nonce" value="([^"]+)"/)?.[1];
    expect(consentNonce).toBeTruthy();
    const forged = await callWorker(
      new Request('https://worker.example/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          consent_nonce: consentNonce!,
          decision: 'allow',
        }),
      }),
    );
    expect(forged.status).toBe(400);

    const denied = await submitConsent(consent, 'deny');
    expect(denied.status).toBe(302);
    const deniedUrl = new URL(denied.headers.get('location')!);
    expect(`${deniedUrl.origin}${deniedUrl.pathname}`).toBe(redirectUri);
    expect(deniedUrl.searchParams.get('error')).toBe('access_denied');
    expect(deniedUrl.searchParams.get('state')).toBe('deny-state');
    expect(deniedUrl.searchParams.get('iss')).toBe('https://worker.example');
  });

  it('returns an upstream Google denial to the validated MCP client', async () => {
    const redirectUri = 'https://client.example/callback';
    const registration = await callWorker(
      new Request('https://worker.example/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Google denial client',
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'none',
        }),
      }),
    );
    expect(registration.status).toBe(201);
    const client = await registration.json() as { client_id?: string };
    expect(client.client_id).toBeTruthy();

    const url = new URL('https://worker.example/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', client.client_id!);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', 'google-denial-state');
    url.searchParams.set('resource', 'https://worker.example/mcp');
    url.searchParams.set('code_challenge', await pkceChallenge('google-denial-verifier-0123456789-abcdefghijklmnopqrstuvwxyz'));
    url.searchParams.set('code_challenge_method', 'S256');

    const approved = await submitConsent(await callWorker(new Request(url)));
    expect(approved.status).toBe(302);
    const googleRedirect = new URL(approved.headers.get('location')!);
    const providerState = googleRedirect.searchParams.get('state');
    expect(providerState).toBeTruthy();

    const callback = await callWorker(
      new Request(
        `https://worker.example/google/callback?error=access_denied&state=${encodeURIComponent(providerState!)}`,
      ),
    );
    expect(callback.status).toBe(302);
    const clientRedirect = new URL(callback.headers.get('location')!);
    expect(`${clientRedirect.origin}${clientRedirect.pathname}`).toBe(redirectUri);
    expect(clientRedirect.searchParams.get('error')).toBe('access_denied');
    expect(clientRedirect.searchParams.get('state')).toBe('google-denial-state');
    expect(clientRedirect.searchParams.get('iss')).toBe('https://worker.example');
  });
});
