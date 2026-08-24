import { expect, test, type Page } from '@playwright/test';

import {
  baseURL,
  createSearchResponse,
  stubShellApis,
  stubVideoDetail,
} from '../utils/mockShell';

const artistId = '777';
const artistName = 'Deterministic Artist';
const videoId = '9001';
const videoTitle = 'Deterministic Video';

async function setupSearchFixtures(page: Page) {
  let monitored = false;
  let monitorPayload: Record<string, unknown> | null = null;

  await stubShellApis(page);
  await stubVideoDetail(page, {
    videoId,
    title: videoTitle,
    artistId,
    artistName,
  });

  await page.route('**/api/v1/artist/libraries', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 1, name: 'Stereo Library', root_path: '/library/stereo-music' },
      ]),
    });
  });

  await page.route(`**/api/v1/video/${videoId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: videoId,
        title: videoTitle,
        artist_id: artistId,
        artist_name: artistName,
        duration: 180,
        release_date: '2024-01-01',
        version: null,
        quality: 'FHD',
        cover: null,
        cover_id: null,
        cover_art_url: null,
        is_monitored: false,
        monitored_lock: false,
        downloaded: false,
        is_downloaded: false,
      }),
    });
  });

  await page.route(`**/api/v1/artist/${artistId}/page*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        artist: {
          id: artistId,
          name: artistName,
          is_monitored: monitored,
          files: [],
        },
        rows: [],
        album_count: 0,
        monitored_album_count: 0,
        needs_scan: false,
      }),
    });
  });

  await page.route(`**/api/v1/artist/${artistId}/activity`, async (route) => {
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

  await page.route('**/api/v1/search?*', async (route) => {
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
            monitored,
            in_library: monitored,
          },
        ],
        albums: [
          {
            id: 'album-1',
            type: 'album',
            name: 'Deterministic Album',
            subtitle: artistName,
            imageId: null,
            monitored: false,
            in_library: false,
            quality: 'LOSSLESS',
            release_date: '2024-01-01',
          },
        ],
        tracks: [
          {
            id: 'track-1',
            type: 'track',
            name: 'Deterministic Track',
            subtitle: artistName,
            imageId: null,
            monitored: false,
            in_library: false,
            quality: 'LOSSLESS',
            duration: 180,
          },
        ],
        videos: [
          {
            id: videoId,
            type: 'video',
            name: videoTitle,
            subtitle: artistName,
            imageId: null,
            monitored: false,
            in_library: true,
            quality: 'FHD',
            duration: 180,
          },
        ],
      })),
    });
  });

  await page.route(`**/api/v1/artist/${artistId}`, async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: artistId,
          name: artistName,
          picture: null,
          is_monitored: monitored,
          is_downloaded: false,
          last_scanned: null,
          album_count: 1,
          downloaded: 0,
        }),
      });
      return;
    }

    let nextMonitored = monitored;
    try {
      const payload = route.request().postDataJSON() as { monitored?: boolean } | null;
      if (payload && typeof payload.monitored === 'boolean') {
        nextMonitored = payload.monitored;
      }
    } catch {
      nextMonitored = true;
    }

    monitored = nextMonitored;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, monitored }),
    });
  });

  await page.route(`**/api/v1/artist/${artistId}/monitor`, async (route) => {
    monitorPayload = route.request().postDataJSON() as Record<string, unknown>;
    monitored = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        artistId,
        monitored,
        queued: true,
        message: 'Artist monitored (scan queued)',
      }),
    });
  });

  return {
    getMonitored: () => monitored,
    getMonitorPayload: () => monitorPayload,
  };

}

async function searchForArtist(page: Page) {
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });

  const searchBox = page.getByRole('searchbox', { name: /search/i });
  await searchBox.fill(artistName);

  await page.waitForResponse((res) => {
    try {
      const url = new URL(res.url());
      return url.pathname === '/api/v1/search' && res.status() === 200;
    } catch {
      return false;
    }
  });
}

test.describe('Search → monitor → navigate flow', () => {
  test('search returns results and tabs work', async ({ page }) => {
    await setupSearchFixtures(page);
    await searchForArtist(page);

    await expect(page.getByRole('tab', { name: /^Top$/i }).first()).toBeVisible();

    for (const tabName of ['Artists', 'Albums', 'Tracks', 'Videos']) {
      const tab = page.getByRole('tab', { name: new RegExp(`^${tabName}$`, 'i') }).first();
      await expect(tab).toBeVisible();
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
    }
  });

  test('monitor toggle works on artist from search', async ({ page }) => {
    const fixture = await setupSearchFixtures(page);
    await searchForArtist(page);

    const artistsTab = page.getByRole('tab', { name: /^Artists$/i }).first();
    await artistsTab.click();

    const monitorButton = page.getByRole('button', { name: `Add ${artistName}` }).first();
    await expect(monitorButton).toBeVisible();
    await monitorButton.click();
    await expect.poll(() => fixture.getMonitored()).toBe(true);
    await expect.poll(() => fixture.getMonitorPayload()).toEqual({
      name: artistName,
      allLibraries: true,
    });
    await expect(page.getByRole('dialog').getByRole('button', { name: /^Monitor$/i })).toHaveCount(0);

    // Monitoring invalidates the search query and closes the result overlay.
    // Reopen it to verify that the refreshed result reflects membership.
    const searchBox = page.getByRole('searchbox', { name: /search/i });
    await searchBox.fill('');
    await searchBox.fill(artistName);
    await expect(page.getByRole('button', { name: `Unmonitor ${artistName}` }).first()).toBeVisible();
  });

  test('artist page keeps monitored state when opened immediately after monitoring from search', async ({ page }) => {
    const fixture = await setupSearchFixtures(page);
    await searchForArtist(page);

    const artistsTab = page.getByRole('tab', { name: /^Artists$/i }).first();
    await artistsTab.click();

    const monitorButton = page.getByRole('button', { name: `Add ${artistName}` }).first();
    await expect(monitorButton).toBeVisible();
    await monitorButton.click();
    await expect.poll(() => fixture.getMonitored()).toBe(true);
    await expect.poll(() => fixture.getMonitorPayload()).toEqual({
      name: artistName,
      allLibraries: true,
    });

    const searchBox = page.getByRole('searchbox', { name: /search/i });
    await searchBox.fill('');
    await searchBox.fill(artistName);
    await expect(page.getByRole('button', { name: `Unmonitor ${artistName}` }).first()).toBeVisible();

    await page.getByText(artistName, { exact: true }).first().click();
    await page.waitForURL(new RegExp(`/artist/${artistId}$`), { timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Monitored' })).toBeVisible();
  });

  test('clicking artist in search navigates to artist detail', async ({ page }) => {
    await setupSearchFixtures(page);
    await searchForArtist(page);

    const artistsTab = page.getByRole('tab', { name: /^Artists$/i }).first();
    await artistsTab.click();

    await page.getByText(artistName, { exact: true }).first().click();
    await page.waitForURL(new RegExp(`/artist/${artistId}$`), { timeout: 10_000 });
    await expect(page.getByText(artistName, { exact: true }).first()).toBeVisible();
  });

  test('clicking video in search navigates to video detail', async ({ page }) => {
    await setupSearchFixtures(page);
    await searchForArtist(page);

    const videosTab = page.getByRole('tab', { name: /^Videos$/i }).first();
    await videosTab.click();

    await page.getByText(videoTitle, { exact: true }).first().click();
    await page.waitForURL(new RegExp(`/video/${videoId}$`), { timeout: 10_000 });
    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start monitoring' })).toBeVisible();
  });
});
