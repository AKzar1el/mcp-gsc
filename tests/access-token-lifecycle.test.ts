import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GoogleAccessTokenLifecycle,
  type AccessTokenLifecycleDependencies,
  type GoogleAccessTokenEnv,
} from '../src/access-token-lifecycle';
import { generateWeeklyDigest } from '../src/digest';
import { getSearchConsoleCalendarDate } from '../src/date-validation';
import { GoogleRefreshTokenRevokedError } from '../src/google';

const ENV: GoogleAccessTokenEnv = {
  USER_KV: {} as KVNamespace,
  TOKEN_ENCRYPTION_KEY: 'test-key',
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
};

function createLifecycle(
  overrides: Partial<AccessTokenLifecycleDependencies> = {},
) {
  let now = 1_000;
  let refreshCalls = 0;
  const dependencies: Partial<AccessTokenLifecycleDependencies> = {
    getDecryptedRefreshToken: async () => 'refresh-token',
    refreshAccessToken: async () => {
      refreshCalls += 1;
      return { access_token: `access-token-${refreshCalls}`, expires_in: 3_600 };
    },
    now: () => now,
    ...overrides,
  };
  return {
    lifecycle: new GoogleAccessTokenLifecycle(ENV, dependencies),
    setNow(value: number) {
      now = value;
    },
    get refreshCalls() {
      return refreshCalls;
    },
  };
}

function installDigestAnalyticsMock(
  currentQueryRows: Array<{
    keys: string[];
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>,
  options: {
    currentTotals?: {
      clicks: number;
      impressions: number;
      ctr: number;
      position: number;
    };
    previousTotals?: {
      clicks: number;
      impressions: number;
      ctr: number;
      position: number;
    };
    previousQueryRows?: Array<{
      keys: string[];
      clicks: number;
      impressions: number;
      ctr: number;
      position: number;
    }>;
    currentPageUrl?: string;
    currentPageRows?: Array<{
      keys: string[];
      clicks: number;
      impressions: number;
      ctr: number;
      position: number;
    }>;
  } = {},
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      startDate: string;
      dimensions?: string[];
    };
    const currentPeriod = body.startDate === '2026-08-04';
    const dimension = body.dimensions?.[0];

    let rows: Array<{
      keys?: string[];
      clicks: number;
      impressions: number;
      ctr: number;
      position: number;
    }> = [];
    if (!dimension) {
      rows = [
        currentPeriod
          ? {
              clicks: 0,
              impressions: 40,
              ctr: 0,
              position: 8,
              ...options.currentTotals,
            }
          : {
              clicks: 0,
              impressions: 10,
              ctr: 0,
              position: 9,
              ...options.previousTotals,
            },
      ];
    } else if (dimension === 'query' && currentPeriod) {
      rows = currentQueryRows;
    } else if (dimension === 'query') {
      rows = options.previousQueryRows ?? [];
    } else if (dimension === 'page' && currentPeriod) {
      rows = options.currentPageRows ?? [
        {
          keys: [options.currentPageUrl ?? 'https://example.com/page'],
          clicks: 0,
          impressions: 40,
          ctr: 0,
          position: 8,
        },
      ];
    }

    return new Response(JSON.stringify({ rows }), {
      headers: { 'content-type': 'application/json' },
    });
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

test('GoogleAccessTokenLifecycle reuses a valid cached token for normal tool calls', async () => {
  const fixture = createLifecycle();

  assert.equal(await fixture.lifecycle.getAccessToken('user-a'), 'access-token-1');
  assert.equal(await fixture.lifecycle.getAccessToken('user-a'), 'access-token-1');
  assert.equal(fixture.refreshCalls, 1);
});

test('GoogleAccessTokenLifecycle refreshes when the cached token is no longer safely valid', async () => {
  let refreshCalls = 0;
  const fixture = createLifecycle({
    refreshAccessToken: async () => {
      refreshCalls += 1;
      return { access_token: `short-lived-${refreshCalls}`, expires_in: 120 };
    },
  });

  assert.equal(await fixture.lifecycle.getAccessToken('user-a'), 'short-lived-1');
  fixture.setNow(61_000);
  assert.equal(await fixture.lifecycle.getAccessToken('user-a'), 'short-lived-2');
  assert.equal(refreshCalls, 2);
});

test('GoogleAccessTokenLifecycle invalidates only the reconnected user cache', async () => {
  const refreshTokens = new Map([['user-a', 'old-grant'], ['user-b', 'other-grant']]);
  const calls: string[] = [];
  const fixture = createLifecycle({
    getDecryptedRefreshToken: async (_env, googleId) => refreshTokens.get(googleId) ?? null,
    refreshAccessToken: async (refreshToken) => {
      calls.push(refreshToken);
      return { access_token: `access:${refreshToken}`, expires_in: 3_600 };
    },
  });

  assert.equal(await fixture.lifecycle.getAccessToken('user-a'), 'access:old-grant');
  assert.equal(await fixture.lifecycle.getAccessToken('user-b'), 'access:other-grant');
  refreshTokens.set('user-a', 'new-grant');
  fixture.lifecycle.invalidate('user-a');
  assert.equal(await fixture.lifecycle.getAccessToken('user-a'), 'access:new-grant');
  assert.equal(await fixture.lifecycle.getAccessToken('user-b'), 'access:other-grant');
  assert.deepEqual(calls, ['old-grant', 'other-grant', 'new-grant']);
});

test('GoogleAccessTokenLifecycle cannot restore an old in-flight token after reconnection', async () => {
  let grant = 'old-grant';
  let finishOld!: (value: { access_token: string; expires_in: number }) => void;
  let oldStarted!: () => void;
  const oldStartedPromise = new Promise<void>((resolve) => { oldStarted = resolve; });
  const fixture = createLifecycle({
    getDecryptedRefreshToken: async () => grant,
    refreshAccessToken: async (refreshToken) => {
      if (refreshToken === 'old-grant') {
        oldStarted();
        return new Promise((resolve) => { finishOld = resolve; });
      }
      return { access_token: 'new-access', expires_in: 3_600 };
    },
  });

  const earlier = fixture.lifecycle.getAccessToken('user-a');
  await oldStartedPromise;
  grant = 'new-grant';
  fixture.lifecycle.invalidate('user-a');
  assert.equal(await fixture.lifecycle.getAccessToken('user-a'), 'new-access');
  finishOld({ access_token: 'old-access', expires_in: 3_600 });
  assert.equal(await earlier, 'new-access');
  assert.equal(await fixture.lifecycle.getAccessToken('user-a'), 'new-access');
});

test('GoogleAccessTokenLifecycle ignores a stale revoked-grant failure after reconnection', async () => {
  let grant = 'old-grant';
  let oldStarted!: () => void;
  let newStarted!: () => void;
  const oldStartedPromise = new Promise<void>((resolve) => { oldStarted = resolve; });
  const newStartedPromise = new Promise<void>((resolve) => { newStarted = resolve; });
  let rejectOld!: (error: Error) => void;
  let resolveNew!: (tokens: { access_token: string; expires_in: number }) => void;
  const refreshedGrants: string[] = [];
  const fixture = createLifecycle({
    getDecryptedRefreshToken: async () => grant,
    refreshAccessToken: async (refreshToken) => {
      refreshedGrants.push(refreshToken);
      if (refreshToken === 'old-grant') {
        oldStarted();
        return new Promise((_resolve, reject) => { rejectOld = reject; });
      }
      newStarted();
      return new Promise((resolve) => { resolveNew = resolve; });
    },
  });

  const oldRequest = fixture.lifecycle.getAccessToken('user-a');
  await oldStartedPromise;
  grant = 'new-grant';
  fixture.lifecycle.invalidate('user-a');
  const newRequest = fixture.lifecycle.getAccessToken('user-a');
  await newStartedPromise;

  // The old invalid_grant arrives while the replacement grant is refreshing.
  rejectOld(new GoogleRefreshTokenRevokedError());
  resolveNew({ access_token: 'new-access', expires_in: 3_600 });

  assert.deepEqual(await Promise.all([oldRequest, newRequest]), ['new-access', 'new-access']);
  assert.equal(await fixture.lifecycle.getAccessToken('user-a'), 'new-access');
  assert.deepEqual(refreshedGrants, ['old-grant', 'new-grant']);
});

test('GoogleAccessTokenLifecycle gives reconnect guidance without deleting stored credentials', async () => {
  const fixture = createLifecycle({
    refreshAccessToken: async () => {
      throw new GoogleRefreshTokenRevokedError();
    },
  });

  await assert.rejects(
    () => fixture.lifecycle.getAccessToken('user-a'),
    (error: unknown) => {
      assert.ok(error instanceof GoogleRefreshTokenRevokedError);
      assert.match(error.message, /expired, been revoked, or requires reauthentication/i);
      assert.match(error.message, /reconnect this server/i);
      return true;
    },
  );
});

test('GoogleAccessTokenLifecycle preserves credentials after transient refresh errors', async () => {
  const fixture = createLifecycle({
    refreshAccessToken: async () => {
      throw new Error('Failed to refresh Google access token: 503');
    },
  });

  await assert.rejects(
    () => fixture.lifecycle.getAccessToken('user-a'),
    /503/,
  );
});

test('GoogleAccessTokenLifecycle coalesces concurrent refreshes for one user', async () => {
  let resolveRefresh!: (token: { access_token: string; expires_in: number }) => void;
  let refreshCalls = 0;
  const fixture = createLifecycle({
    refreshAccessToken: async () => {
      refreshCalls += 1;
      return new Promise((resolve) => {
        resolveRefresh = resolve;
      });
    },
  });

  const first = fixture.lifecycle.getAccessToken('user-a');
  const second = fixture.lifecycle.getAccessToken('user-a');
  await Promise.resolve();
  assert.equal(refreshCalls, 1);
  resolveRefresh({ access_token: 'shared-token', expires_in: 3_600 });

  assert.deepEqual(await Promise.all([first, second]), ['shared-token', 'shared-token']);
});

test('generateWeeklyDigest uses the shared access-token provider', async () => {
  const fixture = createLifecycle();
  const originalFetch = globalThis.fetch;
  const authHeaders: string[] = [];
  globalThis.fetch = async (_input, init) => {
    authHeaders.push(new Headers(init?.headers).get('authorization') ?? '');
    return new Response(JSON.stringify({ rows: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const digest = await generateWeeklyDigest(
      fixture.lifecycle,
      'user-a',
      'https://example.com/',
      '2026-08-10',
    );

    assert.match(digest, /weekly site report/);
    assert.match(digest, /Search Analytics alone does not tell us whether Google crawled or indexed/);
    assert.match(digest, /use this server's `urls\.inspect` tool/);
    assert.doesNotMatch(digest, /Google has crawled your site/);
    assert.doesNotMatch(digest, /your site is JavaScript-rendered/);
    assert.equal(fixture.refreshCalls, 1);
    assert.deepEqual(authHeaders, Array(5).fill('Bearer access-token-1'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('weekly digest escapes the site name when aggregate rows are unavailable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ rows: [] }), {
    headers: { 'content-type': 'application/json' },
  });
  try {
    const digest = await generateWeeklyDigest(
      createLifecycle().lifecycle, 'user-a', 'https://foo_bar.example/', '2026-08-10',
    );
    assert.ok(digest.includes('# Your weekly site report - foo\\_bar\\.example'));
    assert.match(digest, /## Data availability/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('weekly digest queries only finalized Search Console data for all five report sections', async () => {
  const restoreFetch = installDigestAnalyticsMock([]);
  const originalMockFetch = globalThis.fetch;
  const dataStates: Array<string | undefined> = [];
  globalThis.fetch = async (input, init) => {
    dataStates.push((JSON.parse(String(init?.body)) as { dataState?: string }).dataState);
    return originalMockFetch(input, init);
  };
  try {
    await generateWeeklyDigest(createLifecycle().lifecycle, 'user-a', 'https://example.com/', '2026-08-10');
    assert.deepEqual(dataStates, Array(5).fill('final'));
  } finally {
    restoreFetch();
  }
});

test('weekly digest scopes all five analytics requests and its heading to one URL section', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ dimensionFilterGroups?: unknown }> = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as { dimensionFilterGroups?: unknown });
    return new Response(JSON.stringify({ rows: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const digest = await generateWeeklyDigest(
      createLifecycle().lifecycle, 'user-a', 'https://example.com/',
      '2026-08-10', undefined, '2026-08-15', '/de/',
    );
    assert.equal(requests.length, 5);
    for (const request of requests) {
      assert.deepEqual(request.dimensionFilterGroups, [{
        groupType: 'and',
        filters: [{ dimension: 'page', operator: 'contains', expression: '/de/' }],
      }]);
    }
    assert.match(digest, /Page URL filter/i);
    assert.match(digest, /\/de\//);
    assert.match(digest, /not property-wide/i);
    assert.match(digest, /does not establish a measured zero/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('weekly digest scopes all three preliminary requests to a selected device', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ dataState?: string; dimensionFilterGroups?: unknown }> = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as { dataState?: string; dimensionFilterGroups?: unknown });
    return new Response(JSON.stringify({ rows: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const today = getSearchConsoleCalendarDate();
    const digest = await generateWeeklyDigest(
      createLifecycle().lifecycle, 'user-a', 'https://example.com/',
      today, undefined, today, undefined, 'web', 'tablet',
    );
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.dataState, 'all');
      assert.deepEqual(request.dimensionFilterGroups, [{
        groupType: 'and',
        filters: [{ dimension: 'device', operator: 'equals', expression: 'TABLET' }],
      }]);
    }
    assert.match(digest, /\*\*Device filter:\*\* Tablet/);
    assert.match(digest, /exclude other devices/i);
    assert.match(digest, /Preliminary snapshot/);
    assert.doesNotMatch(digest, /week-over-week comparisons? were measured/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('weekly digest filters every finalized section by query topic alongside page and device', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ dimensionFilterGroups?: unknown }> = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as { dimensionFilterGroups?: unknown });
    return new Response(JSON.stringify({ rows: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const digest = await generateWeeklyDigest(
      createLifecycle().lifecycle, 'user-a', 'https://example.com/',
      '2026-08-10', undefined, '2026-08-15', '/de/', 'web', 'mobile', 'technical seo',
    );
    assert.equal(requests.length, 5);
    for (const request of requests) {
      assert.deepEqual(request.dimensionFilterGroups, [{
        groupType: 'and',
        filters: [
          { dimension: 'page', operator: 'contains', expression: '/de/' },
          { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
          { dimension: 'query', operator: 'contains', expression: 'technical seo' },
        ],
      }]);
    }
    assert.match(digest, /Query topic filter.*technical seo/i);
    assert.match(digest, /not property-wide/i);
    assert.match(digest, /does not establish a measured zero/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('weekly digest scopes all finalized requests to one country with topic, page and device filters', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ dimensionFilterGroups?: unknown }> = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as { dimensionFilterGroups?: unknown });
    return new Response(JSON.stringify({ rows: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const digest = await generateWeeklyDigest(
      createLifecycle().lifecycle, 'user-a', 'https://example.com/',
      '2026-08-10', undefined, '2026-08-15', '/sl/', 'web', 'mobile', 'seo', 'svn',
    );
    assert.equal(requests.length, 5);
    for (const request of requests) {
      assert.deepEqual(request.dimensionFilterGroups, [{
        groupType: 'and',
        filters: [
          { dimension: 'page', operator: 'contains', expression: '/sl/' },
          { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
          { dimension: 'query', operator: 'contains', expression: 'seo' },
          { dimension: 'country', operator: 'equals', expression: 'SVN' },
        ],
      }]);
    }
    assert.match(digest, /Country filter.*SVN/i);
    assert.match(digest, /not property-wide/i);
    assert.match(digest, /does not establish a measured zero/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('weekly digest applies a country filter to preliminary requests without trend claims', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ dataState?: string; dimensionFilterGroups?: unknown }> = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as { dataState?: string; dimensionFilterGroups?: unknown });
    return new Response(JSON.stringify({ rows: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const today = getSearchConsoleCalendarDate();
    const digest = await generateWeeklyDigest(
      createLifecycle().lifecycle, 'user-a', 'https://example.com/',
      today, undefined, today, undefined, 'web', undefined, undefined, 'deu',
    );
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.dataState, 'all');
      assert.deepEqual(request.dimensionFilterGroups, [{
        groupType: 'and',
        filters: [{ dimension: 'country', operator: 'equals', expression: 'DEU' }],
      }]);
    }
    assert.match(digest, /Country filter.*DEU/i);
    assert.match(digest, /Preliminary snapshot/i);
    assert.doesNotMatch(digest, /## What changed this week|## What to do this week/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('weekly digest honors explicit recent dates as preliminary snapshots without unverified trend advice', async () => {
  const originalFetch = globalThis.fetch;
  const requestedDataStates: Array<string | undefined> = [];
  const requestStartDates: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { dataState?: string; dimensions?: string[]; startDate: string };
    requestedDataStates.push(request.dataState);
    requestStartDates.push(request.startDate);
    const rows = request.dimensions?.[0] === 'query'
      ? [{ keys: ['example query'], clicks: 3, impressions: 30, ctr: 0.1, position: 7 }]
      : request.dimensions?.[0] === 'page'
        ? [{ keys: ['https://example.com/page'], clicks: 3, impressions: 30, ctr: 0.1, position: 7 }]
        : [{ clicks: 12, impressions: 80, ctr: 0.15, position: 8 }];
    return new Response(JSON.stringify({ rows }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const digest = await generateWeeklyDigest(
      createLifecycle().lifecycle, 'user-a', 'https://example.com/', getSearchConsoleCalendarDate(),
    );
    assert.deepEqual(requestedDataStates, Array(3).fill('all'));
    assert.deepEqual([...new Set(requestStartDates)].length, 1);
    assert.match(digest, /preliminary Search Console data/i);
    assert.match(digest, /12 clicks/i);
    assert.match(digest, /80 impressions/i);
    assert.doesNotMatch(digest, /## What changed this week|## What to do this week|% vs last week/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('weekly digest never fabricates zero traffic when recent preliminary rows are missing', async () => {
  const originalFetch = globalThis.fetch;
  const dataStates: Array<string | undefined> = [];
  globalThis.fetch = async (_input, init) => {
    dataStates.push((JSON.parse(String(init?.body)) as { dataState?: string }).dataState);
    return new Response(JSON.stringify({ rows: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const digest = await generateWeeklyDigest(
      createLifecycle().lifecycle, 'user-a', 'https://example.com/', getSearchConsoleCalendarDate(),
    );
    assert.deepEqual(dataStates, Array(3).fill('all'));
    assert.match(digest, /preliminary Search Console data/i);
    assert.match(digest, /missing data is not a measured zero/i);
    assert.doesNotMatch(digest, /0 clicks|0 impressions|## What to do this week/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('weekly digest does not infer branded demand from operator-only query rows', async () => {
  const fixture = createLifecycle();
  const restoreFetch = installDigestAnalyticsMock([
    {
      keys: ['site:example.com'],
      clicks: 0,
      impressions: 40,
      ctr: 0,
      position: 1,
    },
  ]);

  try {
    const digest = await generateWeeklyDigest(
      fixture.lifecycle,
      'user-a',
      'https://example.com/',
      '2026-08-10',
    );

    assert.match(digest, /visible query rows are search-operator checks/i);
    assert.match(digest, /do not prove that your impressions came from branded demand/i);
    assert.match(digest, /Branded\/Non-branded query filter/);
    assert.match(digest, /Search-result impressions this week/);
    assert.doesNotMatch(digest, /people who already know/i);
    assert.doesNotMatch(digest, /Almost all of your search impressions.*branded/i);
    assert.doesNotMatch(digest, /People who saw your site/i);
  } finally {
    restoreFetch();
  }
});

test('weekly digest does not label missing query rows as operator searches', async () => {
  const restoreFetch = installDigestAnalyticsMock([], {
    currentTotals: { clicks: 0, impressions: 40, ctr: 0, position: 9 },
    previousTotals: { clicks: 0, impressions: 35, ctr: 0, position: 10 },
    previousQueryRows: [],
  });
  try {
    const digest = await generateWeeklyDigest(
      createLifecycle().lifecycle, 'user-a', 'https://example.com/', '2026-08-10',
    );
    assert.match(digest, /recorded 40 impressions and zero clicks, but returned no query rows/i);
    assert.doesNotMatch(digest, /visible query rows are search-operator checks|operator-style searches/i);
    assert.match(digest, /review Queries and Pages together/i);
  } finally {
    restoreFetch();
  }
});

test('weekly digest grounds zero-click guidance in Search Console evidence', async () => {
  const fixture = createLifecycle();
  const restoreFetch = installDigestAnalyticsMock([
    {
      keys: ['best trail shoes'],
      clicks: 0,
      impressions: 40,
      ctr: 0,
      position: 8,
    },
  ]);

  try {
    const digest = await generateWeeklyDigest(
      fixture.lifecycle,
      'user-a',
      'https://example.com/',
      '2026-08-10',
    );

    assert.match(digest, /recorded 40 impressions and zero clicks/i);
    assert.match(digest, /not unique people/i);
    assert.match(digest, /same date range/i);
    assert.match(digest, /manual Google search can differ by location, device, and personalization/i);
    assert.doesNotMatch(digest, /The most common reason/i);
    assert.doesNotMatch(digest, /Go to https:\/\/google\.com/i);
  } finally {
    restoreFetch();
  }
});

test('weekly digest does not turn average position into a literal rank or results page', async () => {
  const fixture = createLifecycle();
  const restoreFetch = installDigestAnalyticsMock(
    [
      {
        keys: ['trail running shoes'],
        clicks: 8,
        impressions: 100,
        ctr: 0.08,
        position: 12.4,
      },
    ],
    {
      currentTotals: {
        clicks: 8,
        impressions: 100,
        ctr: 0.08,
        position: 12.4,
      },
      previousTotals: {
        clicks: 2,
        impressions: 60,
        ctr: 0.033,
        position: 14,
      },
      previousQueryRows: [
        {
          keys: ['trail running shoes'],
          clicks: 2,
          impressions: 60,
          ctr: 0.033,
          position: 14,
        },
      ],
    },
  );

  try {
    const digest = await generateWeeklyDigest(
      fixture.lifecycle,
      'user-a',
      'https://example.com/',
      '2026-08-10',
    );

    assert.match(digest, /average Search Console position of 12\.4/i);
    assert.match(digest, /not a literal current rank or page number/i);
    assert.match(digest, /Average Search Console position:/);
    assert.doesNotMatch(digest, /ranking on page 2/i);
    assert.doesNotMatch(digest, /page 1 get ~10x more clicks/i);
    assert.doesNotMatch(digest, /Currently ranking #/i);
  } finally {
    restoreFetch();
  }
});

test('weekly digest does not assign a cause from sitewide average-position movement alone', async () => {
  const fixture = createLifecycle();
  const restoreFetch = installDigestAnalyticsMock([], {
    currentTotals: {
      clicks: 20,
      impressions: 200,
      ctr: 0.1,
      position: 6,
    },
    previousTotals: {
      clicks: 20,
      impressions: 200,
      ctr: 0.1,
      position: 10,
    },
  });

  try {
    const digest = await generateWeeklyDigest(
      fixture.lifecycle,
      'user-a',
      'https://example.com/',
      '2026-08-10',
    );

    assert.match(digest, /average Search Console position improved by 4\.0/i);
    assert.match(digest, /does not by itself prove/i);
    assert.match(digest, /Compare Queries and Pages/i);
    assert.doesNotMatch(digest, /Google noticed something positive/i);
    assert.doesNotMatch(digest, /Whatever you did, do more of it/i);
    assert.doesNotMatch(digest, /Something you did is working/i);
  } finally {
    restoreFetch();
  }
});

test('weekly digest treats a query click drop as an observation, not a proven cause', async () => {
  const fixture = createLifecycle();
  const restoreFetch = installDigestAnalyticsMock(
    [
      {
        keys: ['example query'],
        clicks: 2,
        impressions: 120,
        ctr: 0.0167,
        position: 12,
      },
    ],
    {
      currentTotals: {
        clicks: 20,
        impressions: 500,
        ctr: 0.04,
        position: 12,
      },
      previousTotals: {
        clicks: 35,
        impressions: 520,
        ctr: 0.067,
        position: 12,
      },
      previousQueryRows: [
        {
          keys: ['example query'],
          clicks: 15,
          impressions: 150,
          ctr: 0.1,
          position: 10,
        },
      ],
    },
  );

  try {
    const digest = await generateWeeklyDigest(
      fixture.lifecycle,
      'user-a',
      'https://example.com/',
      '2026-08-10',
    );

    assert.match(digest, /Search Console recorded 15 clicks.*2 this week/i);
    assert.match(digest, /does not establish whether the cause/i);
    assert.match(digest, /treat them as hypotheses, not proven causes/i);
    assert.doesNotMatch(digest, /usually means either/i);
    assert.doesNotMatch(digest, /competitor outranked you/i);
  } finally {
    restoreFetch();
  }
});

test('weekly digest renders provider queries and page paths as plain Markdown text', async () => {
  const query = 'picks **hot** [free](https://fake.invalid)\n## fake heading';
  const restoreFetch = installDigestAnalyticsMock(
    [{ keys: [query], clicks: 20, impressions: 200, ctr: 0.1, position: 15 }],
    {
      currentTotals: { clicks: 25, impressions: 250, ctr: 0.1, position: 15 },
      previousTotals: { clicks: 10, impressions: 200, ctr: 0.05, position: 17 },
      previousQueryRows: [
        { keys: [query], clicks: 2, impressions: 120, ctr: 0.0167, position: 17 },
      ],
      currentPageUrl: 'https://example.com/page**bold**',
    },
  );
  try {
    const digest = await generateWeeklyDigest(
      createLifecycle().lifecycle, 'user-a', 'https://example.com/', '2026-08-10',
    );
    assert.match(digest, /Searches gaining traction/);
    assert.ok(digest.includes('picks \\*\\*hot\\*\\*'));
    assert.ok(digest.includes('\\[free\\]\\('));
    assert.ok(digest.includes('/page\\*\\*bold\\*\\*'));
    assert.doesNotMatch(digest, /\n## fake heading/);
    assert.doesNotMatch(digest, /\[free\]\(https:\/\/fake\.invalid\)/);
  } finally {
    restoreFetch();
  }
});

test('weekly digest distinguishes the same path across different hosts', async () => {
  const restoreFetch = installDigestAnalyticsMock([], {
    currentPageRows: [
      { keys: ['https://www.example.com/pricing'], clicks: 7, impressions: 70, ctr: 0.1, position: 6 },
      { keys: ['https://fr.example.com/pricing'], clicks: 5, impressions: 50, ctr: 0.1, position: 7 },
      { keys: ['https://www.example.com/blog'], clicks: 4, impressions: 40, ctr: 0.1, position: 8 },
    ],
  });
  try {
    const digest = await generateWeeklyDigest(
      createLifecycle().lifecycle, 'user-a', 'sc-domain:example.com', '2026-08-10',
    );
    assert.ok(digest.includes('**https://www\\.example\\.com/pricing**'));
    assert.ok(digest.includes('**https://fr\\.example\\.com/pricing**'));
    assert.match(digest, /\*\*\/blog\*\*/);
    assert.doesNotMatch(digest, /\*\*\/pricing\*\*/);
  } finally {
    restoreFetch();
  }
});

test('weekly digest does not infer zero page impressions from an empty Pages response', async () => {
  const restoreFetch = installDigestAnalyticsMock([], {
    currentTotals: { clicks: 0, impressions: 40, ctr: 0, position: 8 },
    currentPageRows: [],
  });
  try {
    const digest = await generateWeeklyDigest(
      createLifecycle().lifecycle, 'user-a', 'https://example.com/', '2026-08-10',
    );
    assert.match(digest, /No page-level rows were returned for this period/i);
    assert.match(digest, /40/);
    assert.doesNotMatch(digest, /No pages had impressions this week/i);
  } finally {
    restoreFetch();
  }
});

test('weekly digest does not infer query distribution from missing query rows on growth', async () => {
  const restoreFetch = installDigestAnalyticsMock([], {
    currentTotals: { clicks: 2, impressions: 40, ctr: 0.05, position: 8 },
    previousTotals: { clicks: 2, impressions: 10, ctr: 0.2, position: 8 },
    previousQueryRows: [],
  });
  try {
    const digest = await generateWeeklyDigest(
      createLifecycle().lifecycle, 'user-a', 'https://example.com/', '2026-08-10',
    );
    assert.match(digest, /search impressions this week \(\+300%\)/i);
    assert.match(digest, /aggregate does not identify which queries drove this change/i);
    assert.doesNotMatch(digest, /spread across lots of small queries|no single query stood out/i);
  } finally {
    restoreFetch();
  }
});

test('weekly digest does not infer query distribution from missing query rows on decline', async () => {
  const restoreFetch = installDigestAnalyticsMock([], {
    currentTotals: { clicks: 2, impressions: 10, ctr: 0.2, position: 8 },
    previousTotals: { clicks: 2, impressions: 40, ctr: 0.05, position: 8 },
    previousQueryRows: [],
  });
  try {
    const digest = await generateWeeklyDigest(
      createLifecycle().lifecycle, 'user-a', 'https://example.com/', '2026-08-10',
    );
    assert.match(digest, /fewer search impressions this week \(-75%\)/i);
    assert.match(digest, /aggregate does not identify which queries drove this change/i);
    assert.doesNotMatch(digest, /spread across many queries|no single query stood out/i);
  } finally {
    restoreFetch();
  }
});

test('weekly digest does not treat a query missing from one bounded response as zero', async () => {
  const fixture = createLifecycle();
  const restoreFetch = installDigestAnalyticsMock(
    [
      {
        keys: ['current-only query'],
        clicks: 20,
        impressions: 200,
        ctr: 0.1,
        position: 8,
      },
    ],
    {
      currentTotals: {
        clicks: 20,
        impressions: 200,
        ctr: 0.1,
        position: 8,
      },
      previousTotals: {
        clicks: 20,
        impressions: 200,
        ctr: 0.1,
        position: 8,
      },
      previousQueryRows: [
        {
          keys: ['previous-only query'],
          clicks: 20,
          impressions: 200,
          ctr: 0.1,
          position: 8,
        },
      ],
    },
  );

  try {
    const digest = await generateWeeklyDigest(
      fixture.lifecycle,
      'user-a',
      'https://example.com/',
      '2026-08-10',
    );

    assert.match(digest, /missing from one bounded response is not treated as zero/i);
    assert.doesNotMatch(digest, /Searches gaining traction/i);
    assert.doesNotMatch(digest, /Searches losing traction/i);
    assert.doesNotMatch(digest, /New searches showing your site/i);
    assert.doesNotMatch(digest, /current-only query.*was 0/i);
    assert.doesNotMatch(digest, /previous-only query.*0 clicks this week/i);
  } finally {
    restoreFetch();
  }
});

test('weekly digest reports low-to-high returning queries as gains, not new searches', async () => {
  const restoreFetch = installDigestAnalyticsMock([
    { keys: ['returning query'], clicks: 0, impressions: 24, ctr: 0, position: 9 },
  ], {
    currentTotals: { clicks: 0, impressions: 24, ctr: 0, position: 9 },
    previousTotals: { clicks: 0, impressions: 3, ctr: 0, position: 10 },
    previousQueryRows: [
      { keys: ['returning query'], clicks: 0, impressions: 3, ctr: 0, position: 10 },
    ],
  });
  try {
    const digest = await generateWeeklyDigest(
      createLifecycle().lifecycle, 'user-a', 'https://example.com/', '2026-08-10',
    );
    assert.match(digest, /Queries gaining impressions without clicks/i);
    assert.match(digest, /returning query.*24 impressions this week \(was 3 last week\)/i);
    assert.doesNotMatch(digest, /New searches showing your site/i);
  } finally {
    restoreFetch();
  }
});

test('weekly digest avoids unsupported publishing and indexing-speed prescriptions', async () => {
  const fixture = createLifecycle();
  const restoreFetch = installDigestAnalyticsMock(
    [
      {
        keys: ['steady query'],
        clicks: 1,
        impressions: 20,
        ctr: 0.05,
        position: 10,
      },
    ],
    {
      currentTotals: {
        clicks: 13,
        impressions: 210,
        ctr: 0.0619,
        position: 10,
      },
      previousTotals: {
        clicks: 10,
        impressions: 200,
        ctr: 0.05,
        position: 10,
      },
      previousQueryRows: [
        {
          keys: ['steady query'],
          clicks: 1,
          impressions: 20,
          ctr: 0.05,
          position: 10,
        },
      ],
    },
  );

  try {
    const digest = await generateWeeklyDigest(
      fixture.lifecycle,
      'user-a',
      'https://example.com/',
      '2026-08-10',
    );

    assert.match(digest, /Review one evidence-backed search opportunity/i);
    assert.match(digest, /Your clicks changed sharply/i);
    assert.match(digest, /not as a guarantee of faster indexing/i);
    assert.doesNotMatch(digest, /single biggest predictor/i);
    assert.doesNotMatch(digest, /click rate changed sharply/i);
  } finally {
    restoreFetch();
  }
});

test('weekly digest does not turn a zero site-level baseline into 0% growth', async () => {
  const fixture = createLifecycle();
  const restoreFetch = installDigestAnalyticsMock([], {
    currentTotals: {
      clicks: 5,
      impressions: 100,
      ctr: 0.05,
      position: 12,
    },
    previousTotals: {
      clicks: 0,
      impressions: 0,
      ctr: 0,
      position: 0,
    },
  });

  try {
    const digest = await generateWeeklyDigest(
      fixture.lifecycle,
      'user-a',
      'https://example.com/',
      '2026-08-10',
    );

    assert.match(digest, /increased from a measured zero last week \(percentage change unavailable\)/i);
    assert.doesNotMatch(digest, /no data last week/i);
    assert.match(digest, /percentage change is unavailable from a zero baseline/i);
    assert.doesNotMatch(digest, /impressions.*\+0%/i);
    assert.doesNotMatch(digest, /clicks.*\+0%/i);
  } finally {
    restoreFetch();
  }
});
