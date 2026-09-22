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
const wranglerExampleSource = readFileSync(resolve(projectRoot, 'wrangler.example.jsonc'), 'utf8');
const readmeSource = readFileSync(resolve(projectRoot, 'README.md'), 'utf8');
const setupSource = readFileSync(resolve(projectRoot, 'SETUP.md'), 'utf8');
const llmsInstallSource = readFileSync(resolve(projectRoot, 'llms-install.md'), 'utf8');
const testsReadmeSource = readFileSync(resolve(projectRoot, 'tests/README.md'), 'utf8');
const rootMcpConfig = readFileSync(resolve(projectRoot, '.mcp.json'), 'utf8');
const cursorMcpConfig = readFileSync(resolve(projectRoot, 'mcp.json'), 'utf8');
const windsurfSource = readFileSync(resolve(projectRoot, 'docs/windsurf.md'), 'utf8');

test('package release versions remain aligned across machine-readable metadata', () => {
  const expectedVersion = packageJson.version;

  assert.equal(manifestJson.version, expectedVersion, 'manifest.json version must match package.json');
  assert.equal(claudePlugin.version, expectedVersion, 'Claude plugin version must match package.json');
  assert.equal(cursorPlugin.version, expectedVersion, 'Cursor plugin version must match package.json');
});

test('published Node requirement covers the strictest bundled runtime dependency', () => {
  const wranglerPackage = packageLockJson.packages['node_modules/wrangler'];
  const agentsPackage = packageLockJson.packages['node_modules/agents'];
  const babelDecoratorsPackage = packageLockJson.packages['node_modules/@babel/plugin-proposal-decorators'];

  assert.ok(wranglerPackage, 'package-lock.json must include the direct Wrangler runtime dependency');
  assert.ok(agentsPackage, 'package-lock.json must include the direct Agents runtime dependency');
  assert.ok(
    agentsPackage.dependencies?.['@babel/plugin-proposal-decorators'],
    'Agents runtime must keep its Babel decorators dependency represented in the lockfile',
  );
  assert.ok(
    babelDecoratorsPackage,
    'package-lock.json must include the Babel decorators runtime dependency',
  );
  assert.equal(
    packageJson.engines?.node,
    babelDecoratorsPackage.engines?.node,
    'package engines.node must not advertise versions rejected by bundled runtime dependencies',
  );
  assert.equal(wranglerPackage.engines?.node, '>=22.0.0');
  assert.match(
    setupSource,
    /Node\.js 22\.18\+ within the 22\.x line, or Node\.js 24\.11\+ with npm/,
    'SETUP must document the supported Node ranges',
  );
  assert.match(
    llmsInstallSource,
    /Node\.js 22\.18\+ within the 22\.x line, or Node\.js 24\.11\+ with npm/,
    'llms-install.md must document the supported Node ranges',
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
  assert.equal(environmentVariables.get('GSC_ACCESS_MODE')?.default, 'readwrite');
  assert.equal(environmentVariables.get('GSC_ACCESS_MODE')?.isSecret, false);
  assert.equal(environmentVariables.get('MCP_GSC_STATE_DIR')?.isRequired, false);
  assert.equal(environmentVariables.get('MCP_GSC_STATE_DIR')?.isSecret, false);
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
    /fileURLToPath\(\s*new URL\('\.\.\/wrangler\.example\.jsonc', import\.meta\.url\),\s*\)/,
    'npm launcher must resolve its bundled Wrangler config from the installed package, not the caller cwd',
  );
  assert.doesNotMatch(
    npmLauncherSource,
    /'--config',\s*'wrangler\.example\.jsonc'/,
    'npm launcher must not pass a caller-cwd-relative Wrangler config path',
  );
  assert.match(
    npmLauncherSource,
    /process\.env\.MCP_GSC_STATE_DIR[\s\S]*resolve\(homedir\(\), '\.mcp-gsc', 'state'\)/,
    'npm launcher must keep local binding state outside the versioned npm package cache while allowing an override',
  );
  assert.match(
    npmLauncherSource,
    /'--persist-to',\s*stateDir/,
    'npm launcher must give Wrangler an explicit stable local persistence path',
  );
  assert.match(
    npmLauncherSource,
    /Local state directory: \$\{stateDir\}/,
    'npm launcher must print the effective local state directory for troubleshooting',
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
    npmLauncherSource,
    /'GSC_ACCESS_MODE'/,
    'npm launcher must forward the access-mode binding into the local Worker',
  );
  assert.match(
    npmLauncherSource,
    /const requiredEnvironmentVariables = \[\s*'GOOGLE_CLIENT_ID',\s*'GOOGLE_CLIENT_SECRET',\s*'TOKEN_ENCRYPTION_KEY',\s*\]/,
    'npm launcher must declare every required local OAuth/token-encryption environment variable',
  );
  assert.match(
    npmLauncherSource,
    /requiredEnvironmentVariables\.filter\(\s*\(name\) => !process\.env\[name\]\?\.trim\(\),\s*\)/,
    'npm launcher must reject missing or blank required environment variables',
  );
  assert.match(
    npmLauncherSource,
    /Missing required environment variables: \$\{missingRequiredEnvironmentVariables\.join\(', '\)\}[\s\S]*process\.exit\(1\)/,
    'npm launcher must fail before starting Wrangler and report only which required variables are missing',
  );
  assert.ok(
    npmLauncherSource.indexOf('missingRequiredEnvironmentVariables.length > 0')
      < npmLauncherSource.indexOf('const child = spawn('),
    'npm launcher required-environment preflight must run before the Wrangler child starts',
  );
  assert.doesNotMatch(
    npmLauncherSource,
    /process\.kill\(process\.pid,\s*signal\)/,
    'npm launcher must not re-signal itself while its SIGINT/SIGTERM listeners are still installed',
  );
  assert.match(
    npmLauncherSource,
    /constants\.signals\[signal\][\s\S]*128 \+ signalNumber/,
    'npm launcher must translate child signal termination into the conventional process exit code',
  );
  const forwardedVariables = npmLauncherSource.match(
    /const forwardedVariables = \[([\s\S]*?)\];/,
  );
  assert.ok(forwardedVariables, 'npm launcher must declare its explicit Wrangler --var allowlist');
  assert.doesNotMatch(
    forwardedVariables[1],
    /GOOGLE_CLIENT_SECRET|TOKEN_ENCRYPTION_KEY/,
    'npm launcher must never serialize secret values into Wrangler command-line --var arguments',
  );
  assert.match(
    wranglerExampleSource,
    /"secrets"\s*:\s*\{\s*"required"\s*:\s*\[\s*"GOOGLE_CLIENT_SECRET"\s*,\s*"TOKEN_ENCRYPTION_KEY"\s*\]/,
    'Wrangler config must load the npm launcher secrets from process.env via secrets.required',
  );
  assert.match(
    readmeSource,
    /local launcher defaults to `GSC_ACCESS_MODE=readwrite`[\s\S]*set `GSC_ACCESS_MODE=readonly`/i,
    'README npm onboarding must document the least-privilege launcher mode',
  );
  assert.match(
    readmeSource,
    /~\/\.mcp-gsc\/state[\s\S]*MCP_GSC_STATE_DIR/,
    'README npm onboarding must document durable local launcher state and its override',
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
  assert.match(
    setupSource,
    /~\/\.mcp-gsc\/state[\s\S]*MCP_GSC_STATE_DIR/,
    'SETUP must document the npm launcher local-state path and override',
  );
  assert.match(
    readmeSource,
    /exits before starting Wrangler[\s\S]*missing or blank/i,
    'README npm onboarding must explain the required-environment preflight',
  );
});

test('registry advertises only currently aligned install paths', () => {
  const registryDocument = serverJson as typeof serverJson & {
    remotes?: Array<{ url: string }>;
  };

  assert.deepEqual(
    registryDocument.remotes ?? [],
    [],
    'server.json must not advertise the hosted remote while its deployed tool contract lags the published package',
  );
});

test('package-only quick-connect surfaces do not route users to the stale hosted remote', () => {
  const staleHostedRemote = 'https://mcp-gsc.digestseo.com/mcp';
  const loopbackRemote = 'http://127.0.0.1:8080/mcp';

  for (const [label, source] of [
    ['README.md', readmeSource],
    ['.mcp.json', rootMcpConfig],
    ['mcp.json', cursorMcpConfig],
    ['docs/windsurf.md', windsurfSource],
  ] as const) {
    assert.equal(
      source.includes(staleHostedRemote),
      false,
      `${label} must not advertise the hosted remote while the deployed tool contract lags the package`,
    );
    assert.equal(
      source.includes(loopbackRemote),
      true,
      `${label} must route the current quick-connect path through the verified npm launcher`,
    );
  }
});

test('one-click client links resolve to the verified loopback launcher', () => {
  const loopbackRemote = 'http://127.0.0.1:8080/mcp';
  const cursorLink = readmeSource.match(/\]\((https:\/\/cursor\.com\/en\/install-mcp\?[^)]+)\)/)?.[1];
  const kiroLink = readmeSource.match(/\]\((https:\/\/kiro\.dev\/launch\/mcp\/add\?[^)]+)\)/)?.[1];

  assert.ok(cursorLink, 'README must include the Cursor install link');
  assert.ok(kiroLink, 'README must include the Kiro install link');

  const cursorConfig = new URL(cursorLink).searchParams.get('config');
  const kiroConfig = new URL(kiroLink).searchParams.get('config');
  assert.ok(cursorConfig, 'Cursor install link must include a config payload');
  assert.ok(kiroConfig, 'Kiro install link must include a config payload');

  assert.equal(JSON.parse(Buffer.from(cursorConfig, 'base64').toString('utf8')).url, loopbackRemote);
  assert.equal(JSON.parse(kiroConfig).url, loopbackRemote);
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

test('server.capabilities distinguishes stored credentials from live Google authorization', () => {
  const manifestTool = manifestJson.tools.find(
    (entry: { name: string }) => entry.name === 'server.capabilities',
  );
  assert.ok(manifestTool, 'manifest.json must describe server.capabilities');
  assert.match(
    manifestTool.description,
    /stored refresh credential[\s\S]*not a live Google authorization check/i,
    'manifest.json must not claim stored credentials prove current provider authorization',
  );
  assert.doesNotMatch(
    manifestTool.description,
    /currently authenticated/i,
    'manifest.json must not describe the local credential check as live authentication',
  );

  assert.match(
    indexSource,
    /auth_status_basis:[\s\S]*provider_auth_live_verified: false as const[\s\S]*auth_note:/,
    'runtime output must make the local auth-status basis and lack of live verification machine-readable',
  );
  assert.match(
    indexSource,
    /Refresh tokens can expire or be revoked; a Google tool call may still require reconnection/,
    'runtime guidance must preserve the provider-revocation boundary',
  );
  assert.match(
    readmeSource,
    /server\.capabilities[\s\S]*stored refresh credential[\s\S]*provider_auth_live_verified: false[\s\S]*expired or was revoked/i,
    'README must explain that connected is stored-credential state rather than a live Google check',
  );
});

test('sites.add metadata preserves the property-add versus ownership-verification boundary', () => {
  assert.match(
    indexSource,
    /Sites\.add only adds the property to the user's Search Console site set; it does not verify ownership/,
    'server runtime must distinguish property addition from ownership verification',
  );
  assert.match(
    readmeSource,
    /ownership_verification_performed: false[\s\S]*separate Google Site Verification\/Search Console workflow/,
    'README must document the sites.add verification boundary',
  );
});

test('sites.delete metadata preserves the account-site-set boundary', () => {
  assert.match(
    indexSource,
    /Sites\.delete method removes the property from the connected user's Search Console site set/,
    'server runtime must describe the provider operation as account-scoped site-set removal',
  );
  assert.match(
    readmeSource,
    /sites\.delete[\s\S]*removes the property from that account's Search Console site set; it does not delete the website itself/i,
    'README must not imply that sites.delete deletes the website itself',
  );
});

test('Indexing API metadata preserves eligibility and provider-approval boundaries', () => {
  for (const [label, metadata] of [
    ['server.json', serverJson],
    ['manifest.json', manifestJson],
  ] as const) {
    const tool = metadata.tools.find(
      (entry: { name: string }) => entry.name === 'indexing.request',
    );
    assert.ok(tool, `${label} must describe indexing.request`);
    assert.match(
      tool.description,
      /JobPosting or livestream/i,
      `${label} must identify the eligible content classes`,
    );
    assert.match(
      tool.description,
      /not a general webpage submission tool/i,
      `${label} must reject general-purpose indexing semantics`,
    );
    assert.match(
      tool.description,
      /onboarding\/testing/i,
      `${label} must identify the default quota as onboarding/testing capacity`,
    );
    assert.match(
      tool.description,
      /usage requires approval/i,
      `${label} must preserve the provider approval boundary`,
    );
    assert.match(
      tool.description,
      /spam-screened/i,
      `${label} must disclose provider spam screening`,
    );
  }

  assert.match(
    indexSource,
    /provider_default_quota_for_testing_only:[\s\S]*provider_usage_approval_required:[\s\S]*provider_spam_detection_applies:/,
    'runtime structured output must expose Indexing API provider-usage boundaries',
  );
  assert.match(
    indexSource,
    /default 200 publish-requests-per-day project quota is for onboarding\/testing rather than ongoing-use approval/,
    'server.capabilities must preserve the restricted Indexing API scope',
  );
  assert.match(
    readmeSource,
    /default 200 publish requests\/day\/project is for onboarding and submission testing[\s\S]*spam detection[\s\S]*revoke access/i,
    'README must document Indexing API approval and spam-enforcement semantics',
  );
  assert.match(
    setupSource,
    /default \*\*200 publish requests\/day\/project\*\*[\s\S]*ongoing usage\/resource provisioning requires additional Google approval[\s\S]*spam detection/i,
    'SETUP must distinguish local safety limits from Google Indexing API approval',
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

test('Search Analytics metadata does not fabricate dedicated Generative AI API support', () => {
  const manifestTool = manifestJson.tools.find(
    (entry: { name: string }) => entry.name === 'analytics.query',
  );
  assert.ok(manifestTool, 'manifest.json must describe analytics.query');
  assert.match(
    manifestTool.description,
    /does not expose a dedicated Generative AI performance-report selector/i,
    'manifest.json must preserve the current documented API boundary',
  );

  assert.match(
    indexSource,
    /generative_ai_report_isolatable/,
    'runtime structured output must expose the Generative AI isolation boundary',
  );
  assert.match(
    indexSource,
    /Do not infer isolated Generative AI metrics from analytics\.query or guess a searchAppearance identifier/,
    'runtime guidance must reject guessed Generative AI selectors',
  );
  assert.match(
    readmeSource,
    /use the Search Console UI for the dedicated Generative AI report until Google documents API access/i,
    'README must route dedicated Generative AI reporting to the supported surface',
  );
});

test('period comparison guidance does not turn one-sided Search Analytics absence into zero', () => {
  assert.match(
    indexSource,
    /common_returned_rows_only/,
    'runtime output must expose the common-returned-row comparison scope',
  );
  assert.match(
    indexSource,
    /A key missing from one Search Analytics response is not treated as zero because Google does not guarantee every data row/,
    'runtime output must explain why one-sided row absence is not zero',
  );
  assert.match(
    readmeSource,
    /content-decay results compare only pages returned in both periods and do not turn one-sided row absence into zero traffic/i,
    'README must preserve content-decay common-row semantics',
  );
  assert.match(
    readmeSource,
    /analytics\.compare` compares only dimension keys returned in both period responses/i,
    'README must preserve period-comparison common-row semantics',
  );
});

test('manual brand regex guidance does not impersonate Search Console branded classification', () => {
  assert.match(
    indexSource,
    /query regex can provide a manual[\s\S]*brand\/non-brand approximation/i,
    'analytics.query must describe query-regex segmentation as a manual approximation',
  );
  assert.match(
    indexSource,
    /AI-assisted[\s\S]*Search Analytics API does not expose/i,
    'runtime metadata must distinguish manual regexes from the native branded classifier',
  );
  assert.match(
    indexSource,
    /caller-supplied query regex can approximate a manual brand\/non-brand split/i,
    'analytics.compare must preserve the same distinction',
  );
  assert.match(
    readmeSource,
    /Query regexes are a manual approximation only/i,
    'README must not present regex segmentation as Search Console native branded classification',
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

  assert.match(
    readmeSource,
    /ChatGPT cannot connect directly[^\n]*127\.0\.0\.1[^\n]*Secure MCP Tunnel/i,
    'README local-launcher guidance must not imply that ChatGPT can connect directly to loopback MCP',
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
  assert.match(
    indexSource,
    /Requests use bounded concurrency of \$\{URL_INSPECTION_BATCH_CONCURRENCY\}/,
    'runtime batch guidance must keep bounded concurrency machine-visible',
  );
  assert.match(
    readmeSource,
    /urls\.inspect_many[^\n]*bounded concurrency of 3/i,
    'README must document the bounded URL inspection concurrency',
  );
});
