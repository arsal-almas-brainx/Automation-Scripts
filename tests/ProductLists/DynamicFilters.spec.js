// DynamicFilters.spec.js
const { test, expect } = require('@playwright/test');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BASE_URL = 'https://www.outdoorsforless.com';

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

  // Collect filter IDs from the DOM — IDs are stable across re-renders
  const filterIds = await container.evaluate(() => {
    const details = document.querySelectorAll('details[id*="Details-"]');
    return Array.from(details).map(el => el.id).filter(Boolean);
  });

  return filterIds;
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

  // Last resort: navigate back to clean collection URL (resets all filters)
  const currentUrl = page.url();
  const cleanUrl = currentUrl.split('?')[0];
  if (currentUrl !== cleanUrl) {
    await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
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

          // ── Count products before ─────────────────────────────────────────
          const countBefore = await page
            .locator('a[href*="/products/"]').count().catch(() => 0);

          // ── Interact (fresh ref inside) ───────────────────────────────────
          const result = await interactWithFilter(page, id, labelText);
          if (!result) continue;

          // ── Wait for grid update ──────────────────────────────────────────
          await waitForProductGridUpdate(page, 15000);

          const countAfter = await page
            .locator('a[href*="/products/"]').count().catch(() => 0);
          console.log(`  📦 Products: ${countBefore} → ${countAfter}`);

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

        console.log(`\n✅ Done [${viewport.name}] — ${collection.name}`);
      });
    }
  });
}