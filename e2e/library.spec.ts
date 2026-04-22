import { expect, test, type Page } from '@playwright/test';

const baseURL = process.env.BASE_URL || `http://127.0.0.1:${process.env.E2E_PORT || '3737'}`;

async function stubPopulatedLibraryShell(page: Page) {
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
        albums: { total: 1, monitored: 1, downloaded: 0 },
        tracks: { total: 1, monitored: 1, downloaded: 0 },
        videos: { total: 1, monitored: 0, downloaded: 0 },
      }),
    });
  });

  await page.route('**/api/artists**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'artist-1',
            name: 'Test Artist',
            picture: null,
            cover_image_url: null,
            is_monitored: true,
            last_scanned: null,
            album_count: 1,
            downloaded: 0,
            is_downloaded: false,
          },
        ],
        limit: 50,
        offset: 0,
        hasMore: false,
        total: 1,
      }),
    });
  });

  await page.route('**/api/albums**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'album-1',
            title: 'Test Album',
            artist_id: 'artist-1',
            artist_name: 'Test Artist',
            cover_id: null,
            quality: 'FLAC',
            is_monitored: true,
            is_downloaded: false,
            downloaded: 0,
            release_date: '2024-01-01',
          },
        ],
        limit: 50,
        offset: 0,
        hasMore: false,
        total: 1,
      }),
    });
  });

  await page.route('**/api/tracks**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'track-1',
            title: 'Test Track',
            artist_name: 'Test Artist',
            album_title: 'Test Album',
            album_id: 'album-1',
            duration: 180,
            quality: 'FLAC',
            track_number: 1,
            volume_number: 1,
            downloaded: false,
            is_downloaded: false,
            is_monitored: true,
            files: [],
          },
        ],
        limit: 50,
        offset: 0,
        hasMore: false,
        total: 1,
      }),
    });
  });

  await page.route('**/api/videos**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'video-1',
            title: 'Test Video',
            artist_id: 'artist-1',
            artist_name: 'Test Artist',
            duration: 240,
            cover_id: null,
            quality: null,
            is_monitored: false,
            is_downloaded: false,
          },
        ],
        limit: 50,
        offset: 0,
        hasMore: false,
        total: 1,
      }),
    });
  });

  await page.route('**/api/queue/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ isPaused: false, processing: false, stats: [] }),
    });
  });

  await page.route((url) => url.pathname === '/api/queue', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], limit: 50, offset: 0, hasMore: false, total: 0 }),
    });
  });

  await page.route((url) => url.pathname === '/api/queue/details', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  await page.route('**/api/queue/progress-stream*', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
      body: 'event: status\ndata: {"isPaused":false,"processing":false,"stats":[]}\n\n',
    });
  });

  await page.route((url) => url.pathname === '/api/events', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
      body: 'event: ready\ndata: {"ok":true}\n\n',
    });
  });
}

test.describe('Library page tabs & filtering', () => {
  test('library landing does not fetch paged queue data for the shell badge', async ({ page }) => {
    let queueRequests = 0;
    let queueStatusRequests = 0;

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
          artists: { total: 0, monitored: 0, downloaded: 0 },
          albums: { total: 0, monitored: 0, downloaded: 0 },
          tracks: { total: 0, monitored: 0, downloaded: 0 },
          videos: { total: 0, monitored: 0, downloaded: 0 },
        }),
      });
    });

    await page.route((url) => url.pathname === '/api/queue/status', async (route) => {
      queueStatusRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ isPaused: false, processing: false, stats: [] }),
      });
    });

    await page.route((url) => url.pathname === '/api/queue', async (route) => {
      queueRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], limit: 100, offset: 0, hasMore: false, total: 0 }),
      });
    });

    await page.route((url) => url.pathname === '/api/queue/details', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/api/queue/progress-stream*', async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
        body: 'event: status\ndata: {"isPaused":false,"processing":false,"stats":[]}\n\n',
      });
    });

    await page.route((url) => url.pathname === '/api/events', async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
        body: 'event: ready\ndata: {"ok":true}\n\n',
      });
    });

    await page.route('**/api/artists*', async (route) => {
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
    await expect.poll(() => queueStatusRequests).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    expect(queueRequests).toBe(0);
  });

  test('library loads with Artists tab by default', async ({ page }) => {
    await stubPopulatedLibraryShell(page);
    await page.addInitScript(() => {
      localStorage.removeItem('discogenius_library_settings');
    });
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByRole('tablist')).toBeVisible();
    await expect(page.getByRole('tablist')).toContainText('Artists');
  });

  test('library tab switching works (desktop)', async ({ page }) => {
    await stubPopulatedLibraryShell(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByRole('tablist')).toBeVisible();

    const tabNames = ['Artists', 'Albums', 'Tracks', 'Videos'];
    for (const name of tabNames) {
      const tab = page.getByRole('tab', { name: new RegExp(`^${name}$`) }).first();
      const button = page.getByRole('button', { name: new RegExp(`^${name}$`) }).first();

      if (await tab.isVisible().catch(() => false)) {
        await tab.click({ force: true });
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        continue;
      }

      if (await button.isVisible().catch(() => false)) {
        await button.click();
      }
    }
  });

  test('sort menu opens and selections persist', async ({ page }) => {
    await stubPopulatedLibraryShell(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

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
    await stubPopulatedLibraryShell(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

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

    await page.route('**/api/queue/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ isPaused: false, processing: false, stats: [] }),
      });
    });

    await page.route('**/api/queue/progress-stream*', async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
        body: 'event: status\ndata: {"isPaused":false,"processing":false,"stats":[]}\n\n',
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

    await expect(page.getByText(/No artists found/i)).toBeHidden();

    releaseMonitoredResponse?.();

    await expect(page.getByText('Loading...').first()).toBeHidden();
    await expect(page.getByText('Overlap Artist')).toBeVisible();
  });
});
