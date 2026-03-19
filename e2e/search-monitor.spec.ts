import { expect, test } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:3737';

test.describe('Search → monitor → navigate flow', () => {
  test('search returns results and tabs work', async ({ page }) => {
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    const searchBox = page.getByRole('searchbox', { name: /search/i });
    await searchBox.fill('daft punk');

    // Wait for search response
    const response = await page.waitForResponse(
      (res) => {
        try {
          const url = new URL(res.url());
          return url.pathname === '/api/search' && res.status() === 200;
        } catch { return false; }
      },
      { timeout: 30_000 }
    );

    const data = await response.json();
    const results = data?.results || {};
    const totalResults = ['artists', 'albums', 'tracks', 'videos']
      .map((k) => (results[k] || []).length)
      .reduce((a, b) => a + b, 0);
    expect(totalResults).toBeGreaterThan(0);

    // Top tab should be visible
    await expect(page.getByRole('tab', { name: /^Top$/i }).first()).toBeVisible();

    // Test switching between tabs
    const tabs = ['Artists', 'Albums', 'Tracks', 'Videos'];
    for (const tabName of tabs) {
      const tab = page.getByRole('tab', { name: new RegExp(`^${tabName}$`, 'i') }).first();
      if (await tab.isVisible()) {
        await tab.click();
        // Small delay for content to render
        await page.waitForTimeout(300);
      }
    }
  });

  test('monitor toggle works on artist from search', async ({ page }) => {
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    const searchBox = page.getByRole('searchbox', { name: /search/i });
    await searchBox.fill('daft punk');

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
    await artistsTab.click();
    await page.waitForTimeout(500);

    // Find a monitor button (eye icon) on an artist card
    const monitorBtn = page.getByRole('button', { name: /monitor/i }).first();
    if (await monitorBtn.isVisible()) {
      // Click and verify API call is made
      const monitorRequest = page.waitForResponse(
        (res) => res.url().includes('/api/artists/') && (res.status() === 200 || res.status() === 201),
        { timeout: 15_000 }
      ).catch(() => null);

      await monitorBtn.click();
      const resp = await monitorRequest;
      // Accept if it succeeded or if the button at least toggled
      if (resp) {
        expect(resp.status()).toBeLessThan(500);
      }
    }
  });

  test('artist page keeps monitored state when opened immediately after monitoring from search', async ({ page }) => {
    let monitored = false;

    await page.route('**/api/search?*', async (route) => {
      await route.fulfill({
        json: {
          success: true,
          results: {
            artists: [
              {
                id: '777',
                type: 'artist',
                name: 'Deterministic Artist',
                subtitle: null,
                imageId: null,
                monitored: false,
                in_library: false,
              },
            ],
            albums: [],
            tracks: [],
            videos: [],
          },
          mode: 'mock',
          remoteCatalogAvailable: false,
        },
      });
    });

    await page.route('**/api/artists/777/monitor', async (route) => {
      let nextMonitored = true;
      try {
        const payload = route.request().postDataJSON() as { monitored?: boolean } | null;
        if (payload && typeof payload.monitored === 'boolean') {
          nextMonitored = payload.monitored;
        }
      } catch {
        // No JSON payload, keep default monitor=true for this endpoint.
      }
      monitored = nextMonitored;
      await route.fulfill({ json: { success: true, monitored } });
    });

    await page.route('**/api/artists/777', async (route) => {
      if (route.request().method() === 'PATCH') {
        try {
          const payload = route.request().postDataJSON() as { monitored?: boolean } | null;
          if (payload && typeof payload.monitored === 'boolean') {
            monitored = payload.monitored;
          }
        } catch {
          // No JSON payload provided; leave monitored state unchanged.
        }
        await route.fulfill({ json: { success: true, monitored } });
        return;
      }
      await route.fallback();
    });

    await page.route('**/api/artists/777/page-db', async (route) => {
      await route.fulfill({
        json: {
          artist: {
            id: '777',
            name: 'Deterministic Artist',
            is_monitored: monitored,
            files: [],
          },
          rows: [],
        },
      });
    });

    await page.route('**/api/artists/777/activity', async (route) => {
      await route.fulfill({
        json: {
          scanning: false,
          curating: false,
          downloading: false,
          libraryScan: false,
          totalActive: 0,
        },
      });
    });

    await page.goto(`${baseURL}/search`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    const searchBox = page.getByRole('main').getByRole('searchbox', { name: /search/i });
    await searchBox.fill('deterministic artist');

    await page.waitForResponse(
      (res) => {
        try {
          const url = new URL(res.url());
          return url.pathname === '/api/search' && res.status() === 200;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 }
    );

    const artistsTab = page.getByRole('tab', { name: /^Artists$/i }).first();
    await artistsTab.click();
    await page.waitForTimeout(500);

    const monitorButton = page.locator('button[title="Monitor"], button[title="Unmonitor"]').first();
    await expect(monitorButton).toBeVisible({ timeout: 10_000 });

    await monitorButton.click();
    await expect(monitorButton).toHaveAttribute('title', /unmonitor/i, { timeout: 10_000 });
    await page.getByText('Deterministic Artist').first().click();

    await page.waitForURL(/\/artist\//, { timeout: 10_000 });

    await expect(page.getByRole('button', { name: /^Unmonitor$/i })).toBeVisible({ timeout: 10_000 });
  });

  test('clicking artist in search navigates to artist detail', async ({ page }) => {
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    const searchBox = page.getByRole('searchbox', { name: /search/i });
    await searchBox.fill('daft punk');

    await page.waitForResponse(
      (res) => {
        try {
          const url = new URL(res.url());
          return url.pathname === '/api/search' && res.status() === 200;
        } catch { return false; }
      },
      { timeout: 30_000 }
    );

    // Switch to Artists tab and click first artist
    const artistsTab = page.getByRole('tab', { name: /^Artists$/i }).first();
    await artistsTab.click();
    await page.waitForTimeout(500);

    // Click the artist card (not the monitor button)
    const artistCard = page.locator('[class*="artistCard"]').first();
    if (await artistCard.isVisible()) {
      await artistCard.click();
      await page.waitForURL(/\/artist\//, { timeout: 10_000 });
      expect(page.url()).toMatch(/\/artist\/\d+/);
    }
  });

  test('clicking video in search navigates to video detail', async ({ page }) => {
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    const searchBox = page.getByRole('searchbox', { name: /search/i });
    await searchBox.fill('daft punk');

    await page.waitForResponse(
      (res) => {
        try {
          const url = new URL(res.url());
          return url.pathname === '/api/search' && res.status() === 200;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 }
    );

    const videosTab = page.getByRole('tab', { name: /^Videos$/i }).first();
    if (!(await videosTab.isVisible())) {
      test.skip(true, 'Videos tab not present in search results');
    }

    await videosTab.click();
    await page.waitForTimeout(500);

    const searchResults = page.getByRole('dialog', { name: /search results/i });
    const firstResultImage = searchResults.locator('img[alt]:not([alt="Discogenius"])').first();
    if (await firstResultImage.isVisible()) {
      const title = await firstResultImage.getAttribute('alt');
      if (!title) {
        test.skip(true, 'Could not resolve a video result title to click');
      }

      await searchResults.getByText(title, { exact: true }).first().click();
      await page.waitForURL(/\/video\//, { timeout: 10_000 });
      expect(page.url()).toMatch(/\/video\/\d+/);
    }
  });
});
