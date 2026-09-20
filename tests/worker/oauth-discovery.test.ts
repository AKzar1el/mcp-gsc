import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../../src/entrypoint';
import { type Env } from '../../src/index';

const workerEnv = env as unknown as Env;

async function callWorker(path: string) {
  return (worker as unknown as {
    fetch(
      request: Request,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<Response>;
  }).fetch(
    new Request(`https://worker.example${path}`),
    workerEnv,
    {} as ExecutionContext,
  );
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
});
