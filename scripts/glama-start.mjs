import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = process.env.PORT || '8080';
const localBaseUrl = `http://127.0.0.1:${port}`;
const mcpUrl = `${localBaseUrl}/mcp`;
const googleRedirectUri = `${localBaseUrl}/google/callback`;
const wranglerConfig = fileURLToPath(
  new URL('../wrangler.example.jsonc', import.meta.url),
);
const stateDir = process.env.MCP_GSC_STATE_DIR
  ? resolve(process.env.MCP_GSC_STATE_DIR)
  : resolve(homedir(), '.mcp-gsc', 'state');
const forwardedVariables = [
  'GOOGLE_CLIENT_ID',
  'GSC_ACCESS_MODE',
  'GLAMA_INSPECTION_MODE',
];
const args = [
  'dev',
  '--config',
  wranglerConfig,
  '--persist-to',
  stateDir,
  '--local',
  '--ip',
  '127.0.0.1',
  '--port',
  port,
];

for (const name of forwardedVariables) {
  if (process.env[name]) {
    args.push('--var', `${name}:${process.env[name]}`);
  }
}

console.error(`[mcp-gsc] Local MCP endpoint: ${mcpUrl}`);
console.error(`[mcp-gsc] Google OAuth redirect URI: ${googleRedirectUri}`);
console.error(`[mcp-gsc] Local state directory: ${stateDir}`);

const wranglerCli = createRequire(import.meta.url).resolve('wrangler');
const child = spawn(process.execPath, [wranglerCli, ...args], { stdio: 'inherit' });

const forwardSignal = (signal) => child.kill(signal);
process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
