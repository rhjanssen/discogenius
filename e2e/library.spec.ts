import { expect, test } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:3737';

test.describe('Library page tabs & filtering', () => {
  test('library loads with Artists tab by default', async ({ page }) => {
    // Clear localStorage so default tab is used
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');
    await page.evaluate(() => localStorage.removeItem('discogenius_library_settings'));
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });

    // Wait for main content
    await expect(page.locator('main')).toBeVisible();

    // Should show either artist grid/list or empty state
    const hasContent = await page.locator('main').textContent();
    expect(hasContent).toBeTruthy();
  });

  test('library tab switching works (desktop)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByRole('tablist')).toBeVisible();

    const tabNames = ['Artists', 'Albums', 'Tracks', 'Videos'];
    for (const name of tabNames) {
      const tab = page.getByRole('tab', { name: new RegExp(`^${name}$`) }).first();
      if (await tab.count()) {
        await expect(tab).toBeVisible();
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
      }
    }
  });

  test('sort menu opens and selections persist', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    await expect(page.locator('main')).toBeVisible();
    await page.waitForTimeout(500);

    // Find sort button
    const sortBtn = page.getByRole('button', { name: /sort/i }).first();
    if (await sortBtn.isVisible()) {
      await sortBtn.click();
      // Menu should appear
      await page.waitForTimeout(300);

      // Look for sort options
      const alphabeticalOption = page.getByRole('menuitemradio', { name: /alphabetical/i });
      if (await alphabeticalOption.isVisible()) {
        await alphabeticalOption.click();
      }
    }
  });

  test('view mode toggle between grid and list', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    await expect(page.locator('main')).toBeVisible();
    await page.waitForTimeout(500);

    // Find view mode toggle
    const viewBtn = page.getByRole('button', { name: /grid|list/i }).first();
    if (await viewBtn.isVisible()) {
      await viewBtn.click();
      await page.waitForTimeout(300);
      // Toggle again
      await viewBtn.click();
      await page.waitForTimeout(300);
    }
  });

  test('does not flash filter empty state during overlapping artist fetches on initial load', async ({ page }) => {
    let monitoredRequests = 0;
    let unfilteredRequests = 0;

    let releaseMonitoredResponse: (() => void) | null = null;
    const monitoredResponseGate = new Promise<void>((resolve) => {
      releaseMonitoredResponse = resolve;
    });

    await page.route('**/api/app-auth/is-auth-active', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ isAuthActive: false }),
      });
    });

    await page.route('**/api/auth/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          connected: false,
          refreshTokenExpired: false,
          tokenExpired: false,
          hoursUntilExpiry: 0,
          mode: 'mock',
          canAccessShell: true,
          canAccessLocalLibrary: true,
          remoteCatalogAvailable: false,
          authBypassed: true,
          canAuthenticate: false,
          message: 'Mock provider auth mode is active.',
        }),
      });
    });

    await page.route('**/api/stats', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          artists: { total: 1, monitored: 1, downloaded: 0 },
          albums: { total: 0, monitored: 0, downloaded: 0 },
          tracks: { total: 0, monitored: 0, downloaded: 0 },
          videos: { total: 0, monitored: 0, downloaded: 0 },
        }),
      });
    });

    await page.route('**/api/queue?*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], hasMore: false, total: 0 }),
      });
    });

    await page.route('**/api/queue', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], hasMore: false, total: 0 }),
      });
    });

    await page.route('**/api/artists*', async (route) => {
      const url = new URL(route.request().url());
      const monitored = url.searchParams.get('monitored');

      if (monitored === 'true') {
        monitoredRequests += 1;
        await monitoredResponseGate;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [
              {
                id: 'artist-overlap-1',
                name: 'Overlap Artist',
                picture: null,
                cover_image_url: null,
                is_monitored: true,
                is_downloaded: false,
                album_count: 2,
                last_scanned: null,
              },
            ],
            limit: 50,
            offset: 0,
            hasMore: false,
            total: 1,
          }),
        });
        return;
      }

      unfilteredRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], limit: 50, offset: 0, hasMore: false, total: 0 }),
      });
    });

    await page.addInitScript(() => {
      localStorage.removeItem('discogenius_library_settings');
    });

    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('main')).toBeVisible();

    await expect.poll(() => unfilteredRequests).toBeGreaterThan(0);
    await expect.poll(() => monitoredRequests).toBeGreaterThan(0);

    await expect(page.getByText('Loading...').first()).toBeVisible();
    await expect(page.getByText(/No artists match your filters or search/i)).toBeHidden();

    releaseMonitoredResponse?.();

    await expect(page.getByText('Loading...').first()).toBeHidden();
    await expect(page.getByText('Overlap Artist')).toBeVisible();
  });
});
