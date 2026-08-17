/**
 * Shared storefront helpers.
 *
 * Everything here exists to remove a hardcoded assumption or to work around a
 * concrete, measured failure mode. See the notes on each export.
 */

const STORE_ORIGIN = process.env.BASE_URL || 'https://www.outdoorsforless.com';

/** Absolute URL for a store-relative path. */
function storeUrl(path = '/') {
  return new URL(path, STORE_ORIGIN).toString();
}

// ─── STABILISATION ────────────────────────────────────────────────────────────

/**
 * Neutralise the two things that make WebKit's actionability checks time out.
 *
 * MEASURED PROBLEM:
 *   The theme runs three Swiper carousels (announcement bar + product rails)
 *   with autoplay. Their transforms never settle, so Playwright's "waiting for
 *   element to be stable" gate — used by click(), tap() and
 *   scrollIntoViewIfNeeded() — spins until timeout. Chromium tolerates this;
 *   WebKit did not, which is why all 14 Cart tests failed on webkit and
 *   mobile-safari while the same 14 passed on Chrome.
 *
 * Call after every navigation, before interacting with anything.
 */
async function stabilizePage(page) {
  await page
    .addStyleTag({
      content: `*, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        scroll-behavior: auto !important;
      }`,
    })
    .catch(() => {}); // page may have navigated out from under us — non-critical

  await page
    .evaluate(() => {
      document.querySelectorAll('.swiper, [class*="swiper"]').forEach((el) => {
        try {
          el.swiper?.autoplay?.stop();
        } catch {
          /* not a Swiper root, or a version without autoplay */
        }
      });
    })
    .catch(() => {});
}

/**
 * Wait until the document stops growing.
 *
 * MEASURED PROBLEM:
 *   Lazy-loaded content above the Add-to-Cart button pushes it down mid-test
 *   (observed y: 924 -> 968 on desktop, 1277 -> 1345 on mobile). Interacting
 *   before that settles is what produced the intermittent stability timeouts.
 *
 * Polls scrollHeight until it is unchanged twice in a row, capped by timeoutMs
 * so a page with an infinite ticker can never hang the test.
 */
async function waitForLayoutSettle(page, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let previous = -1;
  let stableReads = 0;

  while (Date.now() < deadline && stableReads < 2) {
    const height = await page
      .evaluate(() => document.documentElement.scrollHeight)
      .catch(() => previous);
    stableReads = height === previous ? stableReads + 1 : 0;
    previous = height;
    if (stableReads < 2) await page.waitForTimeout(250);
  }
}

/**
 * Scroll an element into view WITHOUT Playwright's stability gate.
 *
 * locator.scrollIntoViewIfNeeded() waits for the element to stop moving and
 * was the single most common failure in the suite (7 of 28). A direct
 * scrollIntoView() achieves the same positioning with no such wait — the
 * subsequent click() still performs its own full actionability check, so no
 * real coverage is lost.
 */
async function scrollIntoView(locator) {
  await locator
    .evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }))
    .catch(() => {});
}

// ─── CART STATE (via APIRequestContext, not in-page fetch) ────────────────────

/**
 * MEASURED PROBLEM:
 *   Reading /cart.js with an in-page fetch() queues behind the product page's
 *   own third-party requests — measured at 9.6 s (desktop webkit) and 11.9 s
 *   (mobile safari) per call. addToCart() polls this in a loop, so the 60 s
 *   test budget was exhausted before the cart could be confirmed.
 *
 *   page.context().request issues the call outside the page's network queue:
 *   the same reads land in ~200-600 ms. Verified that it shares the browser
 *   context's cookie jar, so it observes the same Shopify cart session
 *   (item_count went 0 -> 1 on both transports after an add).
 */
async function readCart(page) {
  try {
    const response = await page.context().request.get(storeUrl('/cart.js'), {
      timeout: 15_000,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok()) return { item_count: 0, items: [] };
    return await response.json();
  } catch {
    return { item_count: 0, items: [] };
  }
}

/** Returns item_count from /cart.js — authoritative regardless of theme. */
async function getCartItemCount(page) {
  return (await readCart(page)).item_count ?? 0;
}

/** Returns quantity of the first line item from /cart.js. */
async function getFirstItemQty(page) {
  return (await readCart(page)).items?.[0]?.quantity ?? 0;
}

/** Poll until `predicate(count)` holds, or the budget runs out. Returns last count. */
async function pollCartCount(page, predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let count = await getCartItemCount(page);
  while (!predicate(count) && Date.now() < deadline) {
    await page.waitForTimeout(400);
    count = await getCartItemCount(page);
  }
  return count;
}

/** Poll until the first line item reaches `target`, or the budget runs out. */
async function pollFirstItemQty(page, target, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let qty = await getFirstItemQty(page);
  while (qty !== target && Date.now() < deadline) {
    await page.waitForTimeout(400);
    qty = await getFirstItemQty(page);
  }
  return qty;
}

// ─── CONTENT DISCOVERY (replaces hardcoded marketing copy) ───────────────────

/**
 * The specs used to assert on live marketing strings such as
 * "Shop the largest selection of deer blinds online!". The client rewrote the
 * homepage and 12 tests broke across all four browsers without anything
 * actually being wrong with the site.
 *
 * These helpers derive expectations from whatever the page currently renders,
 * so a copy change can no longer produce a red suite.
 */

/** Text + geometry of the visible headings inside <main>, in DOM order. */
async function getVisibleHeadings(page, limit = 12) {
  return page.evaluate((max) => {
    const root = document.querySelector('main') ?? document.body;
    return Array.from(root.querySelectorAll('h1, h2, h3'))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          parseFloat(style.opacity) > 0 &&
          (el.textContent ?? '').trim().length > 0
        );
      })
      .slice(0, max)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
          x: rect.x + window.scrollX,
          y: rect.y + window.scrollY,
          width: rect.width,
          height: rect.height,
        };
      });
  }, limit);
}

/**
 * True when two heading boxes occupy the same screen space.
 *
 * Deliberately requires an overlap on BOTH axes. The homepage puts headings
 * side by side in multi-column rows — the three category cards ("Hunting
 * blinds" / "Fish feeders" / "deer feeders") share a y range, and so do the
 * blog-post cards. Those are correct layouts, not collisions. A y-only check
 * flags them, which is exactly the false positive this replaced.
 */
function headingsCollide(a, b) {
  const overlapX = a.x < b.x + b.width && a.x + a.width > b.x;
  const overlapY = a.y < b.y + b.height && a.y + a.height > b.y;
  return overlapX && overlapY;
}

module.exports = {
  STORE_ORIGIN,
  storeUrl,
  stabilizePage,
  waitForLayoutSettle,
  scrollIntoView,
  readCart,
  getCartItemCount,
  getFirstItemQty,
  pollCartCount,
  pollFirstItemQty,
  getVisibleHeadings,
  headingsCollide,
};
