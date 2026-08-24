import { expect, test, type Page } from '@playwright/test';

const baseURL = process.env.BASE_URL || `http://127.0.0.1:${process.env.E2E_PORT || '3737'}`;

const connectedAuthStatus = {
  connected: true,
  refreshTokenExpired: false,
  tokenExpired: false,
  hoursUntilExpiry: 24,
  canAccessShell: true,
  canAccessLocalLibrary: true,
  remoteCatalogAvailable: true,
  canAuthenticate: true,
  user: {
    user_id: 'mock-user',
    username: 'mock-user',
    country_code: 'NL',
  },
  message: null,
};

async function stubShellApis(page: Page) {
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
      body: JSON.stringify(connectedAuthStatus),
    });
  });

  await page.route('**/api/v1/system/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        activity: { pending: 0, processing: 0, history: 0 },
        taskQueueStats: [],
        commandStats: {},
      }),
    });
  });

  await page.route('**/api/v1/history/activity**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
        hasMore: false,
      }),
    });
  });

  await page.route('**/api/v1/queue/progress-stream*', async (route) => {
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

  await page.route((url) => url.pathname === '/api/v1/queue', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }),
    });
  });

  await page.route('**/api/v1/monitoring/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ running: false, checking: false, config: {} }),
    });
  });

  await page.route('**/api/v1/provider', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        providers: [
          {
            id: 'tidal',
            name: 'TIDAL',
            isDefault: true,
            authenticated: true,
            remoteCatalogAvailable: true,
            capabilities: { followedArtists: true },
            management: {},
          },
          {
            id: 'spotify',
            name: 'Spotify',
            isDefault: false,
            authenticated: true,
            remoteCatalogAvailable: true,
            capabilities: { followedArtists: true },
            management: {},
          },
        ],
        defaultProviderId: 'tidal',
      }),
    });
  });
}

test.describe('Content state surfaces', () => {
  test('artist loading state stays centered on mobile', async ({ page }) => {
    await stubShellApis(page);

    let releaseArtistPage: (() => void) | null = null;
    const artistGate = new Promise<void>((resolve) => {
      releaseArtistPage = resolve;
    });

    await page.setViewportSize({ width: 390, height: 844 });

    await page.route('**/api/v1/artist/artist-mobile-loading/page*', async (route) => {
      await artistGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          artist: {
            id: 'artist-mobile-loading',
            name: 'Loading Artist',
            files: [],
            is_monitored: true,
          },
          rows: [],
          album_count: 0,
          monitored_album_count: 0,
          needs_scan: true,
          artistInfo: {
            name: 'Loading Artist',
          },
        }),
      });
    });

    await page.route('**/api/v1/artist/artist-mobile-loading/activity', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          scanning: false,
          curating: false,
          downloading: false,
          libraryScan: false,
          totalActive: 0,
        }),
      });
    });

    await page.goto(`${baseURL}/artist/artist-mobile-loading`, { waitUntil: 'domcontentloaded' });

    const loadingStatus = page.getByRole('status', { name: 'Loading artist details...' });
    await expect(loadingStatus).toBeVisible();

    const mainBox = await page.locator('main').boundingBox();
    const statusBox = await loadingStatus.boundingBox();

    expect(mainBox).not.toBeNull();
    expect(statusBox).not.toBeNull();

    const mainCenter = (mainBox!.x + (mainBox!.width / 2));
    const statusCenter = (statusBox!.x + (statusBox!.width / 2));

    expect(Math.abs(statusCenter - mainCenter)).toBeLessThanOrEqual(20);

    releaseArtistPage?.();
    await expect(page.getByText('No content found')).toBeVisible();
  });

  test('artist loading stays localized and resolves to the shared empty state', async ({ page }) => {
    await stubShellApis(page);

    let releaseArtistPage: (() => void) | null = null;
    const artistGate = new Promise<void>((resolve) => {
      releaseArtistPage = resolve;
    });

    await page.route('**/api/v1/artist/artist-loading/page*', async (route) => {
      await artistGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          artist: {
            id: 'artist-loading',
            name: 'Loading Artist',
            files: [],
            is_monitored: true,
          },
          rows: [],
          album_count: 0,
          monitored_album_count: 0,
          needs_scan: true,
          artistInfo: {
            name: 'Loading Artist',
          },
        }),
      });
    });

    await page.route('**/api/v1/artist/artist-loading/activity', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          scanning: false,
          curating: false,
          downloading: false,
          libraryScan: false,
          totalActive: 0,
        }),
      });
    });

    await page.goto(`${baseURL}/artist/artist-loading`, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('nav')).toBeVisible();
    await expect(page.getByRole('status', { name: 'Loading artist details...' })).toBeVisible();

    releaseArtistPage?.();

    await expect(page.getByText('No content found')).toBeVisible();
  });

  test('album page shows the shared empty state when there are no tracks', async ({ page }) => {
    await stubShellApis(page);

    await page.route('**/api/v1/album/album-empty/page', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          album: {
            id: 'album-empty',
            title: 'Empty Album',
            artist_id: 'artist-empty',
            artist_name: 'Quiet Artist',
            is_downloaded: false,
            downloaded: 0,
            cover_id: null,
            vibrant_color: null,
            is_monitored: true,
            monitor_locked: false,
            num_tracks: 0,
            last_scanned: null,
            quality: null,
            release_date: '2024-01-01',
            files: [],
          },
          tracks: [],
          otherVersions: [],
          artistPicture: null,
          artistCoverImageUrl: null,
        }),
      });
    });

    await page.goto(`${baseURL}/album/album-empty`, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('nav')).toBeVisible();
    await expect(page.getByText('No tracks found')).toBeVisible();
    await expect(page.getByText("This album doesn't have any surfaced tracks yet.")).toBeVisible();
  });

  test('video page shows the shared error state when the item is missing', async ({ page }) => {
    await stubShellApis(page);

    await page.route('**/api/v1/video/video-missing', async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Video not found' }),
      });
    });

    await page.goto(`${baseURL}/video/video-missing`, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('nav')).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Video not found');
    await expect(page.getByRole('alert')).toContainText("This video doesn't exist in your library.");
    await expect(page.getByRole('button', { name: 'Go Back' })).toBeVisible();
  });

  test('library empty state uses the shared empty view instead of an ad hoc layout', async ({ page }) => {
    await stubShellApis(page);

    await page.route('**/api/v1/stats', async (route) => {
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

    await page.route('**/api/v1/artist?*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], limit: 50, offset: 0, hasMore: false, total: 0 }),
      });
    });

    await page.route('**/api/v1/album?*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], limit: 50, offset: 0, hasMore: false, total: 0 }),
      });
    });

    await page.route('**/api/v1/track?*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }),
      });
    });

    await page.route('**/api/v1/video?*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], total: 0, limit: 50, offset: 0, hasMore: false }),
      });
    });

    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('nav')).toBeVisible();
    await expect(page.getByText('Your library is empty')).toBeVisible();
    await expect(page.getByRole('button', { name: /Import artists/i })).toBeVisible();
  });
});
