// DynamicFilters.spec.js
const { test, expect } = require('@playwright/test');
const { STORE_ORIGIN, stabilizePage } = require('../../utils/site');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BASE_URL = STORE_ORIGIN;

// Define collections as plain objects — always use collection.url in goto()
const COLLECTIONS = [
  { name: 'Deer Blinds', url: '/collections/deer-blinds' },
  // { name: 'Deer Feeders', url: '/collections/deer-feeders' },
  // { name: 'Accessories', url: '/collections/accessories' },
  // { name: 'Fish Feeders', url: '/collections/fish-feeders' },
  // { name: 'Boats', url: '/collections/bass-boat' },
  // { name: 'Sale', url: '/collections/sale' },
];

const MAX_FILTERS_TO_TEST = 5;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function getCollectionTimeouts(collectionName) {
  // Some collections can be materially slower to render due to heavy content,
  // redirects, or backend/cache variability.
  const slowCollections = new Set(['Boats', 'Sale']);
  const isSlow = slowCollections.has(collectionName);
  return {
    // This test can take >60s because it applies + resets multiple filters and
    // each step has its own bounded waits. Keep `goto` tighter, but allow the
    // overall scenario to complete.
    testTimeoutMs: isSlow ? 240000 : 180000,
    gotoTimeoutMs: isSlow ? 90000 : 60000,
  };
}

async function gotoCollection(page, url, timeoutMs) {
  // First try: fast signal to proceed.
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch (e) {
    // One retry helps with transient network stalls / CDN cold caches.
    await page.waitForTimeout(1500);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  }

  // If there are long-running requests (analytics, etc.), don't block forever.
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  // Halt the theme's autoplaying Swiper carousels — they keep Playwright's
  // "element is stable" gate open until timeout on WebKit.
  await stabilizePage(page);
}

/**
 * Wait for Dawn's product grid AJAX update to complete.
 * Dawn's facets.js toggles a `loading` class on the grid container.
 */
async function waitForProductGridUpdate(page, timeout = 15000) {
  try {
    await page.waitForFunction(() => {
      const grid = document.querySelector(
        '#product-grid, .product-grid-container, [id*="ProductGrid"]'
      );
      if (!grid) return true;
      return (
        !grid.classList.contains('loading') &&
        !grid.classList.contains('is-loading') &&
        !grid.getAttribute('aria-busy')
      );
    }, { timeout });
  } catch {
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  }
}

/**
 * Re-query filter sections fresh from the DOM on every call.
 * This avoids stale element references after AJAX re-renders.
 * Returns a list of { element, label, id } objects.
 */
async function getFilterSections(page, isMobile) {
  const containerSelector = isMobile
    ? '#FacetFiltersFormMobile, .mobile-facets__form, .mobile-facets__wrapper'
    : '#FacetFiltersForm, .facets__form-vertical, form[id*="FacetFilter"]';

  const container = page.locator(containerSelector).first();
  await expect(container).toBeVisible({ timeout: 10000 });

  // Collect filter IDs from the DOM — IDs are stable across re-renders.
  //
  // NOTE: this callback MUST query `root`, not `document`. It used to query
  // `document`, which silently ignored the container it was handed and matched
  // every <details id*="Details-"> on the page — 39 of them, the first 20+
  // being header nav menus (Details-HeaderMenu-1, Details-HeaderSubMenu-4, …).
  // With MAX_FILTERS_TO_TEST = 5 the loop never reached a single real facet,
  // so this spec was clicking navigation links and reporting the resulting
  // collection change as a working filter — while passing green.
  // Scoped correctly it returns 11 facets on desktop / 12 on mobile:
  // In stock only, Category, Price, Brand, Blind Size, Insulation, …
  const filterIds = await container.evaluate((root) => {
    const details = root.querySelectorAll('details[id*="Details-"]');
    return Array.from(details).map(el => el.id).filter(Boolean);
  });

  return filterIds;
}

/**
 * Snapshot of what "the grid is currently filtered by" looks like, used to
 * assert that interacting with a facet actually changed something.
 *
 * The old spec logged `countBefore -> countAfter` and asserted nothing at all,
 * so it could not fail regardless of whether filtering worked.
 */
async function getFilterState(page) {
  return page.evaluate(() => ({
    // Shopify Dawn encodes active facets as filter.* query params
    filterParams: Array.from(new URLSearchParams(window.location.search).keys())
      .filter(k => k.startsWith('filter.') || k === 'sort_by')
      .sort()
      .join(','),
    // Active-facet "pills" rendered above the grid
    activePills: document.querySelectorAll(
      '.active-facets__button, [class*="active-facet"] a, .facets-remove a'
    ).length,
    productCount: document.querySelectorAll('a[href*="/products/"]').length,
  }));
}

/** True when any observable facet signal differs between two snapshots. */
function filterStateChanged(before, after) {
  return (
    after.filterParams !== before.filterParams ||
    after.activePills !== before.activePills ||
    after.productCount !== before.productCount
  );
}

/**
 * Poll getFilterState until it differs from `before`, or the budget expires.
 * Returns the last snapshot either way — the caller does the asserting.
 */
async function waitForFilterStateChange(page, before, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let current = await getFilterState(page);
  while (!filterStateChanged(before, current) && Date.now() < deadline) {
    await page.waitForTimeout(400);
    current = await getFilterState(page);
  }
  return current;
}

/**
 * Get a fresh locator for a filter section by its stable DOM id.
 * Always call this instead of caching the element reference.
 */
function getFilterById(page, id) {
  return page.locator(`#${CSS.escape(id)}`).first();
}

// CSS.escape polyfill for Node (Playwright runs in Node context for locators)
const CSS = {
  escape: (str) => str.replace(/([^\w-])/g, '\\$1')
};

/**
 * Open a <details> filter section using its stable ID.
 */
async function openFilterSection(page, id) {
  const el = getFilterById(page, id);
  const isOpen = await el.evaluate(node => node.hasAttribute('open'));
  if (!isOpen) {
    const summary = el.locator('> summary').first();
    await summary.evaluate(node => node.scrollIntoView({ block: 'center' }));
    await summary.dispatchEvent('click');
    await page.waitForTimeout(350);
  }
}

/**
 * Get the label text of a filter section by its ID.
 */
async function getFilterLabel(page, id) {
  try {
    const el = getFilterById(page, id);
    const text = await el.locator('> summary').first().innerText();
    return text.trim();
  } catch {
    return id;
  }
}

/**
 * Interact with a filter section by its stable ID.
 * Re-queries the element fresh each time to avoid stale refs.
 */
async function interactWithFilter(page, id, labelText) {
  // Always get a fresh reference
  const filterEl = getFilterById(page, id);

  // ── 1. CHECKBOX (Dawn: hidden <input>, visible <label.facet-checkbox>) ────
  const facetLabels = filterEl.locator(
    'label.facet-checkbox:not(.facet-checkbox--disabled)'
  );
  if (await facetLabels.count() > 0) {
    const label = facetLabels.first();
    await label.evaluate(el => el.scrollIntoView({ block: 'center' }));
    await label.dispatchEvent('click');
    console.log(`  ✔ Checkbox clicked: ${labelText}`);
    return 'checkbox';
  }

  // ── 2. TOGGLE ("In stock only") ───────────────────────────────────────────
  // Dawn renders this as a styled <input type="checkbox"> with a custom label
  const toggleInput = filterEl.locator(
    'input[type="checkbox"].facets__toggle, ' +
    'input[type="checkbox"][name*="availability"], ' +
    'input[type="checkbox"][name*="stock"]'
  ).first();
  if (await toggleInput.count() > 0) {
    // The label is the clickable element, not the hidden input
    const inputId = await toggleInput.getAttribute('id');
    const toggleLabel = inputId
      ? page.locator(`label[for="${inputId}"]`).first()
      : filterEl.locator('label').first();
    await toggleLabel.evaluate(el => el.scrollIntoView({ block: 'center' }));
    await toggleLabel.dispatchEvent('click');
    console.log(`  ✔ Toggle clicked: ${labelText}`);
    return 'toggle';
  }

  // ── 3. PRICE RANGE SLIDER ─────────────────────────────────────────────────
  const slider = filterEl.locator('input[type="range"]').first();
  if (await slider.count() > 0) {
    const [min, max] = await slider.evaluate(el => [
      parseFloat(el.min) || 0,
      parseFloat(el.max) || 1000
    ]);
    const midValue = String(Math.round((min + max) / 2));
    await slider.evaluate((el, val) => {
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, midValue);
    console.log(`  ✔ Slider → ${midValue}: ${labelText}`);
    return 'slider';
  }

  // ── 4. LINK FILTERS (Category, Brand) ─────────────────────────────────────
  const links = filterEl.locator('ul a, li a').filter({
    hasNotText: /remove|clear|reset|×/i
  });
  if (await links.count() > 0) {
    const link = links.first();
    await link.evaluate(el => el.scrollIntoView({ block: 'center' }));
    const navPromise = page.waitForNavigation({ timeout: 8000 }).catch(() => null);
    await link.dispatchEvent('click');
    await navPromise;
    console.log(`  ✔ Link clicked: ${labelText}`);
    return 'link';
  }

  console.log(`  ⚠ Nothing interactable: ${labelText}`);
  return null;
}

/**
 * Reset all active filters. Dawn uses <a> tags, not <button>, for removal.
 */
async function resetAllFilters(page) {
  // "Remove all" link
  const removeAll = page.locator('a').filter({ hasText: /remove all/i }).first();
  if (await removeAll.count() > 0 && await removeAll.isVisible()) {
    await removeAll.click();
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
    return;
  }

  // Individual active filter pill
  const pill = page.locator(
    '.active-facets__button, [class*="active-facet"] a, .facets-remove a'
  ).first();
  if (await pill.count() > 0 && await pill.isVisible()) {
    await pill.click();
    await waitForProductGridUpdate(page, 10000);
    return;
  }

  // Last resort: navigate back to clean collection URL (resets all filters).
  // Uses gotoCollection's retry rather than a bare goto — a single 15 s
  // attempt here timed out on an otherwise-passing run when the storefront
  // was slow under concurrent workers.
  const currentUrl = page.url();
  const cleanUrl = currentUrl.split('?')[0];
  if (currentUrl !== cleanUrl) {
    await gotoCollection(page, cleanUrl, 30000);
  }
}

/**
 * Open the mobile filter drawer.
 * The trigger button may be hidden behind a sticky header until scrolled.
 */
async function openMobileDrawer(page) {
  // On the current theme, the mobile facets accordion (#FacetFiltersFormMobile
  // / .mobile-facets__wrapper) renders inline and visible on page load — there
  // is no hidden drawer to open. The ".toggle--facetFilter" button lives inside
  // the *desktop* filter form (hidden on mobile via the "small-hide" class,
  // permanently zero-width there), so waiting for or clicking it on mobile
  // always failed/hung. Treat "already visible" as the common case and only
  // fall back to a trigger click if the theme reverts to a real drawer pattern.
  const drawer = page.locator(
    '#FacetFiltersFormMobile, ' +
    '.mobile-facets__form, ' +
    '.mobile-facets__wrapper'
  ).first();

  if (await drawer.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('📱 Mobile facets already visible — no drawer trigger needed');
    return;
  }

  // Scroll to top first — the filter button is in the sticky header area
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  // Try multiple selector strategies
  const trigger = page.locator(
    '.toggle--facetFilter, ' +
    'button[aria-controls*="FacetFiltersFormMobile"], ' +
    'button[aria-controls*="MobileFacet"], ' +
    '[data-drawer*="filter"]'
  ).first();

  await expect(trigger).toBeVisible({ timeout: 15000 });
  await trigger.evaluate(el => el.click());
  console.log('📱 Mobile drawer trigger clicked (JS)');

  await expect(drawer).toBeVisible({ timeout: 8000 });
  console.log('📱 Mobile drawer is open');
}

// ─── TEST SUITE ───────────────────────────────────────────────────────────────

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile',  width: 390,  height: 844 },
];

for (const collection of COLLECTIONS) {
  test.describe(`Product Listing Page › Collection: ${collection.name}`, () => {

    for (const viewport of VIEWPORTS) {
      test(`All filters work dynamically [${viewport.name}]`, async ({ page }) => {
        const { testTimeoutMs, gotoTimeoutMs } = getCollectionTimeouts(collection.name);
        test.setTimeout(testTimeoutMs);

        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const isMobile = viewport.width < 768;

        // ── Navigate ──────────────────────────────────────────────────────────
        await gotoCollection(page, `${BASE_URL}${collection.url}`, gotoTimeoutMs);

        // ── Dismiss cookie/consent overlays ───────────────────────────────────
        const cookieBtn = page.locator(
          '[id*="cookie"] button, [class*="cookie"] button, ' +
          '[id*="consent"] button, [class*="consent"] button'
        ).first();
        if (await cookieBtn.count() > 0 && await cookieBtn.isVisible()) {
          await cookieBtn.click().catch(() => {});
          await page.waitForTimeout(300);
        }

        // ── Mobile: open drawer ────────────────────────────────────────────────
        if (isMobile) {
          await openMobileDrawer(page);
        }

        // ── Get stable filter IDs (re-query after every mutation) ─────────────
        let filterIds = await getFilterSections(page, isMobile);
        console.log(`\n🔍 Found ${filterIds.length} filter sections [${viewport.name}]`);

        if (filterIds.length === 0) {
          const containerSelector = isMobile
            ? '#FacetFiltersFormMobile, .mobile-facets__form, .mobile-facets__wrapper'
            : '#FacetFiltersForm, .facets__form-vertical, form[id*="FacetFilter"]';
          const html = await page.locator(containerSelector).first()
            .innerHTML().catch(() => '(unreadable)');
          console.warn('⚠ No filters found. HTML snippet:\n', html.slice(0, 2000));
          test.skip();
          return;
        }

        const limit = Math.min(filterIds.length, MAX_FILTERS_TO_TEST);
        let appliedCount = 0;

        for (let i = 0; i < limit; i++) {
          // ── Re-query IDs fresh (AJAX may have re-rendered the form) ──────────
          filterIds = await getFilterSections(page, isMobile);
          if (i >= filterIds.length) break;

          const id = filterIds[i];
          const labelText = await getFilterLabel(page, id);

          console.log(`\n👉 [${i + 1}/${limit}] ${labelText} (id: ${id})`);

          // Skip outer drawer wrapper if it sneaks in
          if (/filter and sort/i.test(labelText)) {
            console.log('  ⏭ Skipping outer drawer');
            continue;
          }

          // ── Open section (fresh ref) ──────────────────────────────────────
          await openFilterSection(page, id);

          // ── Snapshot state before ─────────────────────────────────────────
          const before = await getFilterState(page);

          // ── Interact (fresh ref inside) ───────────────────────────────────
          const result = await interactWithFilter(page, id, labelText);
          if (!result) continue;

          // ── Wait for grid update ──────────────────────────────────────────
          await waitForProductGridUpdate(page, 15000);

          // Dawn applies facets over AJAX and only then rewrites the URL, so
          // reading the state immediately after the grid loses its `loading`
          // class can catch the page mid-flight (observed: params ""→"",
          // products 63→63 for a facet that did in fact apply a moment later).
          // Poll for an observable change instead of sampling once.
          const after = await waitForFilterStateChange(page, before, 10000);
          console.log(
            `  📦 Products: ${before.productCount} → ${after.productCount} | ` +
            `params: "${before.filterParams}" → "${after.filterParams}" | ` +
            `pills: ${before.activePills} → ${after.activePills}`
          );

          // ── ASSERT the facet actually did something ───────────────────────
          //
          // A product count that happens to stay the same is legitimate (a
          // facet can match every product), so the count alone is too weak.
          // Applying a facet must change at least one observable: the
          // filter.* query params, the active-facet pills, or the grid size.
          appliedCount++;
          expect(
            filterStateChanged(before, after),
            `Filter "${labelText}" (${result}) produced no observable change — ` +
            `params "${before.filterParams}" → "${after.filterParams}", ` +
            `pills ${before.activePills} → ${after.activePills}, ` +
            `products ${before.productCount} → ${after.productCount}`
          ).toBeTruthy();

          // ── Reset ─────────────────────────────────────────────────────────
          await resetAllFilters(page);
          await waitForProductGridUpdate(page, 10000);

          // ── Mobile: re-open drawer if it closed after reset ───────────────
          if (isMobile) {
            const drawerVisible = await page.locator(
              '#FacetFiltersFormMobile, .mobile-facets__form, .mobile-facets__wrapper'
            ).first().isVisible().catch(() => false);

            if (!drawerVisible) {
              await openMobileDrawer(page);
            }
          }
        }

        // Guard against the whole loop silently no-op'ing (every section
        // reporting "nothing interactable"), which would otherwise let this
        // test pass having exercised no filter at all.
        expect(
          appliedCount,
          `Expected to apply at least one filter on [${viewport.name}], but none were interactable`
        ).toBeGreaterThan(0);

        console.log(`\n✅ Done [${viewport.name}] — ${collection.name} (${appliedCount} filters applied)`);
      });
    }
  });
}