import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launcherPath = resolve(repoRoot, 'scripts', 'glama-start.mjs');

function runLauncherWithEnvironment(overrides = {}) {
  const env = {
    ...process.env,
    GOOGLE_CLIENT_ID: 'launcher-test-client-id',
    GOOGLE_CLIENT_SECRET: 'launcher-test-client-secret',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    MCP_GSC_BIND_IP: '127.0.0.1',
    // Stop after key/bind validation, even if a malformed key is accepted.
    // No test should reach endpoint logging or start Wrangler.
    PORT: '0',
    ...overrides,
  };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name];
  }
  return spawnSync(process.execPath, [launcherPath], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function runLauncherWithTokenEncryptionKey(tokenEncryptionKey) {
  return runLauncherWithEnvironment({ TOKEN_ENCRYPTION_KEY: tokenEncryptionKey });
}

function assertIncludesCrossPlatformKeyGenerationHint(stderr) {
  assert.match(stderr, /Generate one with: node -e/);
  assert.match(stderr, /randomBytes\(32\)/);
  assert.match(stderr, /toString\('base64'\)/);
}

test('npm launcher explains how to generate a missing TOKEN_ENCRYPTION_KEY', () => {
  const result = runLauncherWithEnvironment({ TOKEN_ENCRYPTION_KEY: undefined });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing required environment variables: TOKEN_ENCRYPTION_KEY/);
  assertIncludesCrossPlatformKeyGenerationHint(result.stderr);
  assert.doesNotMatch(result.stderr, /Local MCP endpoint:/);
  assert.equal(result.error, undefined);
});

test('npm launcher rejects missing or blank required variables before endpoint logging', () => {
  for (const name of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY']) {
    for (const value of [undefined, '', ' \t\n']) {
      const result = runLauncherWithEnvironment({ [name]: value });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(`Missing required environment variables: ${name}`));
      assert.doesNotMatch(result.stderr, /Local MCP endpoint:|Google OAuth redirect URI:/);
    }
  }
});

test('npm launcher rejects malformed TOKEN_ENCRYPTION_KEY before starting Wrangler', () => {
  const canonicalKey = Buffer.alloc(32, 1).toString('base64');
  for (const tokenEncryptionKey of [
    'not-base64',
    Buffer.alloc(31, 1).toString('base64'),
    Buffer.alloc(33, 1).toString('base64'),
    canonicalKey.slice(0, -1),
    `${canonicalKey}=`,
    `=${canonicalKey.slice(1)}`,
    `${canonicalKey.slice(0, 10)}!${canonicalKey.slice(11)}`,
    ` ${canonicalKey}`,
    `${canonicalKey} `,
    `${canonicalKey}\n`,
    `${canonicalKey.slice(0, 10)}\n${canonicalKey.slice(10)}`,
    Buffer.alloc(32, 255).toString('base64url'),
  ]) {
    const result = runLauncherWithTokenEncryptionKey(tokenEncryptionKey);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid TOKEN_ENCRYPTION_KEY/);
    assert.match(result.stderr, /base64-encoded 32-byte \(256-bit\) AES key/);
    assertIncludesCrossPlatformKeyGenerationHint(result.stderr);
    assert.doesNotMatch(result.stderr, new RegExp(tokenEncryptionKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(result.stderr, /Local MCP endpoint:/);
    assert.doesNotMatch(result.stderr, /Google OAuth redirect URI:/);
    assert.equal(result.error, undefined);
  }
});

test('npm launcher rejects every nonzero unused base64 padding-bit variant', () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (const fill of [0, 1, 254, 255]) {
    const canonicalKey = Buffer.alloc(32, fill).toString('base64');
    const lastSextet = alphabet.indexOf(canonicalKey.at(-2));
    for (const unusedBits of [1, 2, 3]) {
      const ambiguousKey = `${canonicalKey.slice(0, -2)}${alphabet[lastSextet + unusedBits]}=`;
      // Node's permissive decoder accepts these aliases of the same 32 bytes.
      assert.deepEqual(Buffer.from(ambiguousKey, 'base64'), Buffer.from(canonicalKey, 'base64'));

      const result = runLauncherWithTokenEncryptionKey(ambiguousKey);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Invalid TOKEN_ENCRYPTION_KEY/);
      assertIncludesCrossPlatformKeyGenerationHint(result.stderr);
      assert.equal(result.stderr.includes(ambiguousKey), false);
      assert.doesNotMatch(result.stderr, /Local MCP endpoint:|Google OAuth redirect URI:/);
    }
  }
});

test('npm launcher accepts canonical 32-byte base64 keys through key and bind validation', () => {
  for (const fill of [0, 1, 254, 255]) {
    for (const bindIp of [undefined, '127.0.0.1', '0.0.0.0']) {
      const result = runLauncherWithEnvironment({
        TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, fill).toString('base64'),
        MCP_GSC_BIND_IP: bindIp,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      // The invalid test port proves key/bind validation passed without a launch.
      assert.match(result.stderr, /Invalid PORT/);
      assert.doesNotMatch(result.stderr, /Invalid TOKEN_ENCRYPTION_KEY|Invalid MCP_GSC_BIND_IP/);
      assert.doesNotMatch(result.stderr, /Local MCP endpoint:|Google OAuth redirect URI:/);
    }
  }
});

test('npm launcher rejects an unexpected bind address before launching Wrangler', () => {
  const result = runLauncherWithEnvironment({ MCP_GSC_BIND_IP: '192.0.2.1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid MCP_GSC_BIND_IP/);
  assert.doesNotMatch(result.stderr, /Local MCP endpoint:/);
  assert.equal(result.error, undefined);
});

test('npm launcher refuses invalid PORT before exposing an endpoint or launching Wrangler', () => {
  for (const invalidPort of [
    '0', '-1', '65536', '1e3', '8080/path', '8080;--ip=0.0.0.0', '1.5',
  ]) {
    const result = runLauncherWithEnvironment({ PORT: invalidPort });
    assert.equal(result.status, 1, invalidPort);
    assert.match(result.stderr, /Invalid PORT: expected a decimal TCP port from 1 to 65535/);
    assert.doesNotMatch(result.stderr, /Local MCP endpoint:/);
    assert.doesNotMatch(result.stderr, /Google OAuth redirect URI:/);
    assert.equal(result.error, undefined);
  }
});

test('Docker binding is explicitly container-scoped while npm defaults to loopback', () => {
  const launcher = readFileSync(launcherPath, 'utf8');
  const dockerfile = readFileSync(resolve(repoRoot, 'Dockerfile'), 'utf8');
  assert.match(launcher, /MCP_GSC_BIND_IP\?\.trim\(\) \|\| '127\.0\.0\.1'/);
  assert.match(launcher, /'--ip',\s*bindIp,/);
  assert.match(dockerfile, /ENV MCP_GSC_BIND_IP=0\.0\.0\.0/);
});
