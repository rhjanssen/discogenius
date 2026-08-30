import { expect, test } from '@playwright/test';

const baseURL = process.env.BASE_URL || `http://127.0.0.1:${process.env.E2E_PORT || '3737'}`;

const SETTINGS_SECTIONS = [
  'Media Management',
  'Metadata',
  'Metadata Source',
  'Audio',
  'Music Videos',
  'Filters',
  'Monitoring',
  'Providers',
  'Appearance',
  'About',
] as const;

// Single-scroll (VS Code-style) settings: every section is always rendered; the
// nav scroll-spies. Clicking a navigation item or mobile menu item scrolls to it.
async function selectSettingsCategory(page: import('@playwright/test').Page, label: string) {
  // Settings renders a loading state before either responsive navigation is
  // usable. Wait for the layout instead of treating "not visible yet" as the
  // mobile breakpoint and clicking its permanently hidden desktop counterpart.
  await expect(page.getByTestId('settings-layout')).toBeVisible();
  const desktopNav = page.getByTestId('settings-category-nav');
  if (await desktopNav.isVisible().catch(() => false)) {
    const desktopItem = desktopNav.getByRole('button', { name: label, exact: true });
    await desktopItem.scrollIntoViewIfNeeded();
    await desktopItem.click();
    return;
  }

  const menuButton = page.getByTestId('settings-category-menu');
  await menuButton.click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
}

test.describe('Settings page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${baseURL}/settings`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);
  });

  test('renders settings category navigation', async ({ page }) => {
    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByRole('main').getByText('Settings', { exact: true })).toBeVisible();
    await expect(page.getByTestId('settings-layout')).toBeVisible();
    await expect(page.getByTestId('settings-sections')).toBeVisible();

    // Default focus: Media Management (first section).
    await expect(page.locator('#media-management')).toBeVisible();

    // Desktop navigation or mobile category menu must expose all categories.
    const desktopNav = page.getByTestId('settings-category-nav');
    if (await desktopNav.isVisible().catch(() => false)) {
      for (const label of SETTINGS_SECTIONS) {
        await expect(desktopNav.getByRole('button', { name: label, exact: true })).toBeVisible();
      }
    } else {
      await expect(page.getByTestId('settings-category-menu')).toBeVisible();
    }
  });

  test('category navigation scrolls to settings sections', async ({ page }) => {
    await expect(page.locator('main')).toBeVisible();

    await selectSettingsCategory(page, 'Providers');
    await expect(page.locator('#streaming-providers').getByText('Providers', { exact: true })).toBeVisible();

    await selectSettingsCategory(page, 'Metadata Source');
    await expect(page.locator('#metadata-source')).toBeVisible();

    await selectSettingsCategory(page, 'Metadata');
    await expect(page.locator('#metadata')).toBeVisible();

    await selectSettingsCategory(page, 'Audio');
    await expect(page.locator('#audio-quality')).toBeVisible();

    await selectSettingsCategory(page, 'Music Videos');
    await expect(page.locator('#music-videos')).toBeVisible();

    await selectSettingsCategory(page, 'Filters');
    await expect(page.locator('#curation').getByText('Filters', { exact: true })).toBeVisible();

    await selectSettingsCategory(page, 'Monitoring');
    await expect(page.locator('#monitoring').getByText('Monitoring', { exact: true })).toBeVisible();

    await selectSettingsCategory(page, 'Appearance');
    await expect(page.locator('#appearance').getByText('Appearance', { exact: true })).toBeVisible();

    await selectSettingsCategory(page, 'About');
    await expect(page.locator('#about').getByText('About', { exact: true })).toBeVisible();
  });

  test('uses section navigation beside settings on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('main')).toBeVisible();

    const layout = await page.getByTestId('settings-layout').evaluate((element) => {
      const styles = window.getComputedStyle(element);
      return {
        display: styles.display,
        flexDirection: styles.flexDirection,
      };
    });

    expect(layout.display).toBe('flex');
    expect(layout.flexDirection).toBe('row');
    await expect(page.getByTestId('settings-category-nav')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
  });

  test('theme selector works', async ({ page }) => {
    await expect(page.locator('main')).toBeVisible();

    await selectSettingsCategory(page, 'Appearance');
    const appearanceHeading = page.locator('#appearance').getByText('Appearance', { exact: true });
    await expect(appearanceHeading).toBeVisible();
    await expect(page.getByRole('radio', { name: /light/i })).toBeVisible();
    await expect(page.getByRole('radio', { name: /dark/i })).toBeVisible();
    await expect(page.getByRole('radio', { name: /system/i })).toBeVisible();
  });
});

test('settings about section shows current and latest version status', async ({ page }) => {
  await page.route('**/api/v1/config/about', async (route) => {
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
  await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

  await selectSettingsCategory(page, 'About');
  const aboutHeading = page.locator('#about').getByText('About', { exact: true });
  await expect(aboutHeading).toBeVisible();

  await expect(page.locator('#about').getByText(/Current Version/i)).toBeVisible();
  await expect(page.locator('#about').getByText(/Latest Version/i)).toBeVisible();
  await expect(page.locator('#about').getByText(/Update Status/i)).toBeVisible();
  await expect(page.locator('#about').getByText('v1.0.4', { exact: true })).toBeVisible();
  await expect(page.locator('#about').getByText('v1.0.5', { exact: true })).toBeVisible();
  await expect(page.locator('#about').getByText('Update available', { exact: true })).toBeVisible();
  await expect(page.locator('#about').getByRole('link', { name: /open latest release notes/i })).toBeVisible();
});

test.describe('Dashboard page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);
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
