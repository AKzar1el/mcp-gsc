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
const indexSource = readFileSync(resolve(projectRoot, 'src/index.ts'), 'utf8');
const npmLauncherSource = readFileSync(resolve(projectRoot, 'scripts/glama-start.mjs'), 'utf8');
const readmeSource = readFileSync(resolve(projectRoot, 'README.md'), 'utf8');
const setupSource = readFileSync(resolve(projectRoot, 'SETUP.md'), 'utf8');
const llmsInstallSource = readFileSync(resolve(projectRoot, 'llms-install.md'), 'utf8');

test('package release versions remain aligned across machine-readable metadata', () => {
  const expectedVersion = packageJson.version;

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

  const npmPackage = serverJson.packages.find(
    (entry: { registryType?: string; identifier?: string }) =>
      entry.registryType === 'npm' && entry.identifier === packageJson.name,
  );

  assert.ok(npmPackage, 'server.json must publish the package.json npm package');
  assert.equal(
    npmPackage.version,
    packageJson.version,
    'server.json npm package version must match package.json',
  );
  assert.equal(
    npmPackage.runtimeHint,
    'npx',
    'server.json npm package must identify the npx launcher runtime',
  );
  assert.deepEqual(
    npmPackage.transport,
    { type: 'streamable-http', url: 'http://127.0.0.1:{PORT}/mcp' },
    'server.json npm transport must match the launcher\'s local HTTP behavior',
  );

  const environmentVariables = new Map(
    npmPackage.environmentVariables.map((entry: { name: string }) => [entry.name, entry]),
  );
  assert.equal(environmentVariables.get('PORT')?.default, '8080');
  assert.equal(environmentVariables.get('GOOGLE_CLIENT_ID')?.isRequired, true);
  assert.equal(environmentVariables.get('GOOGLE_CLIENT_SECRET')?.isSecret, true);
  assert.equal(environmentVariables.get('TOKEN_ENCRYPTION_KEY')?.isSecret, true);

  assert.match(
    npmLauncherSource,
    /const port = process\.env\.PORT \|\| '8080'/,
    'npm launcher default port must stay aligned with Registry metadata',
  );
  assert.match(
    npmLauncherSource,
    /'--port',\s*port/,
    'npm launcher must continue serving an HTTP port rather than pretending to be stdio',
  );
  assert.match(
    npmLauncherSource,
    /'--ip',\s*'127\.0\.0\.1'/,
    'npm launcher must bind its local HTTP endpoint to loopback only',
  );
  assert.doesNotMatch(
    npmLauncherSource,
    /'--ip',\s*'0\.0\.0\.0'/,
    'npm launcher must not expose its local MCP endpoint on every network interface',
  );
  assert.match(
    npmLauncherSource,
    /const googleRedirectUri = `\$\{localBaseUrl\}\/google\/callback`/,
    'npm launcher must derive the Google callback from the same loopback base URL as the MCP endpoint',
  );
  assert.match(
    npmLauncherSource,
    /Google OAuth redirect URI: \$\{googleRedirectUri\}/,
    'npm launcher must print the exact Google OAuth redirect URI users need to authorize',
  );
  assert.match(
    readmeSource,
    /http:\/\/127\.0\.0\.1:8080\/google\/callback/,
    'README npm onboarding must name the launcher default Google OAuth callback',
  );
  assert.match(
    setupSource,
    /http:\/\/127\.0\.0\.1:8080\/google\/callback/,
    'SETUP must document the npm launcher default Google OAuth callback',
  );
  assert.match(
    setupSource,
    /If you set `PORT`, replace `8080` with that exact port/,
    'SETUP must explain how a custom launcher port changes the OAuth callback',
  );
});

test('registry remotes are concrete monitorable endpoints', () => {
  const remoteUrls = serverJson.remotes.map((entry: { url: string }) => entry.url);

  assert.ok(
    remoteUrls.includes('https://mcp-gsc.digestseo.com/mcp'),
    'server.json must publish the owner-operated hosted MCP endpoint',
  );
  for (const url of remoteUrls) {
    assert.doesNotMatch(
      url,
      /[{}]/,
      'server.json remotes must be concrete endpoints; self-host templates belong in setup docs',
    );
  }
});

test('published tool catalogs remain aligned', () => {
  const serverToolNames = sortedToolNames(serverJson, 'server.json');

  assert.deepEqual(
    sortedToolNames(manifestJson, 'manifest.json'),
    serverToolNames,
    'manifest.json tools must match server.json tools',
  );
  assert.match(
    llmsInstallSource,
    new RegExp(`with ${serverToolNames.length} tools in the default read-write mode`),
    'llms-install.md must describe the current default tool count',
  );
});

test('URL inspection guidance routes bounded multi-URL work to the batch tool', () => {
  assert.doesNotMatch(
    indexSource,
    /there is no batch endpoint/i,
    'single-URL inspection guidance must not claim the batch tool is unavailable',
  );
  assert.match(
    indexSource,
    /For a bounded group of 2-10 URLs, prefer urls\.inspect_many/,
    'runtime tool guidance must route bounded multi-URL work to urls.inspect_many',
  );
});
