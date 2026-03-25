import { expect, test, type Page } from '@playwright/test';

const baseURL = process.env.BASE_URL || `http://127.0.0.1:${process.env.E2E_PORT || '3737'}`;

const mockConnectedStatus = {
  connected: true,
  refreshTokenExpired: false,
  tokenExpired: false,
  hoursUntilExpiry: 24,
  mode: 'live',
  canAccessShell: true,
  canAccessLocalLibrary: true,
  remoteCatalogAvailable: true,
  authBypassed: false,
  canAuthenticate: true,
  user: {
    user_id: 'mock-user',
    username: 'mock-user',
    country_code: 'NL',
  },
  message: null,
};

test.describe('Shell loading states', () => {
  const stubQueueApis = async (page: Page) => {
    await page.route('**/api/queue/progress-stream*', async (route) => {
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

    await page.route((url) => url.pathname === '/api/queue', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], hasMore: false, total: 0 }),
      });
    });
  };

  test('keeps the auth screen stable while app auth status is loading', async ({ page }) => {
    let releaseAppAuthCheck: (() => void) | null = null;
    const appAuthGate = new Promise<void>((resolve) => {
      releaseAppAuthCheck = resolve;
    });

    await page.route('**/api/app-auth/is-auth-active', async (route) => {
      await appAuthGate;
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
          ...mockConnectedStatus,
          connected: false,
          canAccessShell: false,
          canAccessLocalLibrary: false,
          remoteCatalogAvailable: false,
          message: 'Connect your TIDAL account to access remote catalog features.',
        }),
      });
    });

    await stubQueueApis(page);

    await page.goto(`${baseURL}/auth`, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('nav')).toHaveCount(0);
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('main')).toContainText('Checking app access...');

    releaseAppAuthCheck?.();

    await expect(page.locator('main')).not.toContainText('Checking app access...');
    await expect(page.getByRole('button', { name: /connect with tidal/i })).toBeVisible();
  });

  test('keeps the shell visible while provider auth status is loading', async ({ page }) => {
    let releaseProviderAuthCheck: (() => void) | null = null;
    const providerAuthGate = new Promise<void>((resolve) => {
      releaseProviderAuthCheck = resolve;
    });

    await page.route('**/api/app-auth/is-auth-active', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ isAuthActive: false }),
      });
    });

    await page.route('**/api/auth/status', async (route) => {
      await providerAuthGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockConnectedStatus),
      });
    });

    await stubQueueApis(page);

    await page.goto(`${baseURL}/search`, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('nav')).toBeVisible();
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('main')).toContainText('Checking connection...');

    releaseProviderAuthCheck?.();

    await expect(page.locator('main')).not.toContainText('Checking connection...');
    await expect(page.locator('main')).toBeVisible();
  });

  test('keeps the artist loading state centered on mobile while artist data is still loading', async ({ page }) => {
    let releaseArtistPage: (() => void) | null = null;
    const artistPageGate = new Promise<void>((resolve) => {
      releaseArtistPage = resolve;
    });

    await page.setViewportSize({ width: 390, height: 844 });

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
        body: JSON.stringify(mockConnectedStatus),
      });
    });

    await stubQueueApis(page);

    await page.route('**/api/artists/123/activity', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          scanning: false,
          curating: false,
          downloading: false,
          libraryScan: false,
          totalActive: 0,
          jobs: [],
        }),
      });
    });

    await page.route('**/api/artists/123/page-db', async (route) => {
      await artistPageGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          artist: { id: '123', name: 'Test Artist', is_monitored: false, files: [] },
          rows: [],
          album_count: 0,
          monitored_album_count: 0,
        }),
      });
    });

    await page.goto(`${baseURL}/artist/123`, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('main')).toContainText('Loading artist details...');
    await expect.poll(async () => {
      return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    }).toBe(true);

    const statusBox = await page.locator('main [role="status"]').boundingBox();
    const viewport = page.viewportSize();
    expect(statusBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (statusBox && viewport) {
      const centerX = statusBox.x + (statusBox.width / 2);
      expect(Math.abs(centerX - viewport.width / 2)).toBeLessThan(24);
    }

    releaseArtistPage?.();
    await expect(page.locator('main')).not.toContainText('Loading artist details...');
  });
});
