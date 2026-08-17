import { test, expect, devices } from '@playwright/test';
import { VIEWPORTS } from '../../utils/viewports';
import { storeUrl, stabilizePage } from '../../utils/site';

/**
 * Read prices repeatedly until two consecutive reads agree, so the assertion
 * never samples a half-swapped grid.
 *
 * Dawn replaces the grid over AJAX. Waiting for the sort_by URL param plus
 * networkidle is not sufficient on WebKit: one run came back with the correct
 * 17 prices in the pre-sort order (1445, 1495, 1545, 1845, 195, …) because the
 * DOM was mid-replacement when it was read.
 */
async function readStableGridPrices(page, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;

  while (Date.now() < deadline) {
    const current = await readGridPrices(page);
    if (previous && current.length > 0 && JSON.stringify(current) === JSON.stringify(previous)) {
      return current;
    }
    previous = current;
    await page.waitForTimeout(600);
  }
  return previous ?? [];
}

/**
 * Read the visible product prices from the collection grid, in DOM order.
 *
 * Shopify renders both a regular and a compare-at price per card; we take the
 * lowest numeric value inside each card so a struck-through "was" price cannot
 * be mistaken for the sale price the grid is actually sorted by.
 */
async function readGridPrices(page) {
  return page.evaluate(() => {
    const cards = document.querySelectorAll(
      'li, article, [class*="product-card" i], [class*="grid__item" i], [class*="product-item" i]'
    );

    const prices = [];
    const seen = new Set();

    for (const card of cards) {
      const link = card.querySelector('a[href*="/products/"]');
      if (!link) continue;

      const href = link.getAttribute('href') ?? '';
      if (!href || seen.has(href)) continue;

      // Ignore compare-at / "regular" prices — they are not the sort key.
      const nodes = card.querySelectorAll(
        '[class*="price" i]:not([class*="compare" i]):not([class*="regular" i]), .money, .amount'
      );

      const values = [];
      for (const node of nodes) {
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const match = (node.textContent ?? '').match(/\$\s*([\d,]+(?:\.\d{2})?)/);
        if (match) values.push(parseFloat(match[1].replace(/,/g, '')));
      }

      if (values.length) {
        seen.add(href);
        prices.push(Math.min(...values));
      }
    }
    return prices;
  });
}

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

          await page.goto(storeUrl(collection.url), {
            waitUntil: 'domcontentloaded'
          });
          await stabilizePage(page);

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
          //
          // The previous version asserted `xDiff > 0` under a comment saying
          // "Same row → X difference should be small", and `|yDiff| > 50`
          // under "sanity check they are NOT overlapping" — which is the
          // opposite of what a grid does: two cards on the same row share a y
          // and differ in x. Both assertions contradicted their own comments
          // and only passed by accident of which elements matched.
          //
          // What is actually true of any grid: two adjacent cards must not
          // occupy the same position, and must not overlap each other.
          const cards = await productLinks.all();

          if (cards.length >= 2) {

            const box1 = await cards[0].boundingBox();
            const box2 = await cards[1].boundingBox();

            if (box1 && box2) {

              const sameRow = Math.abs(box1.y - box2.y) < 5;

              if (sameRow) {
                // Side by side → must be separated horizontally, not stacked
                expect(
                  Math.abs(box1.x - box2.x),
                  'Cards on the same row must be horizontally separated'
                ).toBeGreaterThan(0);
              } else {
                // Different rows → must be separated vertically
                expect(
                  Math.abs(box1.y - box2.y),
                  'Cards on different rows must be vertically separated'
                ).toBeGreaterThan(0);
              }

              // Neither arrangement may overlap
              const overlaps =
                box1.x < box2.x + box2.width &&
                box1.x + box1.width > box2.x &&
                box1.y < box2.y + box2.height &&
                box1.y + box1.height > box2.y;

              expect(overlaps, 'Adjacent product cards must not overlap').toBeFalsy();
            }

          }

        });

        test('Sorting works (Price Low to High)', async ({ page }) => {
          test.setTimeout(60_000);

          // This test previously selected a sort option, waited 1 s, and ended
          // — with no assertion of any kind, so it could not fail whatever the
          // site did. Its "mobile" branch also force-set a 375px viewport even
          // inside the desktop describe block, silently discarding the very
          // viewport under test.
          //
          // It now asserts the thing named in the title: that choosing "Price,
          // low to high" actually returns products in ascending price order.
          await page.goto(storeUrl(collection.url), {
            waitUntil: 'domcontentloaded'
          });
          await stabilizePage(page);

          // Both the desktop (#SortBy) and mobile (#SortByMobile) selects exist
          // in the DOM at every viewport, but which — if either — is visible
          // depends on the breakpoint:
          //   1440px: #SortBy visible, #SortByMobile inside a closed <details>
          //    375px: NEITHER visible; #SortByMobile sits inside the collapsed
          //           "Filter and sort" accordion, so it must be opened first.
          // Open any <details> that contains a sort select, then pick whichever
          // control ends up visible, rather than assuming a viewport.
          await page.evaluate(() => {
            document.querySelectorAll('select').forEach((select) => {
              const id = select.id ?? '';
              const name = select.getAttribute('name') ?? '';
              if (!/sort/i.test(id) && !/sort/i.test(name)) return;
              for (let d = select.closest('details'); d; d = d.parentElement?.closest('details')) {
                d.setAttribute('open', '');
              }
            });
          });

          // A sort control must exist in the markup at every breakpoint, even
          // where the theme styles it into a custom widget.
          const anySortSelect = page.locator('select[name*="sort" i], select[id*="sort" i]');
          expect(
            await anySortSelect.count(),
            'Collection page must render a sort control'
          ).toBeGreaterThan(0);

          const optionValues = await anySortSelect.first().evaluate(el =>
            Array.from(el.options).map(o => o.value)
          );
          expect(
            optionValues,
            'Collection sort must offer a price-ascending option'
          ).toContain('price-ascending');

          const visibleSortSelect = anySortSelect.filter({ visible: true }).first();
          const canDriveWidget = await visibleSortSelect
            .isVisible({ timeout: 5_000 })
            .catch(() => false);

          if (canDriveWidget) {
            // Desktop: #SortBy is a real, operable <select>.
            await visibleSortSelect.selectOption('price-ascending');
          } else {
            // Mobile (375px): #SortByMobile is present but rendered at 0x0 with
            // visibility:hidden — the theme replaces it with a custom control
            // that Playwright cannot drive as a <select>. Opening the "Filter
            // and sort" accordion flips visibility but the box stays 0x0.
            //
            // Fall back to the theme's own contract: Dawn reads sort_by from
            // the query string. This still verifies the behaviour the test is
            // named for — that price-ascending returns ascending prices —
            // without asserting against a widget the theme does not expose.
            console.info(
              `   ℹ️  [${viewport.name}] no operable sort <select> at this breakpoint; ` +
              'applying sort via ?sort_by= instead.'
            );
            const sorted = new URL(storeUrl(collection.url));
            sorted.searchParams.set('sort_by', 'price-ascending');
            await page.goto(sorted.toString(), { waitUntil: 'domcontentloaded' });
            await stabilizePage(page);
          }

          // Dawn re-renders the grid over AJAX and reflects the choice in the URL.
          await page.waitForFunction(
            () => new URLSearchParams(location.search).get('sort_by') === 'price-ascending',
            undefined,
            { timeout: 15_000 }
          );
          await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

          const prices = await readStableGridPrices(page);
          console.log(`Prices (${viewport.name}):`, prices.slice(0, 8));

          expect(
            prices.length,
            'Need at least two priced products to verify sort order'
          ).toBeGreaterThanOrEqual(2);

          const ascending = [...prices].sort((a, b) => a - b);
          expect(
            prices,
            `Products must be ordered by ascending price. Got: ${prices.slice(0, 8).join(', ')}`
          ).toEqual(ascending);
        });

        
      });

    }
  }

});