import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

function readJson(relativePath: string) {
  return JSON.parse(readFileSync(resolve(projectRoot, relativePath), 'utf8'));
}

function sortedToolNames(metadata: { tools: Array<{ name: string }> }, label: string) {
  const names = metadata.tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, `${label} contains duplicate tool names`);
  return names.toSorted();
}

const packageJson = readJson('package.json');
const serverJson = readJson('server.json');
const manifestJson = readJson('manifest.json');
const claudePlugin = readJson('.claude-plugin/plugin.json');
const cursorPlugin = readJson('.cursor-plugin/plugin.json');

test('release versions remain aligned across machine-readable metadata', () => {
  const expectedVersion = packageJson.version;

  assert.equal(serverJson.version, expectedVersion, 'server.json version must match package.json');
  assert.equal(manifestJson.version, expectedVersion, 'manifest.json version must match package.json');
  assert.equal(claudePlugin.version, expectedVersion, 'Claude plugin version must match package.json');
  assert.equal(cursorPlugin.version, expectedVersion, 'Cursor plugin version must match package.json');
});

test('registry package identity remains aligned', () => {
  assert.equal(
    serverJson.name,
    packageJson.mcpName,
    'server.json name must match package.json mcpName',
  );
});

test('published tool catalogs remain aligned', () => {
  const serverToolNames = sortedToolNames(serverJson, 'server.json');

  assert.deepEqual(
    sortedToolNames(manifestJson, 'manifest.json'),
    serverToolNames,
    'manifest.json tools must match server.json tools',
  );
});
