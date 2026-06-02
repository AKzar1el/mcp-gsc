import { encryptToken, decryptToken } from './crypto';

interface StorageEnv {
  OAUTH_KV: KVNamespace;
  USER_KV: KVNamespace;
  TOKEN_ENCRYPTION_KEY: string;
}

const PENDING_TTL_SECONDS = 600;

export interface PendingAuthRequest {
  claudeAuthRequest: unknown;
  created_at: number;
}

export async function stashPendingAuth(
  env: StorageEnv,
  nonce: string,
  claudeAuthRequest: unknown,
): Promise<void> {
  const record: PendingAuthRequest = {
    claudeAuthRequest,
    created_at: Date.now(),
  };
  await env.OAUTH_KV.put(`pending:${nonce}`, JSON.stringify(record), {
    expirationTtl: PENDING_TTL_SECONDS,
  });
}

export async function popPendingAuth(
  env: StorageEnv,
  nonce: string,
): Promise<PendingAuthRequest | null> {
  const key = `pending:${nonce}`;
  const raw = await env.OAUTH_KV.get(key);
  if (!raw) return null;
  await env.OAUTH_KV.delete(key);
  return JSON.parse(raw) as PendingAuthRequest;
}

export interface UserRecord {
  email: string;
  encrypted_refresh_token: string;
  iv: string;
  created_at: number;
  updated_at: number;
}

export async function saveUser(
  env: StorageEnv,
  googleId: string,
  email: string,
  refreshToken: string,
): Promise<void> {
  const { ciphertext, iv } = await encryptToken(
    refreshToken,
    env.TOKEN_ENCRYPTION_KEY,
  );
  const existing = await getUser(env, googleId);
  const now = Date.now();
  const record: UserRecord = {
    email,
    encrypted_refresh_token: ciphertext,
    iv,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  await env.USER_KV.put(`user:${googleId}`, JSON.stringify(record));
}

export async function getUser(
  env: StorageEnv,
  googleId: string,
): Promise<UserRecord | null> {
  const raw = await env.USER_KV.get(`user:${googleId}`);
  if (!raw) return null;
  return JSON.parse(raw) as UserRecord;
}

export async function deleteUser(
  env: StorageEnv,
  googleId: string,
): Promise<void> {
  await env.USER_KV.delete(`user:${googleId}`);
}

export async function getDecryptedRefreshToken(
  env: StorageEnv,
  googleId: string,
): Promise<string | null> {
  const user = await getUser(env, googleId);
  if (!user) return null;
  return await decryptToken(
    user.encrypted_refresh_token,
    user.iv,
    env.TOKEN_ENCRYPTION_KEY,
  );
}
