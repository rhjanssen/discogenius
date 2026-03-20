import { expect, test } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:3737';

test.describe('Settings page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${baseURL}/settings`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');
  });

  test('renders settings sections', async ({ page }) => {
    await expect(page.locator('main')).toBeVisible();

    await expect(page.getByRole('main').getByText('Settings', { exact: true })).toBeVisible();
    await expect(page.getByText('Audio Quality', { exact: true })).toBeVisible();
    await expect(page.getByText('Video Quality', { exact: true })).toBeVisible();
    await expect(page.getByText('Curation', { exact: true })).toBeVisible();
    await expect(page.getByText('Monitoring', { exact: true })).toBeVisible();
    await expect(page.getByText('About', { exact: true })).toBeVisible();
  });

  test('theme selector works', async ({ page }) => {
    await expect(page.locator('main')).toBeVisible();

    const appearanceHeading = page.getByText('Appearance', { exact: true });
    await appearanceHeading.scrollIntoViewIfNeeded();
    await expect(appearanceHeading).toBeVisible();
    await expect(page.getByRole('radio', { name: /light/i })).toBeVisible();
    await expect(page.getByRole('radio', { name: /dark/i })).toBeVisible();
    await expect(page.getByRole('radio', { name: /system/i })).toBeVisible();
  });
});

test('settings about section shows current and latest version status', async ({ page }) => {
  await page.route('**/api/config/about', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: '1.0.4',
        appVersion: '1.0.4',
        apiVersion: '1.0.4',
        latestVersion: '1.0.5',
        latestReleaseName: 'v1.0.5',
        latestReleaseUrl: 'https://github.com/rhjanssen/discogenius/releases/tag/v1.0.5',
        latestReleasePublishedAt: '2026-03-20T12:00:00.000Z',
        updateAvailable: true,
        updateStatus: 'update-available',
        checkedAt: '2026-03-20T12:30:00.000Z',
      }),
    });
  });

  await page.goto(`${baseURL}/settings`, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

  const aboutHeading = page.getByText('About', { exact: true });
  await aboutHeading.scrollIntoViewIfNeeded();
  await expect(aboutHeading).toBeVisible();

  await expect(page.getByText(/Current Version/i)).toBeVisible();
  await expect(page.getByText(/Latest Version/i)).toBeVisible();
  await expect(page.getByText(/Update Status/i)).toBeVisible();
  await expect(page.getByText('v1.0.4', { exact: true })).toBeVisible();
  await expect(page.getByText('v1.0.5', { exact: true })).toBeVisible();
  await expect(page.getByText('Update available', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /open latest release notes/i })).toBeVisible();
});

test.describe('Dashboard page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');
  });

  test('renders dashboard with stats', async ({ page }) => {
    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByRole('main').getByText('Dashboard', { exact: true })).toBeVisible();
    await expect(page.getByText('Artists', { exact: true })).toBeVisible();
    await expect(page.getByText('Albums', { exact: true })).toBeVisible();
    await expect(page.getByText('Tracks', { exact: true })).toBeVisible();
    await expect(page.getByText('Videos', { exact: true })).toBeVisible();
    await expect(page.getByRole('tablist')).toBeVisible();
  });

  test('dashboard tabs work', async ({ page }) => {
    await expect(page.locator('main')).toBeVisible();

    // Check for tabs on dashboard
    const tabs = page.getByRole('tab');
    const tabCount = await tabs.count();
    if (tabCount > 0) {
      // Click second tab if available
      if (tabCount > 1) {
        await tabs.nth(1).click();
        await page.waitForTimeout(500);
        // Page should still be stable
        await expect(page.locator('main')).toBeVisible();
      }
    }
  });
});
