import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          // Integration fixtures exercise write tools even though new installs start readonly.
          GSC_ACCESS_MODE: 'readwrite',
          GOOGLE_CLIENT_ID: 'worker-integration-client',
          GOOGLE_CLIENT_SECRET: 'worker-integration-secret',
          TOKEN_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
        },
      },
      wrangler: {
        configPath: './wrangler.example.jsonc',
      },
    }),
  ],
  test: {
    include: ['tests/worker/**/*.test.ts'],
  },
});
