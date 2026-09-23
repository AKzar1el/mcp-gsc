import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launcherPath = resolve(repoRoot, 'scripts', 'glama-start.mjs');

function runLauncherWithTokenEncryptionKey(tokenEncryptionKey) {
  return spawnSync(process.execPath, [launcherPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GOOGLE_CLIENT_ID: 'launcher-test-client-id',
      GOOGLE_CLIENT_SECRET: 'launcher-test-client-secret',
      TOKEN_ENCRYPTION_KEY: tokenEncryptionKey,
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

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
    assert.doesNotMatch(result.stderr, new RegExp(tokenEncryptionKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(result.stderr, /Local MCP endpoint:/);
    assert.equal(result.error, undefined);
  }
});
