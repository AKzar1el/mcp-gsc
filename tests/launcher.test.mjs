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

test('npm launcher rejects malformed TOKEN_ENCRYPTION_KEY before starting Wrangler', () => {
  for (const tokenEncryptionKey of [
    'not-base64',
    Buffer.alloc(31, 1).toString('base64'),
    Buffer.alloc(33, 1).toString('base64'),
  ]) {
    const result = runLauncherWithTokenEncryptionKey(tokenEncryptionKey);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid TOKEN_ENCRYPTION_KEY/);
    assert.match(result.stderr, /base64-encoded 32-byte \(256-bit\) AES key/);
    assertIncludesCrossPlatformKeyGenerationHint(result.stderr);
    assert.doesNotMatch(result.stderr, new RegExp(tokenEncryptionKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(result.stderr, /Local MCP endpoint:/);
    assert.equal(result.error, undefined);
  }
});

test('npm launcher rejects an unexpected bind address before launching Wrangler', () => {
  const result = runLauncherWithEnvironment({ MCP_GSC_BIND_IP: '192.0.2.1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid MCP_GSC_BIND_IP/);
  assert.doesNotMatch(result.stderr, /Local MCP endpoint:/);
  assert.equal(result.error, undefined);
});

test('Docker binding is explicitly container-scoped while npm defaults to loopback', () => {
  const launcher = readFileSync(launcherPath, 'utf8');
  const dockerfile = readFileSync(resolve(repoRoot, 'Dockerfile'), 'utf8');
  assert.match(launcher, /MCP_GSC_BIND_IP\?\.trim\(\) \|\| '127\.0\.0\.1'/);
  assert.match(launcher, /'--ip',\s*bindIp,/);
  assert.match(dockerfile, /ENV MCP_GSC_BIND_IP=0\.0\.0\.0/);
});