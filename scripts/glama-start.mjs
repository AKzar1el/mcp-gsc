import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const port = process.env.PORT || '8080';
const forwardedVariables = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'TOKEN_ENCRYPTION_KEY',
  'GLAMA_INSPECTION_MODE',
];
const args = [
  'dev',
  '--config',
  'wrangler.example.jsonc',
  '--local',
  '--ip',
  '0.0.0.0',
  '--port',
  port,
];

for (const name of forwardedVariables) {
  if (process.env[name]) {
    args.push('--var', `${name}:${process.env[name]}`);
  }
}

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
