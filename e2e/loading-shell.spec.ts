import { expect, test } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:3737';

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

    await page.route('**/api/queue*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], hasMore: false, total: 0 }),
      });
    });

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

    await page.route('**/api/queue*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], hasMore: false, total: 0 }),
      });
    });

    await page.goto(`${baseURL}/search`, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('nav')).toBeVisible();
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('main')).toContainText('Checking connection...');

    releaseProviderAuthCheck?.();

    await expect(page.locator('main')).not.toContainText('Checking connection...');
    await expect(page.locator('main')).toBeVisible();
  });
});
