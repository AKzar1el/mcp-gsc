import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GoogleAccessTokenLifecycle,
  type AccessTokenLifecycleDependencies,
  type GoogleAccessTokenEnv,
} from '../src/access-token-lifecycle';
import { generateWeeklyDigest } from '../src/digest';
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
  let deleteCalls = 0;
  const dependencies: Partial<AccessTokenLifecycleDependencies> = {
    getDecryptedRefreshToken: async () => 'refresh-token',
    refreshAccessToken: async () => {
      refreshCalls += 1;
      return { access_token: `access-token-${refreshCalls}`, expires_in: 3_600 };
    },
    deleteUser: async () => {
      deleteCalls += 1;
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
    get deleteCalls() {
      return deleteCalls;
    },
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

test('GoogleAccessTokenLifecycle deletes credentials only for definitive invalid_grant', async () => {
  const fixture = createLifecycle({
    refreshAccessToken: async () => {
      throw new GoogleRefreshTokenRevokedError();
    },
  });

  await assert.rejects(
    () => fixture.lifecycle.getAccessToken('user-a'),
    GoogleRefreshTokenRevokedError,
  );
  assert.equal(fixture.deleteCalls, 1);
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
  assert.equal(fixture.deleteCalls, 0);
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
    assert.equal(fixture.refreshCalls, 1);
    assert.deepEqual(authHeaders, Array(5).fill('Bearer access-token-1'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
