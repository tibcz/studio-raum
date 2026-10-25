import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        compatibilityDate: '2026-08-20',
        bindings: {
          SECRET_PEPPER: 'test-pepper-do-not-use-in-production-0123456789',
          SETUP_PASSWORD: 'test-setup-password',
          MAX_TEAMS: '1000',
        },
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'] },
});
