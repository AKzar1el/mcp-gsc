import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PendingAuthState } from '../src/pending-auth-state';

class InMemoryTransactionalStorage {
  private values = new Map<string, unknown>();
  private transactionTail = Promise.resolve();
  alarmAt: number | null = null;

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarmAt = scheduledTime;
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
    this.alarmAt = null;
  }

  async transaction<T>(
    closure: (transaction: {
      get<T>(key: string): Promise<T | undefined>;
      delete(key: string): Promise<boolean>;
      deleteAlarm(): Promise<void>;
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
        delete: async (key: string) => this.values.delete(key),
        deleteAlarm: async () => {
          this.alarmAt = null;
        },
      });
    } finally {
      release();
    }
  }
}

function createPendingAuthState(now: () => number) {
  const storage = new InMemoryTransactionalStorage();
  const state = { storage } as unknown as DurableObjectState;
  return { storage, pendingAuthState: new PendingAuthState(state, undefined, now) };
}

test('PendingAuthState consumes a nonce exactly once under concurrent attempts', async () => {
  const { pendingAuthState } = createPendingAuthState(() => 1_000);
  const request = { client_id: 'client', redirect_uri: 'https://client.example/callback' };
  await pendingAuthState.store(request);

  const results = await Promise.all([
    pendingAuthState.consume(),
    pendingAuthState.consume(),
  ]);
  const consumed = results.filter((result) => result !== null);

  assert.equal(consumed.length, 1);
  assert.deepEqual(consumed[0]?.claudeAuthRequest, request);
});

test('PendingAuthState returns null for a missing nonce', async () => {
  const { pendingAuthState } = createPendingAuthState(() => 1_000);
  assert.equal(await pendingAuthState.consume(), null);
});

test('PendingAuthState rejects expired state and clears its scheduled cleanup', async () => {
  let now = 1_000;
  const { storage, pendingAuthState } = createPendingAuthState(() => now);
  await pendingAuthState.store({ client_id: 'client' });
  now += 10 * 60 * 1000;

  assert.equal(await pendingAuthState.consume(), null);
  assert.equal(storage.alarmAt, null);
});

test('PendingAuthState returns a stored request once and then returns null', async () => {
  const { pendingAuthState } = createPendingAuthState(() => 1_000);
  const request = { client_id: 'client', scope: 'openid' };
  await pendingAuthState.store(request);

  const first = await pendingAuthState.consume();
  assert.deepEqual(first?.claudeAuthRequest, request);
  assert.equal(await pendingAuthState.consume(), null);
});
