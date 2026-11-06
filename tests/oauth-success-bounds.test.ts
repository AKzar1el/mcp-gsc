// Offline regression coverage for bounded Google OAuth provider responses.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exchangeCodeForTokens,
  refreshAccessToken,
  fetchGoogleUserInfo,
  GoogleRefreshTokenRevokedError,
} from '../src/google';

const PADDING = 'x'.repeat(3 * 1024 * 1024);
const LIMIT = 2 * 1024 * 1024;
const limitError = /byte limit|too large|exceeds/i;

async function withFetch<T>(body: unknown, work: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
  try {
    return await work();
  } finally {
    globalThis.fetch = previous;
  }
}

test('normal OAuth exchange preserves validated token fields', async () => {
  const result = await withFetch({
    access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600,
    token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/webmasters.readonly',
  }, () => exchangeCodeForTokens('fake-code', 'fake-id', 'fake-secret', 'https://example.org/callback'));
  assert.equal(result.access_token, 'fake-access');
  assert.equal(result.refresh_token, 'fake-refresh');
});

test('OAuth success JSON at the exact 2 MiB byte limit is accepted', async () => {
  const payload = { access_token: 'fake-access', refresh_token: 'fake-refresh',
    expires_in: 3600, token_type: 'Bearer', scope: 'scope', padding: '' };
  payload.padding = 'x'.repeat(LIMIT - JSON.stringify(payload).length);
  const result = await withFetch(payload,
    () => exchangeCodeForTokens('fake-code', 'fake-id', 'fake-secret', 'https://example.org/callback'));
  assert.equal(result.access_token, 'fake-access');
});

test('oversized successful OAuth exchange is bounded before parsing', async () => {
  await assert.rejects(
    withFetch({ access_token: 'fake', refresh_token: 'fake', expires_in: 3600,
      token_type: 'Bearer', scope: 'scope', padding: PADDING },
    () => exchangeCodeForTokens('fake-code', 'fake-id', 'fake-secret', 'https://example.org/callback')),
    limitError,
  );
});

test('oversized successful token refresh is bounded before parsing', async () => {
  await assert.rejects(
    withFetch({ access_token: 'fake', expires_in: 3600, padding: PADDING },
      () => refreshAccessToken('fake-refresh', 'fake-id', 'fake-secret')),
    limitError,
  );
});

test('oversized successful userinfo payload is bounded before parsing', async () => {
  await assert.rejects(
    withFetch({ id: 'fake-id', email: 'example@example.org', padding: PADDING },
      () => fetchGoogleUserInfo('fake-access')),
    limitError,
  );
});

test('ordinary refresh and userinfo retain validated results', async () => {
  const tokens = await withFetch({ access_token: 'fake-new-access', expires_in: 1800 },
    () => refreshAccessToken('fake-refresh', 'fake-id', 'fake-secret'));
  assert.deepEqual(tokens, { access_token: 'fake-new-access', expires_in: 1800 });
  const profile = await withFetch({ id: 'user-123', email: 'example@example.org' },
    () => fetchGoogleUserInfo('fake-new-access'));
  assert.deepEqual(profile, { id: 'user-123', email: 'example@example.org' });
});

test('refresh invalid_grant remains a distinct reauthentication error', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  try {
    await assert.rejects(() => refreshAccessToken('fake-refresh', 'fake-id', 'fake-secret'),
      (error: unknown) => error instanceof GoogleRefreshTokenRevokedError);
  } finally {
    globalThis.fetch = original;
  }
});

test('advertised oversized OAuth response cancels before reading it', async () => {
  let cancelled = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{}')); },
    cancel() { cancelled = true; },
  }), { status: 200, headers: { 'content-length': String(3 * 1024 * 1024) } });
  try {
    await assert.rejects(() => fetchGoogleUserInfo('fake-access'), /Google OAuth response exceeds the 2 MiB byte limit/);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('no Content-Length oversized streamed OAuth response is cancelled', async () => {
  let cancelled = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array(1024 * 1024 + 1));
    },
    cancel() { cancelled = true; },
  }), { status: 200 });
  try {
    await assert.rejects(() => refreshAccessToken('fake-refresh', 'fake-id', 'fake-secret'), limitError);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('stream cancellation failure cannot mask the OAuth size-limit error', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { throw new Error('synthetic cancellation failure'); },
  }), { status: 200 });
  try {
    await assert.rejects(() => fetchGoogleUserInfo('fake-access'),
      /Google OAuth response exceeds the 2 MiB byte limit/);
  } finally {
    globalThis.fetch = original;
  }
});

test('invalid OAuth tenant account ID remains rejected', async () => {
  await assert.rejects(withFetch({ id: '', email: 'example@example.org' },
    () => fetchGoogleUserInfo('fake-access')), /valid account ID or email/);
});
