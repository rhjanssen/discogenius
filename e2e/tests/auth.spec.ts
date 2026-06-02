import { expect, test } from '@playwright/test';

const baseURL = process.env.BASE_URL || `http://127.0.0.1:${process.env.E2E_PORT || '3737'}`;

test.describe('Auth flow', () => {
  test('initial TIDAL connect button opens the verification URL on first click', async ({ page }) => {
    const verificationUrl = `${baseURL}/health`;

    await page.route('**/api/auth/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          connected: false,
          tokenExpired: false,
          refreshTokenExpired: false,
          hoursUntilExpiry: 0,
          canAccessShell: false,
          canAccessLocalLibrary: false,
          remoteCatalogAvailable: false,
          canAuthenticate: true,
          user: null,
          message: 'Connect your TIDAL account to access remote catalog features.',
        }),
      });
    });

    await page.route('**/api/auth/device-login', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          userCode: 'ABCD-EFGH',
          url: verificationUrl,
          expiresIn: 300,
          interval: 3,
        }),
      });
    });

    await page.route('**/api/auth/check-login', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          logged_in: false,
        }),
      });
    });

    await page.goto(`${baseURL}/auth`, { waitUntil: 'domcontentloaded' });

    const tidalConnectButton = page.getByRole('button', { name: /^tidal$/i });
    await expect(tidalConnectButton).toBeVisible();
    await page.mouse.wheel(0, 400);
    await expect.poll(async () => page.evaluate(() => window.scrollY)).toBe(0);

    const popupPromise = page.waitForEvent('popup');
    await tidalConnectButton.click();
    const popup = await popupPromise;

    await expect(page.getByText(/authorize discogenius/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /open tidal authorization/i })).toBeVisible();

    await expect.poll(() => popup.url()).toBe(verificationUrl);
  });
});
