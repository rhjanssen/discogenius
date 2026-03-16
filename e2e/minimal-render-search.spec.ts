import { expect, test } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:3737';

test('non-blank render + search panel opens + results appear', async ({ page }) => {
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });

  if (page.url().includes('/auth')) {
    test.skip(true, 'Auth gate is enabled for this environment.');
  }

  await expect(page.locator('main')).toBeVisible();
  const searchBox = page.getByRole('searchbox', { name: /search artists, albums, tracks, or videos/i });
  await expect(searchBox).toBeVisible();

  const query = 'daft punk';
  await searchBox.fill(query);

  const response = await page.waitForResponse((res) => {
    try {
      const url = new URL(res.url());
      return url.pathname === '/api/search' && url.searchParams.get('query') === query && res.status() === 200;
    } catch {
      return false;
    }
  }, { timeout: 30000 });

  const payload = await response.json();
  const results = payload?.results || {};
  const total = ['artists', 'albums', 'tracks', 'videos']
    .map((k) => (results[k] || []).length)
    .reduce((a, b) => a + b, 0);

  expect(total).toBeGreaterThan(0);
  await expect(page.getByRole('tab', { name: /^Top$/i }).first()).toBeVisible();

  if ((results.artists || []).length > 0) {
    await page.getByRole('tab', { name: /^Artists$/i }).first().click();
    await expect(page.getByText(results.artists[0].name, { exact: false }).first()).toBeVisible();
  } else if ((results.tracks || []).length > 0) {
    await page.getByRole('tab', { name: /^Tracks$/i }).first().click();
    await expect(page.getByText(results.tracks[0].name || results.tracks[0].title, { exact: false }).first()).toBeVisible();
  } else if ((results.albums || []).length > 0) {
    await page.getByRole('tab', { name: /^Albums$/i }).first().click();
    await expect(page.getByText(results.albums[0].name || results.albums[0].title, { exact: false }).first()).toBeVisible();
  } else if ((results.videos || []).length > 0) {
    await page.getByRole('tab', { name: /^Videos$/i }).first().click();
    await expect(page.getByText(results.videos[0].name || results.videos[0].title, { exact: false }).first()).toBeVisible();
  }
});
