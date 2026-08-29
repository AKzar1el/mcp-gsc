import authenticatedWorker, { GscMcpAgent, type Env } from './index';

export { GscMcpAgent, PendingAuthState, ToolRateLimiter } from './index';

type EntrypointEnv = Env & {
  GLAMA_INSPECTION_MODE?: string;
};

type WorkerHandler = {
  fetch(
    request: Request,
    env: EntrypointEnv,
    ctx: ExecutionContext,
  ): Response | Promise<Response>;
};

const inspectionWorker = GscMcpAgent.serve('/mcp', {
  transport: 'auto',
}) as unknown as WorkerHandler;

const oauthWorker = authenticatedWorker as unknown as WorkerHandler;

/**
 * Glama's release builder cannot complete an interactive OAuth flow, but it
 * needs to initialize the MCP endpoint and call tools/list for static
 * inspection. The bypass is deliberately opt-in, exact-value gated, and
 * limited to /mcp. Tool handlers still have no authenticated agent props, so
 * data-bearing calls fail closed.
 */
export default {
  fetch(request: Request, env: EntrypointEnv, ctx: ExecutionContext) {
    const inspectionEnabled = env.GLAMA_INSPECTION_MODE === 'true';
    const isMcpEndpoint = new URL(request.url).pathname === '/mcp';

    if (inspectionEnabled && isMcpEndpoint) {
      return inspectionWorker.fetch(request, env, ctx);
    }

    return oauthWorker.fetch(request, env, ctx);
  },
};
