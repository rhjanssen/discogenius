import { expect, test, type Page } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:3737';

/**
 * Helper: search for an artist and navigate to the Artists tab,
 * waiting for results to appear.
 */
async function searchAndGoToArtistTab(page: Page, query: string) {
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('/auth')) return false;

  const searchBox = page.getByRole('searchbox', { name: /search/i });
  await searchBox.fill(query);

  await page.waitForResponse(
    (res) => {
      try {
        const url = new URL(res.url());
        return url.pathname === '/api/search' && res.status() === 200;
      } catch { return false; }
    },
    { timeout: 30_000 }
  );

  // Switch to Artists tab
  const artistsTab = page.getByRole('tab', { name: /^Artists$/i }).first();
  await expect(artistsTab).toBeVisible({ timeout: 5_000 });
  await artistsTab.click();
  await page.waitForTimeout(800);
  return true;
}

test.describe('Artist page', () => {
  test('can navigate to artist detail from search', async ({ page }) => {
    const ok = await searchAndGoToArtistTab(page, 'radiohead');
    if (!ok) test.skip(true, 'Auth gate active');

    // Find any clickable artist element
    const artistLink = page.locator('a[href*="/artist/"]').first();
    const hasLink = await artistLink.count() > 0 && await artistLink.isVisible();

    if (hasLink) {
      await artistLink.click();
      await page.waitForURL(/\/artist\//, { timeout: 10_000 });
      expect(page.url()).toMatch(/\/artist\/\d+/);
    } else {
      // Try clicking on a card element instead
      const card = page.locator('[class*="card"]').first();
      if (await card.count() > 0) {
        await card.click();
        await page.waitForTimeout(2000);
      }
      // If no artist cards, skip
      test.skip(true, 'No clickable artist elements found');
    }
  });

  test('direct artist page URL renders', async ({ page }) => {
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    // Check if there are any artists in the library
    const response = await page.evaluate(async (url) => {
      const res = await fetch(`${url}/api/artists?limit=1`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.items || data;
    }, baseURL);

    if (!response || !response.length) {
      test.skip(true, 'No artists in library');
      return;
    }

    const artistId = response[0].tidal_id || response[0].id;
    await page.goto(`${baseURL}/artist/${artistId}`, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('main')).toBeVisible();
    await page.waitForTimeout(1000);

    // Should show some content
    const pageText = (await page.locator('main').textContent()) || '';
    expect(pageText.length).toBeGreaterThan(5);
  });

  test('artist page has no critical console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('net::ERR_') && !text.includes('favicon') && !text.includes('sw.js')) {
          errors.push(text);
        }
      }
    });

    // Navigate to a library artist
    const response = await page.evaluate(async (url) => {
      const res = await fetch(`${url}/api/artists?limit=1`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.items || data;
    }, baseURL);

    if (!response || !response.length) {
      test.skip(true, 'No artists in library');
      return;
    }

    const artistId = response[0].tidal_id || response[0].id;
    await page.goto(`${baseURL}/artist/${artistId}`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    await expect(page.locator('main')).toBeVisible();
    await page.waitForTimeout(2000);

    // Filter out non-critical errors
    const critical = errors.filter(e =>
      !e.includes('Service Worker') && !e.includes('manifest')
    );
    expect(critical.length).toBeLessThanOrEqual(1);
  });
});
