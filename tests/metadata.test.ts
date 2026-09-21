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
const packageLockJson = readJson('package-lock.json');
const serverJson = readJson('server.json');
const manifestJson = readJson('manifest.json');
const claudePlugin = readJson('.claude-plugin/plugin.json');
const cursorPlugin = readJson('.cursor-plugin/plugin.json');
const indexSource = readFileSync(resolve(projectRoot, 'src/index.ts'), 'utf8');
const npmLauncherSource = readFileSync(resolve(projectRoot, 'scripts/glama-start.mjs'), 'utf8');
const readmeSource = readFileSync(resolve(projectRoot, 'README.md'), 'utf8');
const setupSource = readFileSync(resolve(projectRoot, 'SETUP.md'), 'utf8');
const llmsInstallSource = readFileSync(resolve(projectRoot, 'llms-install.md'), 'utf8');
const testsReadmeSource = readFileSync(resolve(projectRoot, 'tests/README.md'), 'utf8');

test('package release versions remain aligned across machine-readable metadata', () => {
  const expectedVersion = packageJson.version;

  assert.equal(manifestJson.version, expectedVersion, 'manifest.json version must match package.json');
  assert.equal(claudePlugin.version, expectedVersion, 'Claude plugin version must match package.json');
  assert.equal(cursorPlugin.version, expectedVersion, 'Cursor plugin version must match package.json');
});

test('published Node requirement matches the bundled Wrangler runtime', () => {
  const wranglerPackage = packageLockJson.packages['node_modules/wrangler'];

  assert.ok(wranglerPackage, 'package-lock.json must include the direct Wrangler runtime dependency');
  assert.equal(
    packageJson.engines?.node,
    wranglerPackage.engines?.node,
    'package engines.node must not advertise support below the bundled Wrangler runtime',
  );
  assert.match(
    setupSource,
    /Node\.js 22\+ and npm/,
    'SETUP must document the supported Node floor',
  );
  assert.match(
    llmsInstallSource,
    /Node\.js 22\+ and npm/,
    'llms-install.md must document the supported Node floor',
  );
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

test('Search Analytics metadata preserves provider-level non-exhaustiveness', () => {
  for (const [label, metadata] of [
    ['server.json', serverJson],
    ['manifest.json', manifestJson],
  ] as const) {
    const tool = metadata.tools.find(
      (entry: { name: string }) => entry.name === 'analytics.query',
    );
    assert.ok(tool, `${label} must describe analytics.query`);
    assert.match(
      tool.description,
      /top rows/i,
      `${label} must state Google's top-row limitation`,
    );
    assert.match(
      tool.description,
      /does not guarantee every data row/i,
      `${label} must reject exhaustive-result semantics`,
    );
  }

  assert.match(
    indexSource,
    /provider_exhaustiveness_guaranteed/,
    'runtime structured output must expose provider-level exhaustiveness semantics',
  );
  assert.match(
    indexSource,
    /Local pagination fields describe what this server fetched or bounded; they do not prove provider-level exhaustiveness/,
    'runtime pagination metadata must distinguish local completeness from provider completeness',
  );
  assert.match(
    readmeSource,
    /exhausting local pagination is not proof that the provider dataset is exhaustive/i,
    'README must preserve the provider-level limitation for users',
  );
});

test('Search Analytics page discovery is not presented as index coverage', () => {
  for (const [label, metadata] of [
    ['server.json', serverJson],
    ['manifest.json', manifestJson],
  ] as const) {
    const tool = metadata.tools.find(
      (entry: { name: string }) => entry.name === 'indexing.list_pages',
    );
    assert.ok(tool, `${label} must describe indexing.list_pages`);
    assert.match(
      tool.description,
      /performance data/i,
      `${label} must identify Search Analytics page rows as performance data`,
    );
    assert.match(
      tool.description,
      /not an index-coverage inventory/i,
      `${label} must reject index-inventory semantics`,
    );
    assert.doesNotMatch(
      tool.description,
      /proxy for indexed pages/i,
      `${label} must not call Search Analytics rows an indexed-page proxy`,
    );
  }

  assert.doesNotMatch(
    indexSource,
    /title: 'List Indexed Pages'/,
    'runtime title must not claim Search Analytics rows are indexed pages',
  );
  assert.match(
    indexSource,
    /title: 'List Search-Visible Pages'/,
    'runtime title must describe the observable Search Analytics signal',
  );
  assert.match(
    indexSource,
    /Absence does not mean a URL is unindexed/,
    'runtime result must warn that missing Search Analytics rows are not proof of non-indexing',
  );
  assert.match(
    readmeSource,
    /performance data, not index coverage/i,
    'README must preserve the distinction for users',
  );
});

test('URL Inspection metadata preserves indexed-version-only semantics', () => {
  for (const [label, metadata] of [
    ['server.json', serverJson],
    ['manifest.json', manifestJson],
  ] as const) {
    for (const toolName of ['urls.inspect', 'urls.inspect_many']) {
      const tool = metadata.tools.find(
        (entry: { name: string }) => entry.name === toolName,
      );
      assert.ok(tool, `${label} must describe ${toolName}`);
      assert.match(
        tool.description,
        /indexed version/i,
        `${label} must identify URL Inspection as indexed-version evidence`,
      );
      assert.match(
        tool.description,
        /not a live URL test|does not run live URL tests/i,
        `${label} must reject live-test semantics`,
      );
    }
  }

  assert.match(
    indexSource,
    /does not test the live URL or prove current live-page indexability/,
    'runtime tool description must preserve the indexed-version limitation',
  );
  assert.match(
    indexSource,
    /mobile-usability result is deprecated/,
    'runtime tool description must mark the deprecated mobile-usability result',
  );
  assert.match(
    indexSource,
    /Google's URL Inspection API reports the version currently known in Google's index/,
    'runtime structured output must carry the indexed-version limitation at result time',
  );
  assert.match(
    readmeSource,
    /not a live URL test/i,
    'README must preserve the indexed-version-only limitation for users',
  );
});

test('quick-win metadata preserves average-position semantics and actual eligibility rules', () => {
  for (const [label, metadata] of [
    ['server.json', serverJson],
    ['manifest.json', manifestJson],
  ] as const) {
    const tool = metadata.tools.find(
      (entry: { name: string }) => entry.name === 'insights.quick_wins',
    );
    assert.ok(tool, `${label} must describe insights.quick_wins`);
    assert.match(
      tool.description,
      /average position/i,
      `${label} must identify the Search Console metric as average position`,
    );
    assert.doesNotMatch(
      tool.description,
      /queries? ranking in positions?/i,
      `${label} must not present average position as a literal query rank`,
    );
    assert.doesNotMatch(
      tool.description,
      /low click-through rate/i,
      `${label} must not claim CTR is an eligibility filter`,
    );
  }

  assert.match(
    indexSource,
    /Average position is an aggregate Search Console metric, not a literal current rank/,
    'runtime tool description must preserve average-position semantics',
  );
  assert.match(
    indexSource,
    /CTR is reported for context and does not affect eligibility/,
    'runtime result must preserve the actual quick-win eligibility rule',
  );
  assert.doesNotMatch(
    readmeSource,
    /Which queries does my blog rank position 5.?15 for/i,
    'README example must not turn Search Console average position into a literal rank claim',
  );
});

test('agent installation guide preserves the least-privilege readonly path', () => {
  assert.match(
    llmsInstallSource,
    /GSC_ACCESS_MODE["`:= ]+readonly/,
    'llms-install.md must show autonomous installers how to select readonly mode',
  );
  assert.match(
    llmsInstallSource,
    /https:\/\/www\.googleapis\.com\/auth\/webmasters\.readonly/,
    'llms-install.md must document the Search Console readonly OAuth scope',
  );
  assert.match(
    llmsInstallSource,
    /narrowest scopes an app actually needs/i,
    'llms-install.md must preserve least-privilege OAuth guidance',
  );
});

test('onboarding docs use current Google Auth Platform navigation', () => {
  for (const [label, source] of [
    ['SETUP.md', setupSource],
    ['llms-install.md', llmsInstallSource],
  ] as const) {
    assert.match(source, /Google Auth platform[^\n]*Branding/i, `${label} must route branding through Google Auth Platform`);
    assert.match(source, /Google Auth platform[^\n]*Audience/i, `${label} must route audience/test users through Google Auth Platform`);
    assert.match(source, /Google Auth platform[^\n]*Data Access/i, `${label} must route scopes through Google Auth Platform`);
    assert.match(source, /Google Auth platform[^\n]*Clients/i, `${label} must route OAuth clients through Google Auth Platform`);
    assert.doesNotMatch(
      source,
      /APIs & Services\s*→\s*OAuth consent screen/i,
      `${label} must not send users to the retired OAuth consent-screen navigation`,
    );
    assert.doesNotMatch(
      source,
      /APIs & Services\s*→\s*Credentials\s*→\s*Create credentials\s*→\s*OAuth client ID/i,
      `${label} must not send users through the retired OAuth client navigation`,
    );
  }
});

test('host-native MCP onboarding uses current Claude and ChatGPT surfaces', () => {
  for (const [label, source] of [
    ['README.md', readmeSource],
    ['SETUP.md', setupSource],
    ['llms-install.md', llmsInstallSource],
    ['tests/README.md', testsReadmeSource],
  ] as const) {
    assert.match(
      source,
      /Customize\s*→\s*Connectors/i,
      `${label} must route Claude remote MCP setup through Customize -> Connectors`,
    );
    assert.doesNotMatch(
      source,
      /Settings\s*→\s*Connectors\s*→\s*(?:\*\*)?Add custom connector/i,
      `${label} must not use Claude's retired Settings -> Connectors path`,
    );
  }

  for (const [label, source] of [
    ['README.md', readmeSource],
    ['SETUP.md', setupSource],
    ['llms-install.md', llmsInstallSource],
  ] as const) {
    assert.match(source, /ChatGPT[^\n]*Developer mode/i, `${label} must mention ChatGPT developer mode`);
    assert.match(source, /Settings\s*→\s*Apps\s*→\s*Create/i, `${label} must use ChatGPT's current Apps -> Create flow`);
    assert.match(source, /Pro[^\n]*(?:read\/fetch|read-fetch|read and fetch)/i, `${label} must preserve ChatGPT Pro's read/fetch limitation`);
  }
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
