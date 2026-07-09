import { defineConfig, devices } from '@playwright/test';

/**
 * Single source of truth for the browser/device matrix.
 * CI workflows do NOT redefine browsers — they just select which
 * of these projects to run via `--project=<name>` flags.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },

  // Sequential execution per worker keeps request bursts against the
  // client's production store predictable (see analytics note below).
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  // Override per-workflow with the PW_WORKERS env var if needed.
  workers: process.env.CI ? Number(process.env.PW_WORKERS) || 2 : undefined,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    // JSON output is what scripts/notify-slack.js parses for the summary.
    ['json', { outputFile: 'test-results/results.json' }],
  ],

  use: {
    baseURL: process.env.BASE_URL || 'https://www.outdoorforless.com',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    extraHTTPHeaders: {
      // Lets the client tag/exclude this traffic in GA4 / GTM via a
      // custom dimension or server-side rule. Coordinate with them
      // on what they actually filter on.
      'X-Test-Source': 'playwright-automation',
    },
  },

  projects: [
    // ── Chrome ────────────────────────────────────────────────────────────
    {
      name: 'desktop-chrome',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 7'] },
    },

    // ── Safari ────────────────────────────────────────────────────────────
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 14'] },
    },
  ],
});