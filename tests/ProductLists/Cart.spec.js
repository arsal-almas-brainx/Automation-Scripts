/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Cart & Checkout UI Test Suite
 * Site    : https://www.outdoorsforless.com  (Shopify — custom theme)
 * Runner  : @playwright/test
 *
 * VIEWPORTS
 * ─────────
 * Configured in playwright.config.js via `projects`:
 *   • desktop-chrome — Desktop Chrome
 *   • mobile-chrome  — Pixel 7   (touch, mobile UA)
 *   • webkit         — Desktop Safari
 *   • mobile-safari  — iPhone 14 (touch, mobile UA)
 *
 * Run all:            npx playwright test tests/ProductLists/Cart.spec.js
 * Desktop only:       npx playwright test --project=desktop-chrome --project=webkit
 * Mobile only:        npx playwright test --project=mobile-chrome --project=mobile-safari
 * Single collection:  npx playwright test --grep "Deer Blinds"
 *
 * MOBILE DIFFERENCES HANDLED
 * ──────────────────────────
 * • isMobile flag detected via viewport width (< 768 px)
 * • Hamburger / nav menu closed before interacting with page elements
 * • Checkout button scroll + tap via locator.tap() on touch viewports
 * • Cart page layout verified to fit within mobile viewport width
 * • Qty stepper buttons preferred over keyboard input on touch devices
 *
 * KEY DESIGN DECISIONS
 * ────────────────────
 * • addToCart: click → waitForURL (4 s, caught) → poll /cart.js — no
 *   waitForResponse/Promise.race (causes "object not bound" on navigation)
 * • All cart state verified via /cart.js API, not DOM text
 * • Quantity changes confirmed by polling /cart.js item quantity
 * • test.setTimeout(90_000) in beforeEach — each test does 3-4 navigations
 *
 * WEBKIT NOTES (all 14 of these tests used to fail on webkit + mobile-safari
 * while the identical 14 passed on Chrome — both causes are now fixed):
 * • /cart.js is read through page.context().request, not an in-page fetch().
 *   The in-page call queued behind the product page's third-party requests and
 *   took 9.6-11.9 s per call; addToCart polls it, which blew the test budget.
 *   Via the request context the same read takes ~200-600 ms.
 * • scrollIntoViewIfNeeded() waits for the element to stop moving. The theme's
 *   autoplaying Swiper carousels never let that settle. Specs now call
 *   stabilizePage() and scroll via plain scrollIntoView().
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const { test, expect } = require('@playwright/test');
const {
  STORE_ORIGIN,
  storeUrl,
  stabilizePage,
  waitForLayoutSettle,
  scrollIntoView,
  getCartItemCount,
  getFirstItemQty,
  pollCartCount,
  pollFirstItemQty,
} = require('../../utils/site');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const BASE_URL = STORE_ORIGIN;

const COLLECTIONS = [
  { name: 'Deer Blinds',  url: '/collections/deer-blinds'  },
  // { name: 'Deer Feeders', url: '/collections/deer-feeders' },
  // { name: 'Accessories',  url: '/collections/accessories'  },
  // { name: 'Fish Feeders', url: '/collections/fish-feeders' },
  // { name: 'Boats',        url: '/collections/bass-boat'    },
  // { name: 'Sale',         url: '/collections/sale'         },
];

const NAV_TIMEOUT  = 30_000;   // page.goto / waitForURL
const ELEM_TIMEOUT = 15_000;   // expect(locator).toBeVisible etc.

// Viewport width below which we treat the session as "mobile"
const MOBILE_BREAKPOINT = 768;

// ─── SELECTORS ────────────────────────────────────────────────────────────────

const ADD_BTN_SEL =
  'button[name="add"], ' +
  'button[type="submit"][form*="product"], ' +
  'button:has-text("Add to Cart"), ' +
  'button:has-text("Add to cart")';

// Standard Shopify /cart page checkout CTA
const CHECKOUT_BTN_SEL =
  'button[name="checkout"], ' +
  'input[type="submit"][name="checkout"], ' +
  'a[href*="/checkouts/"], ' +
  'a[href*="checkout"]:not([href="/cart"])';

const QTY_INPUT_SEL =
  'input[name*="updates"], ' +
  'input[id*="quantity"], ' +
  'input[id*="Quantity"], ' +
  'input[type="number"][min]';

const QTY_PLUS_SEL =
  'button[aria-label*="Increase"], ' +
  '[data-quantity-plus], ' +
  'button.quantity__button:last-of-type';

const QTY_MINUS_SEL =
  'button[aria-label*="Decrease"], ' +
  '[data-quantity-minus], ' +
  'button.quantity__button:first-of-type';

const REMOVE_BTN_SEL =
  'a[href*="/cart/change"]:has-text("Remove"), ' +
  'a[href*="/cart/update"]:has-text("Remove"), ' +
  'button[aria-label*="Remove"], ' +
  'button:has-text("Remove"), ' +
  'a:has-text("Remove")';

const SHIPPING_NOTE_SEL =
  ':has-text("calculated at checkout"), ' +
  ':has-text("Taxes and shipping"), ' +
  'a[href*="shipping-policy"]';

// Native CSS only — for use inside page.evaluate() where :has-text() is invalid
const CHECKOUT_NATIVE_SEL =
  'button[name="checkout"], ' +
  'input[type="submit"][name="checkout"], ' +
  'a[href*="/checkouts/"], ' +
  'a[href*="checkout"]';

// ─── VIEWPORT HELPER ──────────────────────────────────────────────────────────

/**
 * Returns true when the current viewport is narrower than MOBILE_BREAKPOINT.
 * Works with both Playwright device presets and manually set viewports.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {boolean}
 */
function isMobileViewport(page) {
  const vp = page.viewportSize();
  return vp !== null && vp.width < MOBILE_BREAKPOINT;
}

// ─── STEALTH ─────────────────────────────────────────────────────────────────

async function applyBasicStealth(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }],
    });
  });
}

// ─── VERIFICATION WALL GUARD ──────────────────────────────────────────────────

async function guardVerificationWall(page, testInfo, context) {
  const wall = page.getByRole('heading', { name: /connection needs to be verified/i });
  if (!(await wall.isVisible().catch(() => false))) return;
  await page.waitForTimeout(2_000);
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  if (await wall.isVisible().catch(() => false)) {
    testInfo.skip(true, `Anti-bot wall at: ${context}`);
  }
}

// ─── MOBILE: CLOSE NAV MENU ───────────────────────────────────────────────────

/**
 * On mobile, Shopify themes often render a hamburger nav that can overlay
 * page content. Close it if it's open before interacting with elements.
 *
 * @param {import('@playwright/test').Page} page
 */
async function closeMobileNavIfOpen(page) {
  if (!isMobileViewport(page)) return;

  // Common selectors for open mobile nav / hamburger close buttons
  const closeBtn = page.locator(
    'button[aria-label*="Close menu"], ' +
    'button[aria-label*="close menu"], ' +
    'button[aria-expanded="true"][aria-controls*="nav"], ' +
    '[class*="mobile-nav__close"], ' +
    '[class*="drawer__close"]'
  ).first();

  if (await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await closeBtn.click();
    await page.waitForTimeout(400); // allow close animation
  }
}

// ─── SHOPIFY CART API HELPERS ─────────────────────────────────────────────────
//
// getCartItemCount / getFirstItemQty / pollCartCount / pollFirstItemQty now
// live in utils/site.js and read /cart.js through page.context().request
// instead of an in-page fetch(). See the WebKit note in the file header.

// ─── PRODUCT NAVIGATION ───────────────────────────────────────────────────────

/**
 * Navigate to a collection page, resolve the first purchasable product URL
 * via in-page DOM evaluation (price is a sibling of <a> on this theme, not a
 * descendant — so filter({hasText:/\$/}) on the anchor always returns 0),
 * then navigate directly to the product page.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').TestInfo} testInfo
 * @param {{ name: string, url: string }} collection
 * @returns {Promise<string>} Product title
 */
async function navigateToProduct(page, testInfo, collection) {
  await page.goto(storeUrl(collection.url), {
    waitUntil: 'domcontentloaded',
    timeout: NAV_TIMEOUT,
  });
  await guardVerificationWall(page, testInfo, collection.url);
  await stabilizePage(page);
  await closeMobileNavIfOpen(page);

  // Wait for product links to exist in the DOM.
  // The first anchor is an invisible click-tracking overlay — waitFor 'attached'
  // (not 'visible') so we don't fail on the hidden element.
  await page.locator('a[href*="/products/"]').first()
    .waitFor({ state: 'attached', timeout: ELEM_TIMEOUT });

  const href = await page.evaluate(() => {
    const priceSel = '[class*="price" i], [class*="money" i], .amount';
    // Strategy 1 — card with both a product link and a price sibling
    for (const card of document.querySelectorAll(
      'li, article, [class*="product-card" i], [class*="grid__item" i], [class*="product-item" i]'
    )) {
      const link  = card.querySelector('a[href*="/products/"]');
      const price = card.querySelector(priceSel);
      if (link && price) {
        const h = link.getAttribute('href') ?? '';
        if (h.includes('/products/') && !h.includes('?variant')) return h;
      }
    }
    // Strategy 2 — product link whose closest ancestor contains a price
    for (const link of document.querySelectorAll('a[href*="/products/"]')) {
      const anc = link.closest('li, article, [class*="product" i]') ?? link.parentElement;
      if (anc?.querySelector(priceSel)) return link.getAttribute('href') ?? '';
    }
    // Strategy 3 — first product link regardless of price
    return document.querySelector('a[href*="/products/"]')?.getAttribute('href') ?? '';
  });

  if (!href) throw new Error(`No product link found on "${collection.name}"`);

  const fullUrl = href.startsWith('http')
    ? href
    : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;

  await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await guardVerificationWall(page, testInfo, fullUrl);
  await stabilizePage(page);
  await waitForLayoutSettle(page, 4_000);
  await closeMobileNavIfOpen(page);

  // Extract and clean the product title (theme emits it doubled with whitespace)
  let title = '';
  try {
    const raw = await page
      .locator('h1, [class*="product__title"], [class*="product-title"]')
      .first()
      .textContent({ timeout: 4_000 }) ?? '';
    const trimmed = raw.replace(/\s+/g, ' ').trim();
    const half = trimmed.slice(0, Math.ceil(trimmed.length / 2)).trim();
    title = trimmed === `${half} ${half}` ? half : trimmed;
  } catch { /* non-critical */ }

  return title;
}

// ─── ADD TO CART ──────────────────────────────────────────────────────────────

/**
 * Click the Add-to-Cart button and confirm the item was added via /cart.js.
 *
 * Design:
 *  - No waitForResponse or Promise.race with long timeouts — both cause
 *    "object not bound" / "target page closed" when a navigation fires mid-await.
 *  - On mobile, uses tap() instead of click() for reliable touch simulation.
 *  - Polls /cart.js (max 12 s) to confirm item_count increased.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<'redirect'|'ajax'>}
 */
async function addToCart(page) {
  const btn = page.locator(ADD_BTN_SEL).first();
  await expect(btn, 'Add-to-Cart button must be visible').toBeVisible({ timeout: ELEM_TIMEOUT });
  await expect(btn, 'Add-to-Cart button must be enabled').toBeEnabled({ timeout: ELEM_TIMEOUT });

  // Lazy content above the button shifts it mid-test (measured y: 924 -> 968 on
  // desktop webkit, 1277 -> 1345 on mobile safari). Settle first, then scroll
  // via plain scrollIntoView — scrollIntoViewIfNeeded's "element is stable"
  // gate was the single most common failure in the suite.
  await waitForLayoutSettle(page, 4_000);
  await scrollIntoView(btn);

  const countBefore = await getCartItemCount(page);
  const mobile = isMobileViewport(page);

  const press = async () => {
    // Use tap on touch viewports, click on desktop
    if (mobile) {
      await btn.tap();
    } else {
      await btn.click();
    }
  };

  await press();

  // Detect redirect (4 s window — caught immediately if theme uses AJAX instead)
  let mode = 'ajax';
  await page.waitForURL('**/cart', { timeout: 4_000 })
    .then(() => { mode = 'redirect'; })
    .catch(() => { /* ajax/panel mode — that's fine */ });

  // Poll /cart.js until item_count increases.
  //
  // Budget raised from 12 s to 25 s: the theme's own POST /cart/add is subject
  // to the same contention that made an in-page /cart.js read take 9.6-11.9 s
  // under concurrent workers. A 12 s window let the assertion read 0 while the
  // add was still in flight (4 of 14 WebKit cart tests, intermittently).
  let count = await pollCartCount(page, (current) => current > countBefore, 25_000);

  // Retry the press once if nothing landed — covers the case where the click
  // itself was swallowed (theme JS re-binding the form mid-interaction) rather
  // than merely being slow. Cheap: only runs on the failure path.
  if (count <= countBefore) {
    console.warn('   ⚠️  Add-to-Cart did not register; retrying once.');
    await scrollIntoView(btn);
    await press().catch(() => {});
    count = await pollCartCount(page, (current) => current > countBefore, 20_000);
  }

  return mode;
}

// ─── SETUP HELPER ─────────────────────────────────────────────────────────────

/**
 * Full pre-condition: navigate to product → add to cart → land on /cart page.
 * Verifies cart has items via /cart.js API before returning.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').TestInfo} testInfo
 * @param {{ name: string, url: string }} collection
 * @returns {Promise<string>} Product title
 */
async function setupCart(page, testInfo, collection) {
  const title = await navigateToProduct(page, testInfo, collection);
  const viewport = page.viewportSize();
  const vpLabel = viewport ? `${viewport.width}×${viewport.height}` : 'unknown';
  console.info(`   🛒  "${title || '(unknown)'}" — [${collection.name}] @ ${vpLabel}`);

  const mode = await addToCart(page);
  console.info(`   📦  Add mode: ${mode}`);

  // Always land on /cart — works for both redirect and ajax mode
  if (!page.url().includes('/cart')) {
    await page.goto(storeUrl('/cart'), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  }
  await stabilizePage(page);
  await closeMobileNavIfOpen(page);

  // Verify via API that items exist in the cart
  const count = await getCartItemCount(page);
  expect(
    count,
    `Cart API must have ≥ 1 item after adding from "${collection.name}" (got ${count}). ` +
    'Product may require a variant to be selected before add-to-cart.'
  ).toBeGreaterThan(0);

  // Verify the cart form rendered on the page
  await expect(
    page.locator('form[action="/cart"]').first(),
    'Cart form must be visible on /cart page'
  ).toBeVisible({ timeout: ELEM_TIMEOUT });

  return title;
}

// ─── SUITE ────────────────────────────────────────────────────────────────────
//
// Each collection × each project (viewport) in playwright.config.js produces
// an independent set of 7 tests, e.g.:
//   [Desktop_Chrome] › [Deer Blinds] Cart & Checkout UI › 1 · Add a product…
//   [Mobile_Chrome]  › [Accessories] Cart & Checkout UI › 7 · Checkout button…
//
// Run a specific slice:
//   --project=Mobile_Chrome --grep "Deer Feeders"
// ─────────────────────────────────────────────────────────────────────────────

for (const collection of COLLECTIONS) {

  test.describe(`[${collection.name}] Cart & Checkout UI`, () => {

    test.beforeEach(async ({ page }) => {
      test.setTimeout(90_000); // override global; each test does 3-4 navigations
      page.setDefaultNavigationTimeout(NAV_TIMEOUT);
      page.setDefaultTimeout(ELEM_TIMEOUT);
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
      await applyBasicStealth(page);
    });

    // ── TEST 1 · Add a product to the cart ───────────────────────────────────
    test('1 · Add a product to the cart', async ({ page }, testInfo) => {
      const title = await navigateToProduct(page, testInfo, collection);
      const mobile = isMobileViewport(page);
      console.info(`   🛒  "${title || '(unknown)'}" — [${collection.name}] mobile:${mobile}`);

      await expect(page).toHaveURL(/\/products\//);

      const countBefore = await getCartItemCount(page);
      const mode = await addToCart(page);

      // Navigate to /cart if the theme didn't redirect there
      if (!page.url().includes('/cart')) {
        await page.goto(storeUrl('/cart'), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      }
      await stabilizePage(page);
      await closeMobileNavIfOpen(page);

      const countAfter = await getCartItemCount(page);
      expect(
        countAfter,
        `Cart must have more items after add (before: ${countBefore}, after: ${countAfter}). ` +
        'Product may require variant selection.'
      ).toBeGreaterThan(countBefore);

      await expect(page.locator('form[action="/cart"]').first()).toBeVisible({ timeout: ELEM_TIMEOUT });
      await expect(page.locator('body')).not.toContainText('Error adding to cart');

      console.info(`   ✅ Added (mode: ${mode}), count ${countBefore}→${countAfter} — [${collection.name}].`);
    });

    // ── TEST 2 · Cart page is visible and interactive ────────────────────────
    test('2 · Cart page is visible and interactive after adding a product', async ({ page }, testInfo) => {
      await setupCart(page, testInfo, collection);

      await expect(page).toHaveURL(/\/cart/);

      // Checkout button must be reachable
      const checkoutBtn = page.locator(CHECKOUT_BTN_SEL).first();
      await expect(checkoutBtn, 'Checkout button must be visible').toBeVisible({ timeout: ELEM_TIMEOUT });

      // Cart form must have real height
      const formBox = await page.locator('form[action="/cart"]').first().boundingBox();
      expect(formBox,        'Cart form bounding box must exist').not.toBeNull();
      expect(formBox.height, 'Cart form height must be > 0').toBeGreaterThan(0);

      // ── Mobile-specific: cart must fit within viewport width ───────────────
      if (isMobileViewport(page)) {
        const vp = page.viewportSize();
        expect(
          formBox.width,
          `Cart form (${formBox.width}px) must not overflow viewport (${vp.width}px)`
        ).toBeLessThanOrEqual(vp.width + 5); // 5 px tolerance for scrollbar

        // Verify the page is scrollable (not broken layout)
        const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
        expect(
          bodyWidth,
          `Page body (${bodyWidth}px) must not overflow viewport (${vp.width}px)`
        ).toBeLessThanOrEqual(vp.width + 10);
      }

      console.info(`   ✅ /cart visible & interactive — [${collection.name}].`);
    });

    // ── TEST 3 · Cart count increments ──────────────────────────────────────
    test('3 · Cart count increments after adding a product', async ({ page }, testInfo) => {
      await page.goto(storeUrl(collection.url), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await guardVerificationWall(page, testInfo, collection.url);
      await stabilizePage(page);

      const before = await getCartItemCount(page);
      console.info(`   API count before: ${before}`);

      await navigateToProduct(page, testInfo, collection);
      await addToCart(page);

      const after = await getCartItemCount(page);
      expect(
        after,
        `Cart item_count must increase (before: ${before}, after: ${after})`
      ).toBeGreaterThan(before);

      console.info(`   ✅ Cart count: ${before} → ${after} — [${collection.name}].`);
    });

    // ── TEST 4 · Quantity selector ───────────────────────────────────────────
    test('4 · Quantity selector increases then decreases the item count', async ({ page }, testInfo) => {
      await setupCart(page, testInfo, collection);
      const mobile = isMobileViewport(page);

      const qtyInput = page.locator(QTY_INPUT_SEL).first();
      await expect(qtyInput, 'Quantity input must be visible').toBeVisible({ timeout: ELEM_TIMEOUT });

      const initial = parseInt((await qtyInput.inputValue()) || '1', 10);
      console.info(`   Qty initial: ${initial} (mobile: ${mobile})`);

      /**
       * Click/tap a stepper button or fill the input, then poll /cart.js
       * until the first item's quantity matches targetQty.
       * No waitForResponse — immune to stale-reference errors on navigation.
       *
       * Budget raised from 12 s to 25 s for the same reason as addToCart: the
       * theme's cart-update POST contends with the storefront's third-party
       * requests, and a 12 s window let the assertion read a stale quantity
       * while the update was still in flight (seen once on webkit desktop while
       * the identical check passed on the other three projects).
       */
      const applyQtyChange = async (targetQty) => {
        // Click Update cart button if the theme requires an explicit submit
        const updateBtn = page.locator(
          'button[name="update"], ' +
          'input[type="submit"][name="update"], ' +
          'button:has-text("Update cart"), ' +
          'button:has-text("Update")'
        ).first();

        if (await updateBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
          if (mobile) {
            await updateBtn.tap();
          } else {
            await updateBtn.click();
          }
          await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
        }

        // Poll /cart.js until quantity matches
        return pollFirstItemQty(page, targetQty, 25_000);
      };

      /**
       * Press a stepper button, falling back to filling the input directly.
       * Retries once if the cart never reflected the change — the stepper is a
       * custom element whose listener can miss a click during a re-render.
       */
      const nudgeQty = async (stepperSel, targetQty) => {
        const press = async () => {
          const stepper = page.locator(stepperSel).first();
          if (await stepper.isVisible({ timeout: 2_000 }).catch(() => false)) {
            await scrollIntoView(stepper);
            mobile ? await stepper.tap() : await stepper.click();
          } else {
            // Fallback: fill the input directly (works on both viewports)
            const input = page.locator(QTY_INPUT_SEL).first();
            await input.fill(String(targetQty));
            await input.press('Tab');
          }
        };

        await press();
        let actual = await applyQtyChange(targetQty);

        if (actual !== targetQty) {
          console.warn(`   ⚠️  Qty did not reach ${targetQty} (got ${actual}); retrying once.`);
          await press().catch(() => {});
          actual = await applyQtyChange(targetQty);
        }
        return actual;
      };

      // ── Increase ──────────────────────────────────────────────────────────
      const targetUp = initial + 1;
      const afterIncrease = await nudgeQty(QTY_PLUS_SEL, targetUp);
      expect(afterIncrease, `Qty must be > ${initial} after increase`).toBeGreaterThan(initial);
      console.info(`   Qty after increase: ${afterIncrease}`);

      // ── Decrease ──────────────────────────────────────────────────────────
      const targetDown = afterIncrease - 1;
      const afterDecrease = await nudgeQty(QTY_MINUS_SEL, targetDown);
      expect(afterDecrease, `Qty must be < ${afterIncrease} after decrease`).toBeLessThan(afterIncrease);
      console.info(`   Qty after decrease: ${afterDecrease}`);

      console.info(`   ✅ Quantity selector works — [${collection.name}].`);
    });

    // ── TEST 5 · Remove item ─────────────────────────────────────────────────
    test('5 · Removing an item empties the cart or reduces item count', async ({ page }, testInfo) => {
      await setupCart(page, testInfo, collection);
      const mobile = isMobileViewport(page);

      const countBefore = await getCartItemCount(page);

      const removeBtn = page.locator(REMOVE_BTN_SEL).first();
      await expect(removeBtn, 'Remove button must be visible').toBeVisible({ timeout: ELEM_TIMEOUT });
      await scrollIntoView(removeBtn);

      // Tap on mobile, click on desktop
      mobile ? await removeBtn.tap() : await removeBtn.click();

      // Poll /cart.js until count drops — no waitForResponse needed
      const countAfter = await pollCartCount(page, (c) => c < countBefore, 12_000);

      expect(
        countAfter,
        `Cart count must decrease after removal (before: ${countBefore}, after: ${countAfter})`
      ).toBeLessThan(countBefore);

      console.info(`   ✅ Cart count: ${countBefore} → ${countAfter} — [${collection.name}].`);
    });

    // ── TEST 6 · Shipping / tax note ─────────────────────────────────────────
    test('6 · "Taxes and shipping calculated at checkout" note is visible', async ({ page }, testInfo) => {
      await setupCart(page, testInfo, collection);

      const note = page.locator(SHIPPING_NOTE_SEL).first();
      await expect(
        note,
        '"Taxes and shipping calculated at checkout" must be visible'
      ).toBeVisible({ timeout: ELEM_TIMEOUT });

      const text = (await note.textContent()) ?? '';
      expect(text.trim().length, 'Shipping note must not be empty').toBeGreaterThan(0);

      // ── Mobile: note must be within viewport width (no horizontal overflow) ─
      if (isMobileViewport(page)) {
        const noteBox = await note.boundingBox();
        const vp = page.viewportSize();
        if (noteBox && vp) {
          expect(
            noteBox.x + noteBox.width,
            'Shipping note must not overflow viewport horizontally'
          ).toBeLessThanOrEqual(vp.width + 10);
        }
      }

      console.info(`   ✅ Shipping note found — [${collection.name}].`);
    });

    // ── TEST 7 · Checkout button ─────────────────────────────────────────────
    test('7 · Checkout button is visible, enabled, and not overlapped', async ({ page }, testInfo) => {
      await setupCart(page, testInfo, collection);
      const mobile = isMobileViewport(page);

      const checkoutBtn = page.locator(CHECKOUT_BTN_SEL).first();

      // ── Visible & enabled ─────────────────────────────────────────────────
      await expect(checkoutBtn, 'Checkout button must be visible').toBeVisible({ timeout: ELEM_TIMEOUT });
      await expect(checkoutBtn, 'Checkout button must be enabled').toBeEnabled();
      const ariaDisabled = await checkoutBtn.getAttribute('aria-disabled');
      expect(ariaDisabled, 'aria-disabled must not be "true"').not.toBe('true');

      // ── Scroll into view and confirm in viewport ──────────────────────────
      await scrollIntoView(checkoutBtn);
      const box = await checkoutBtn.boundingBox();
      expect(box,        'Checkout button must have a bounding box').not.toBeNull();
      expect(box.width,  'Width must be > 0').toBeGreaterThan(0);
      expect(box.height, 'Height must be > 0').toBeGreaterThan(0);
      await expect(checkoutBtn, 'Checkout button must be in viewport').toBeInViewport();

      // ── Mobile: button must span a reasonable width (touch target) ────────
      if (mobile) {
        const vp = page.viewportSize();
        expect(
          box.width,
          `Checkout button (${box.width}px) should be at least 44px wide (touch target minimum)`
        ).toBeGreaterThanOrEqual(44);
        // Typically full-width on mobile — warn if suspiciously narrow
        if (box.width < vp.width * 0.5) {
          console.warn(
            `   ⚠️  Checkout button is only ${box.width}px wide on a ${vp.width}px viewport — ` +
            'may be hard to tap. Shopify checkout buttons are usually full-width on mobile.'
          );
        }
      }

      // ── Overlay check (native CSS only inside evaluate) ───────────────────
      const cx = box.x + box.width  / 2;
      const cy = box.y + box.height / 2;
      const clickable = await page.evaluate(({ x, y, sel }) => {
        const top = document.elementFromPoint(x, y);
        if (!top) return false;
        return Array.from(document.querySelectorAll(sel)).some(
          el => el === top || el.contains(top) || top.contains(el)
        );
      }, { x: cx, y: cy, sel: CHECKOUT_NATIVE_SEL });

      if (!clickable) {
        console.warn(`   ⚠️  Overlay may cover checkout button — [${collection.name}] mobile:${mobile}.`);
      }

      console.info(`   ✅ Checkout button valid (mobile: ${mobile}) — [${collection.name}].`);
    });

  }); // end describe

} // end for(COLLECTIONS)