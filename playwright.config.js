import { defineConfig, devices } from '@playwright/test';

/**
 * Single source of truth for the browser/device matrix.
 * Select a subset with `--project=<name>`; the names are
 * desktop-chrome, mobile-chrome, webkit, mobile-safari.
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

  // Override with the PW_WORKERS env var if needed.
  //
  // Locally Playwright would default to cores/2 (4 on this 8-core machine).
  // Concurrent WebKit contexts, each recording video and a trace against a
  // third-party-heavy Shopify page, saturate the box and turn ordinary waits
  // into timeouts — at 3 workers the storefront's own POST /cart/add was still
  // in flight past a 12 s poll on 4 of 14 WebKit cart tests. 2 keeps the run
  // deterministic; raise it with PW_WORKERS if your machine has more headroom.
  workers: Number(process.env.PW_WORKERS) || 2,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],

  use: {
    // The live storefront. Note the "s" in outdoors — outdoorforless.com is an
    // unrelated parked domain that serves a redirect stub, not this store.
    baseURL: process.env.BASE_URL || 'https://www.outdoorsforless.com',

    // Cuts one source of the WebKit "element is not stable" timeouts. The
    // theme's Swiper carousels are JS-driven and ignore this, so specs also
    // call stabilizePage() from utils/site.js after navigating.
    reducedMotion: 'reduce',
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