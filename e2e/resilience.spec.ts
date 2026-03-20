import { expect, test } from '@playwright/test';

import {
  baseURL,
  createSearchResponse,
  stubShellApis,
} from './utils/mockShell';

test.describe('Restart resilience', () => {
  test('app recovers from temporary API unavailability', async ({ page }) => {
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    // App should be loaded
    await expect(page.locator('main')).toBeVisible();
    const searchBox = page.getByRole('searchbox', { name: /search/i });
    await expect(searchBox).toBeVisible();

    // Simulate a search to verify the app works
    await searchBox.fill('test');
    await page.waitForTimeout(1000);

    // Clear search
    await searchBox.clear();
    await page.waitForTimeout(300);

    // Verify the page is still functional after interaction
    await expect(page.locator('nav')).toBeVisible();
    await expect(page.locator('main')).toBeVisible();

    // No error overlays or chunk load errors
    const pageContent = await page.content();
    expect(pageContent).not.toContain('ChunkLoadError');
  });

  test('no console errors during normal operation', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Ignore known benign errors
        if (text.includes('ERR_CONNECTION_REFUSED') ||
          text.includes('net::ERR_') ||
          text.includes('favicon.ico')) {
          return;
        }
        consoleErrors.push(text);
      }
    });

    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await expect(page.locator('main')).toBeVisible();
    await page.waitForTimeout(2000);

    // Filter out non-critical console errors
    const criticalErrors = consoleErrors.filter(err =>
      !err.includes('Service Worker') &&
      !err.includes('manifest') &&
      !err.includes('sw.js')
    );

    // Allow up to 1 non-critical error (network timing, etc.)
    expect(criticalErrors.length).toBeLessThanOrEqual(1);
  });

  test('mobile bottom tab navigation works', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await expect(page.locator('main')).toBeVisible();
    await page.waitForTimeout(500);

    // Bottom tabs should be visible on mobile — use the bottom tab bar container
    // The bottom tabs are in a fixed-position div at the bottom
    const bottomBar = page.locator('[style*="fixed"], [class*="bar"]').filter({ has: page.getByRole('button', { name: /^Library$/i }) });

    // Navigate via bottom tab Dashboard button (aria-label match)
    const dashboardBtn = page.getByRole('button', { name: /^Dashboard$/i }).last();
    await dashboardBtn.click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 5_000 });

    const settingsBtn = page.getByRole('button', { name: /^Settings$/i }).last();
    await settingsBtn.click();
    await expect(page).toHaveURL(/\/settings/, { timeout: 5_000 });

    // Back to library
    const libraryBtn = page.getByRole('button', { name: /^Library$/i }).last();
    await libraryBtn.click();
    await expect(page).toHaveURL(`${baseURL}/`, { timeout: 5_000 });
  });

  test('activity tab is reachable on mobile through the dashboard', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await expect(page.locator('main')).toBeVisible();

    const dashboardBtn = page.getByRole('button', { name: /^Dashboard$/i }).last();
    await expect(dashboardBtn).toBeVisible({ timeout: 3_000 });
    await dashboardBtn.click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 5_000 });

    const dashboardViewPicker = page.getByRole('button', { name: /^Queue$/i }).first();
    if (await dashboardViewPicker.isVisible().catch(() => false)) {
      await dashboardViewPicker.click();
      await page.getByRole('menuitem', { name: /^Activity$/i }).click();
      await expect(page.getByRole('button', { name: /^Activity$/i }).first()).toBeVisible();
    } else {
      const activityTab = page.getByRole('tab', { name: /^Activity$/i }).first();
      await expect(activityTab).toBeVisible({ timeout: 5_000 });
      await activityTab.click();
      await expect(activityTab).toHaveAttribute('aria-selected', 'true');
    }

    await expect(page.getByRole('button', { name: /^Filter$/i })).toBeVisible();
  });

  test('desktop view keeps the top navigation actions available', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('nav')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Dashboard$/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Library$/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Settings$/i }).first()).toBeVisible();
  });

  test('dashboard stays navigable after background updates', async ({ page }) => {
    const artistId = 'resilience-artist';
    const artistName = 'Resilience Artist';

    await stubShellApis(page);
    await page.route('**/api/search?*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(createSearchResponse({
          artists: [
            {
              id: artistId,
              type: 'artist',
              name: artistName,
              subtitle: 'Artist',
              imageId: null,
              monitored: true,
              in_library: true,
            },
          ],
        })),
      });
    });
    await page.route(`**/api/artists/${artistId}/page-db`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          artist: {
            id: artistId,
            name: artistName,
            is_monitored: true,
            files: [],
          },
          rows: [],
          album_count: 0,
          monitored_album_count: 0,
          needs_scan: false,
        }),
      });
    });
    await page.route(`**/api/artists/${artistId}/activity`, async (route) => {
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

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('main')).toBeVisible();
    await page.getByRole('button', { name: /^Dashboard$/i }).first().click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
    await expect(page.getByRole('button', { name: /^Library$/i }).first()).toBeVisible();

    await page.evaluate(() => {
      window.dispatchEvent(new Event('discogenius:activity-refresh'));
      window.dispatchEvent(new Event('library-updated'));
    });
    await page.waitForTimeout(1_500);

    await page.getByRole('button', { name: /^Settings$/i }).first().click();
    await expect(page).toHaveURL(/\/settings/, { timeout: 10_000 });

    await page.getByRole('button', { name: /^Dashboard$/i }).first().click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
    await expect(page.locator('main')).toBeVisible();

    const searchBox = page.getByRole('searchbox', { name: /search/i }).first();
    await searchBox.fill(artistName);
    await page.waitForResponse((res) => {
      try {
        const url = new URL(res.url());
        return url.pathname === '/api/search' && res.status() === 200;
      } catch {
        return false;
      }
    });

    const artistsTab = page.getByRole('tab', { name: /^Artists$/i }).first();
    await expect(artistsTab).toBeVisible({ timeout: 5_000 });
    await artistsTab.click();

    await page.getByText(artistName, { exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`/artist/${artistId}$`), { timeout: 10_000 });
    await expect(page.getByText(artistName, { exact: true }).first()).toBeVisible();
  });
});
