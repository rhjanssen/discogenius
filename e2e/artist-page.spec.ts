import { expect, test, type Page } from '@playwright/test';

import {
  baseURL,
  createSearchResponse,
  stubArtistPage,
  stubShellApis,
} from './utils/mockShell';

const artistId = '777';
const artistName = 'Deterministic Artist';

async function stubArtistSearchFlow(page: Page) {
  await stubShellApis(page);
  await stubArtistPage(page, {
    artistId,
    artistName,
    monitored: false,
  });

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
            monitored: false,
            in_library: true,
          },
        ],
      })),
    });
  });
}

test.describe('Artist page', () => {
  test('can navigate to artist detail from search', async ({ page }) => {
    await stubArtistSearchFlow(page);

    await page.goto(`${baseURL}/search`, { waitUntil: 'domcontentloaded' });

    const searchBox = page.getByRole('main').getByRole('searchbox', { name: /search/i });
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
    await expect(artistsTab).toBeVisible();
    await artistsTab.click();

    await page.getByText(artistName, { exact: true }).first().click();
    await page.waitForURL(new RegExp(`/artist/${artistId}$`), { timeout: 10_000 });
    await expect(page.getByText(artistName, { exact: true }).first()).toBeVisible();
  });

  test('direct artist page URL renders', async ({ page }) => {
    await stubShellApis(page);
    await stubArtistPage(page, {
      artistId,
      artistName,
      monitored: true,
    });

    await page.goto(`${baseURL}/artist/${artistId}`, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByText(artistName, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Unmonitor$/i })).toBeVisible();
  });

  test('artist page has no critical console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('net::ERR_') && !text.includes('favicon') && !text.includes('sw.js')) {
          errors.push(text);
        }
      }
    });

    await stubShellApis(page);
    await stubArtistPage(page, {
      artistId,
      artistName,
      monitored: false,
    });

    await page.goto(`${baseURL}/artist/${artistId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByText(artistName, { exact: true }).first()).toBeVisible();

    const critical = errors.filter((error) =>
      !error.includes('Service Worker')
      && !error.includes('manifest')
      && !error.includes('EventSource')
      && !error.includes('Global SSE stream error')
      && !error.includes('Global Stream connection failed')
      && !error.includes('Download progress SSE error')
      && !error.includes('Download progress stream connection failed'),
    );
    expect(critical).toEqual([]);
  });
});
