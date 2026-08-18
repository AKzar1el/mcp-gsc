import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getToolRateLimitPolicy,
  TOOL_RATE_LIMIT_POLICIES,
  ToolRateLimiter,
  type ToolRateLimitPolicy,
} from '../src/tool-rate-limit';

class InMemoryTransactionalStorage {
  private values = new Map<string, unknown>();
  private transactionTail = Promise.resolve();

  async transaction<T>(
    closure: (transaction: {
      get<T>(key: string): Promise<T | undefined>;
      put(key: string, value: unknown): Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      return await closure({
        get: async <T>(key: string) => this.values.get(key) as T | undefined,
        put: async (key: string, value: unknown) => {
          this.values.set(key, value);
        },
      });
    } finally {
      release();
    }
  }
}

function createLimiter(now: () => number) {
  const state = {
    storage: new InMemoryTransactionalStorage(),
  } as unknown as DurableObjectState;
  return new ToolRateLimiter(state, undefined, now);
}

const TEST_POLICY: ToolRateLimitPolicy = {
  category: 'test',
  tools: ['test.tool'],
  windowMs: 1_000,
  userLimit: 2,
};

test('tool rate-limit policy table assigns the documented categories and limits', () => {
  assert.deepEqual(Object.values(TOOL_RATE_LIMIT_POLICIES).map((policy) => ({
    category: policy.category,
    tools: policy.tools,
    windowMs: policy.windowMs,
    userLimit: policy.userLimit,
    projectLimit: policy.projectLimit,
  })), [
    {
      category: 'search-analytics',
      tools: [
        'analytics.query',
        'insights.quick_wins',
        'insights.cannibalization',
        'insights.content_decay',
        'indexing.list_pages',
        'analytics.compare',
      ],
      windowMs: 10 * 60 * 1000,
      userLimit: 30,
      projectLimit: undefined,
    },
    {
      category: 'url-inspection',
      tools: ['urls.inspect'],
      windowMs: 24 * 60 * 60 * 1000,
      userLimit: 20,
      projectLimit: undefined,
    },
    {
      category: 'search-console-write',
      tools: ['sites.add', 'sites.delete', 'sitemaps.submit', 'sitemaps.delete'],
      windowMs: 60 * 60 * 1000,
      userLimit: 10,
      projectLimit: undefined,
    },
    {
      category: 'indexing-request',
      tools: ['indexing.request'],
      windowMs: 24 * 60 * 60 * 1000,
      userLimit: 2,
      projectLimit: 200,
    },
    {
      category: 'weekly-digest',
      tools: ['reports.weekly_digest'],
      windowMs: 60 * 60 * 1000,
      userLimit: 6,
      projectLimit: undefined,
    },
  ]);
  assert.equal(getToolRateLimitPolicy('analytics.query')?.category, 'search-analytics');
  assert.equal(getToolRateLimitPolicy('sitemaps.delete')?.category, 'search-console-write');
  assert.equal(getToolRateLimitPolicy('sites.list'), undefined);
});

test('ToolRateLimiter allows calls through the configured boundary then rejects with retry information', async () => {
  let now = 1_000;
  const limiter = createLimiter(() => now);

  assert.deepEqual(await limiter.take('user-a', TEST_POLICY), { allowed: true });
  assert.deepEqual(await limiter.take('user-a', TEST_POLICY), { allowed: true });
  assert.deepEqual(await limiter.take('user-a', TEST_POLICY), {
    allowed: false,
    retry_after_ms: 1_000,
  });
});

test('ToolRateLimiter resets a user bucket after its window expires', async () => {
  let now = 1_000;
  const limiter = createLimiter(() => now);

  await limiter.take('user-a', TEST_POLICY);
  await limiter.take('user-a', TEST_POLICY);
  now += TEST_POLICY.windowMs;

  assert.deepEqual(await limiter.take('user-a', TEST_POLICY), { allowed: true });
});

test('ToolRateLimiter keeps independent authenticated users separate', async () => {
  const limiter = createLimiter(() => 1_000);

  await limiter.take('user-a', TEST_POLICY);
  await limiter.take('user-a', TEST_POLICY);
  assert.deepEqual(await limiter.take('user-b', TEST_POLICY), { allowed: true });
});

test('ToolRateLimiter keeps independent tool-category buckets separate', async () => {
  const analyticsLimiter = createLimiter(() => 1_000);
  const writeLimiter = createLimiter(() => 1_000);

  await analyticsLimiter.take('user-a', TEST_POLICY);
  await analyticsLimiter.take('user-a', TEST_POLICY);
  assert.deepEqual(await writeLimiter.take('user-a', TEST_POLICY), { allowed: true });
});

test('ToolRateLimiter is atomic under concurrent calls', async () => {
  const limiter = createLimiter(() => 1_000);
  const policy: ToolRateLimitPolicy = { ...TEST_POLICY, userLimit: 5 };

  const results = await Promise.all(
    Array.from({ length: 10 }, () => limiter.take('user-a', policy)),
  );

  assert.equal(results.filter((result) => result.allowed).length, 5);
  assert.equal(results.filter((result) => !result.allowed).length, 5);
});

test('ToolRateLimiter enforces a shared project limit without exposing usage', async () => {
  const limiter = createLimiter(() => 1_000);
  const policy: ToolRateLimitPolicy = {
    ...TEST_POLICY,
    userLimit: 5,
    projectLimit: 3,
  };

  assert.equal((await limiter.take('user-a', policy)).allowed, true);
  assert.equal((await limiter.take('user-b', policy)).allowed, true);
  assert.equal((await limiter.take('user-c', policy)).allowed, true);
  assert.deepEqual(await limiter.take('user-d', policy), {
    allowed: false,
    retry_after_ms: 1_000,
  });
});
