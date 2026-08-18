const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface ToolRateLimitPolicy {
  /** The coordination bucket shared by the tools in this policy. */
  category: string;
  tools: readonly string[];
  windowMs: number;
  userLimit: number;
  /**
   * A project-wide cap is used only where Google publishes a small, shared
   * project quota. It is intentionally absent for ordinary GSC operations.
   */
  projectLimit?: number;
}

/**
 * Limits apply before an upstream request is made. The values are intentionally
 * conservative relative to Google's published quotas, because a self-hosted
 * deployment can have multiple authenticated users sharing one Cloud project.
 *
 * Sources:
 * - https://developers.google.com/webmaster-tools/limits
 * - https://developers.google.com/search/apis/indexing-api/v3/quota-pricing
 */
export const TOOL_RATE_LIMIT_POLICIES = {
  search_analytics: {
    category: 'search-analytics',
    tools: [
      'analytics.query',
      'insights.quick_wins',
      'insights.cannibalization',
      'insights.content_decay',
      'indexing.list_pages',
      'analytics.compare',
    ],
    // GSC measures Search Analytics short-term load in 10-minute windows.
    windowMs: 10 * MINUTE_MS,
    userLimit: 30,
  },
  url_inspection: {
    category: 'url-inspection',
    tools: ['urls.inspect'],
    // This is one percent of GSC's published 2,000
    // inspections-per-site-per-day quota for each user.
    windowMs: DAY_MS,
    userLimit: 20,
  },
  search_console_writes: {
    category: 'search-console-write',
    tools: ['sites.add', 'sites.delete', 'sitemaps.submit', 'sitemaps.delete'],
    // Mutation safety guard, far below GSC's 200 requests-per-minute
    // per-user limit for non-Search-Analytics resources.
    windowMs: HOUR_MS,
    userLimit: 10,
  },
  indexing_request: {
    category: 'indexing-request',
    tools: ['indexing.request'],
    // Google defaults to 200 publish requests per project per day. Two per
    // user reserves the default quota for up to 100 authenticated users.
    windowMs: DAY_MS,
    userLimit: 2,
    projectLimit: 200,
  },
  weekly_digest: {
    category: 'weekly-digest',
    tools: ['reports.weekly_digest'],
    // A digest makes five Search Analytics requests, so it has its own bucket.
    windowMs: HOUR_MS,
    userLimit: 6,
  },
} as const satisfies Record<string, ToolRateLimitPolicy>;

export type ToolRateLimitCategory = keyof typeof TOOL_RATE_LIMIT_POLICIES;
export type RateLimitedToolName =
  (typeof TOOL_RATE_LIMIT_POLICIES)[ToolRateLimitCategory]['tools'][number];

const POLICY_BY_TOOL = new Map<string, ToolRateLimitPolicy>(
  Object.values(TOOL_RATE_LIMIT_POLICIES).flatMap((policy) =>
    policy.tools.map((tool) => [tool, policy] as const),
  ),
);

interface RateLimitWindow {
  window_started_at: number;
  count: number;
}

export interface ToolRateLimitResult {
  allowed: boolean;
  retry_after_ms?: number;
}

interface ToolRateLimiterEnv {
  TOOL_RATE_LIMITER: DurableObjectNamespace;
}

interface ToolRateLimiterStub {
  take(userBucket: string, policy: ToolRateLimitPolicy): Promise<ToolRateLimitResult>;
}

function currentWindow(
  value: RateLimitWindow | undefined,
  now: number,
  windowMs: number,
): RateLimitWindow {
  if (!value || now >= value.window_started_at + windowMs) {
    return { window_started_at: now, count: 0 };
  }
  return value;
}

function retryAfterMs(window: RateLimitWindow, now: number, windowMs: number): number {
  return Math.max(0, window.window_started_at + windowMs - now);
}

/**
 * Coordinates one policy category. Ordinary categories are sharded by the
 * authenticated user's hashed bucket. Indexing uses one category instance so
 * its small Google project quota can be enforced together with user limits.
 */
export class ToolRateLimiter {
  constructor(
    private readonly state: DurableObjectState,
    _env: unknown,
    private readonly now: () => number = Date.now,
  ) {}

  async take(
    userBucket: string,
    policy: ToolRateLimitPolicy,
  ): Promise<ToolRateLimitResult> {
    return this.state.storage.transaction(async (txn) => {
      const now = this.now();
      const userKey = `user:${userBucket}`;
      const userWindow = currentWindow(
        await txn.get<RateLimitWindow>(userKey),
        now,
        policy.windowMs,
      );
      const projectWindow = policy.projectLimit === undefined
        ? undefined
        : currentWindow(
          await txn.get<RateLimitWindow>('project'),
          now,
          policy.windowMs,
        );

      const userExceeded = userWindow.count >= policy.userLimit;
      const projectExceeded = projectWindow !== undefined
        && projectWindow.count >= policy.projectLimit!;
      if (userExceeded || projectExceeded) {
        const waits = [
          ...(userExceeded
            ? [retryAfterMs(userWindow, now, policy.windowMs)]
            : []),
          ...(projectExceeded && projectWindow
            ? [retryAfterMs(projectWindow, now, policy.windowMs)]
            : []),
        ];
        return {
          allowed: false,
          // If both limits apply, waiting for the longer window guarantees the
          // retry will not immediately encounter the other limit.
          retry_after_ms: Math.max(...waits),
        };
      }

      await txn.put(userKey, { ...userWindow, count: userWindow.count + 1 });
      if (projectWindow) {
        await txn.put('project', {
          ...projectWindow,
          count: projectWindow.count + 1,
        });
      }
      return { allowed: true };
    });
  }
}

export function getToolRateLimitPolicy(toolName: string): ToolRateLimitPolicy | undefined {
  return POLICY_BY_TOOL.get(toolName);
}

async function userBucketFor(googleId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(googleId),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function getToolRateLimiterStub(
  env: ToolRateLimiterEnv,
  policy: ToolRateLimitPolicy,
  userBucket: string,
): ToolRateLimiterStub {
  // The Indexing API's low project-wide quota is the coordination atom for
  // that category. All other policies are sharded by user and category.
  const name = policy.projectLimit === undefined
    ? `${policy.category}:${userBucket}`
    : policy.category;
  return env.TOOL_RATE_LIMITER.get(
    env.TOOL_RATE_LIMITER.idFromName(name),
  ) as unknown as ToolRateLimiterStub;
}

export async function enforceToolRateLimit(
  env: ToolRateLimiterEnv,
  googleId: string,
  toolName: string,
): Promise<ToolRateLimitResult> {
  const policy = getToolRateLimitPolicy(toolName);
  if (!policy) return { allowed: true };

  const userBucket = await userBucketFor(googleId);
  return getToolRateLimiterStub(env, policy, userBucket).take(userBucket, policy);
}
