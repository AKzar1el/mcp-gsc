import { DurableObject } from 'cloudflare:workers';
import {
  ToolRateLimiterCore,
  type ToolRateLimitPolicy,
  type ToolRateLimitResult,
} from './tool-rate-limit';

export class ToolRateLimiter extends DurableObject<Record<string, unknown>> {
  private readonly core: ToolRateLimiterCore;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.core = new ToolRateLimiterCore(ctx, env);
  }

  take(
    userBucket: string,
    policy: ToolRateLimitPolicy,
    units = 1,
  ): Promise<ToolRateLimitResult> {
    return this.core.take(userBucket, policy, units);
  }
}
