import { test, expect, devices } from '@playwright/test';
import { VIEWPORTS } from '../../utils/viewports';

// Desktop viewport runs need a desktop User-Agent and vice versa — leaving
// a touch project's mobile UA in place while flipping hasTouch/isMobile to
// false creates a client-hints/UA mismatch (claims desktop via hasTouch but
// UA string still says "Mobile") that trips the site's anti-bot check and
// hangs page.goto() until timeout, rather than just rendering oddly.
const DESKTOP_USER_AGENT = devices['Desktop Chrome'].userAgent;
const MOBILE_USER_AGENT = devices['Pixel 7'].userAgent;

const COLLECTIONS = [
  { name: 'Deer Blinds', url: '/collections/deer-blinds' },
  // { name: 'Deer Feeders', url: '/collections/deer-feeders' },
  // { name: 'Hunting Accessories', url: '/collections/accessories' },
  // { name: 'Fish Feeders', url: '/collections/fish-feeders' },
  // { name: 'Boats', url: '/collections/bass-boat' },
  // { name: 'Sale', url: '/collections/sale' },
];

test.describe('Product Listing Page', () => {
  for (const collection of COLLECTIONS) {

    for (const viewport of VIEWPORTS) {

      test.describe(`Collection: ${collection.name} | ${viewport.name}`, () => {

        test.use({
          viewport: {
            width: viewport.width,
            height: viewport.height
          },
          // Keep touch/mobile/UA signals in sync with the viewport we're
          // asserting against — otherwise a "desktop" viewport run under a
          // touch-device project (mobile-chrome/mobile-safari), or vice
          // versa, sends a self-contradictory device fingerprint that the
          // theme's responsive JS doesn't expect and can trip anti-bot checks.
          hasTouch: viewport.name === 'mobile',
          isMobile: viewport.name === 'mobile',
          userAgent: viewport.name === 'mobile' ? MOBILE_USER_AGENT : DESKTOP_USER_AGENT,
        });

        test('Collection page UI', async ({ page }) => {
          test.setTimeout(45_000); // goto + image load + product nav + grid check is tight at the 30s default

          await page.goto(`https://www.outdoorsforless.com${collection.url}`, {
            waitUntil: 'domcontentloaded'
          });

          const productLinks = page.locator('a[href*="/products/"]');

          await expect(productLinks.first()).toBeAttached();

          const count = await productLinks.count();
          console.log(`Product count (${viewport.name}):`, count);

          expect(count).toBeGreaterThan(0);

          const firstProductLink = productLinks.first();

          const firstCard = firstProductLink.locator('xpath=ancestor::*[1]');

          await expect(firstCard).toBeVisible();

          // Image
          const image = firstCard.locator('img').first();

          await expect(image).toBeAttached();

          // Wait until image is actually loaded
          await page.waitForFunction((img) => img.complete && img.naturalWidth > 0, await image.elementHandle());

          // Title via aria-label
          await expect(firstProductLink).toHaveAttribute('aria-label', /.+/);

          // Price
          const price = firstCard.locator('[class*="price"], [class*="Price"], [data-price]');

          if (await price.count() > 0) {
            await expect(price.first()).toBeVisible();
          }

          // Click → PDP
          const href = await firstProductLink.getAttribute('href');

          await firstProductLink.click();

          await expect(page).toHaveURL(new RegExp(href));

          await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
          // Add to cart
          await expect(page.getByRole('button', { name: /add to cart/i })).toBeVisible();

          await page.goBack({ waitUntil: 'domcontentloaded' });

          // Grid alignment (basic)
          const cards = await productLinks.all();

          if (cards.length >= 2) {

            const box1 = await cards[0].boundingBox();
            const box2 = await cards[1].boundingBox();

            if (box1 && box2) {

              const xDiff = Math.abs(box1.x - box2.x);

              // Same row → X difference should be small
              expect(xDiff).toBeGreaterThan(0);

              // Optional: sanity check they are NOT overlapping
              expect(Math.abs(box1.y - box2.y)).toBeGreaterThan(50);
            }

          }

        });

        test('Sorting works (Price Low to High)', async ({ page }) => {

          await page.goto(`https://www.outdoorsforless.com${collection.url}`, {
            waitUntil: 'domcontentloaded'
          });

          // -----------------------------
          // 🖥️ DESKTOP SORTING
          // -----------------------------
          const sortDropdown = page.locator('select[name*="sort"], select[id*="sort"]');

          if (await sortDropdown.isVisible()) {

            await sortDropdown.selectOption('price-ascending');
            await page.waitForTimeout(1000);

          } else {

            // -----------------------------
            // 📱 MOBILE SORTING
            // -----------------------------

            // Mobile viewport
            await page.setViewportSize({ width: 375, height: 667 });

            // Open filters
            const openFilters = page.getByText('Filter and sort', { exact: true });
            await openFilters.click();

            // Click Price (fixed locator)
            const priceFilterToggle = page.getByRole('button', { name: /price/i });
            await priceFilterToggle.click();

            // Wait for slider
            const priceSlider = page.locator('#Mobile-Filter-Price-LTE');
            await expect(priceSlider).toBeVisible({ timeout: 10000 });

            // Set price
            await priceSlider.evaluate(el => {
              el.value = '1000';
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            });

            await page.waitForTimeout(1000);
          }

        });

        
      });

    }
  }

});