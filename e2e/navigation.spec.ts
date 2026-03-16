import { expect, test } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:3737';

test.describe('App shell & navigation', () => {
  test('renders main layout with nav and search', async ({ page }) => {
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    // Layout should have nav with logo, search, and action buttons
    await expect(page.locator('nav')).toBeVisible();
    const searchBox = page.getByRole('searchbox', { name: /search/i });
    await expect(searchBox).toBeVisible();

    // Settings button should be accessible
    const settingsBtn = page.getByRole('button', { name: /settings/i }).first();
    await expect(settingsBtn).toBeVisible();

    // Dashboard button should be accessible
    const dashboardBtn = page.getByRole('button', { name: /dashboard/i }).first();
    await expect(dashboardBtn).toBeVisible();

    // Library button should be accessible in desktop nav
    const libraryBtn = page.getByRole('button', { name: /library/i }).first();
    await expect(libraryBtn).toBeVisible();
  });

  test('navigates to dashboard page', async ({ page }) => {
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    const dashboardBtn = page.getByRole('button', { name: /dashboard/i }).first();
    await dashboardBtn.click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('navigates to settings page', async ({ page }) => {
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    const settingsBtn = page.getByRole('button', { name: /settings/i }).first();
    await settingsBtn.click();
    await expect(page).toHaveURL(/\/settings/);
  });

  test('logo click navigates back to library (root)', async ({ page }) => {
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    // Click logo to go home
    const logo = page.locator('nav img[alt="Discogenius"]');
    await logo.click();
    await expect(page).toHaveURL(`${baseURL}/`);
  });

  test('404 page shown for unknown routes', async ({ page }) => {
    await page.goto(`${baseURL}/nonexistent-route-12345`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    // Should show some kind of not-found content
    await expect(page.locator('body')).toContainText(/not found|404|page/i);
  });
});
