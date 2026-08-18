const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

export interface PendingAuthRequest {
  claudeAuthRequest: unknown;
  created_at: number;
  expires_at: number;
}

interface PendingAuthStateEnv {
  PENDING_AUTH_STATE: DurableObjectNamespace;
}

interface PendingAuthStateStub {
  store(claudeAuthRequest: unknown): Promise<void>;
  consume(): Promise<PendingAuthRequest | null>;
}

/**
 * One instance is addressed by one OAuth nonce. Its storage transaction makes
 * consumption a single read-check-delete operation, even for concurrent
 * callbacks routed to the same Durable Object.
 */
export class PendingAuthState {
  constructor(
    private readonly state: DurableObjectState,
    _env: unknown,
    private readonly now: () => number = Date.now,
  ) {}

  async store(claudeAuthRequest: unknown): Promise<void> {
    const created_at = this.now();
    const record: PendingAuthRequest = {
      claudeAuthRequest,
      created_at,
      expires_at: created_at + PENDING_AUTH_TTL_MS,
    };

    await Promise.all([
      this.state.storage.put('pending', record),
      this.state.storage.setAlarm(record.expires_at),
    ]);
  }

  async consume(): Promise<PendingAuthRequest | null> {
    return this.state.storage.transaction(async (txn) => {
      const record = await txn.get<PendingAuthRequest>('pending');
      if (!record) return null;

      await txn.delete('pending');
      await txn.deleteAlarm();

      return record.expires_at > this.now() ? record : null;
    });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

function getPendingAuthStateStub(
  env: PendingAuthStateEnv,
  nonce: string,
): PendingAuthStateStub {
  return env.PENDING_AUTH_STATE.get(
    env.PENDING_AUTH_STATE.idFromName(nonce),
  ) as unknown as PendingAuthStateStub;
}

export async function stashPendingAuth(
  env: PendingAuthStateEnv,
  nonce: string,
  claudeAuthRequest: unknown,
): Promise<void> {
  await getPendingAuthStateStub(env, nonce).store(claudeAuthRequest);
}

export async function consumePendingAuth(
  env: PendingAuthStateEnv,
  nonce: string,
): Promise<PendingAuthRequest | null> {
  return getPendingAuthStateStub(env, nonce).consume();
}
