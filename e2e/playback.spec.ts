import { expect, test, type Page } from '@playwright/test';

import { baseURL, stubShellApis } from './utils/mockShell';

const artistId = 'playback-artist-1';
const artistName = 'Playback Artist';
const trackId = 'playback-track-1';

function createSilentWavBuffer(durationMs = 250): Buffer {
  const sampleRate = 8_000;
  const numChannels = 1;
  const bitsPerSample = 8;
  const numSamples = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
  const dataSize = numSamples * numChannels;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  buffer.fill(128, 44);

  return buffer;
}

async function stubArtistPlaybackPage(
  page: Page,
  track: Record<string, unknown>,
) {
  await stubShellApis(page, {
    libraryStats: {
      artists: { total: 1, monitored: 1, downloaded: 1 },
      albums: { total: 1, monitored: 1, downloaded: 1 },
      tracks: { total: 1, monitored: 1, downloaded: 1 },
      videos: { total: 0, monitored: 0, downloaded: 0 },
    },
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
        rows: [
          {
            modules: [
              {
                title: 'Top Tracks',
                type: 'TRACK_LIST',
                pagedList: {
                  items: [track],
                },
              },
            ],
          },
        ],
        album_count: 1,
        monitored_album_count: 1,
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
}

test.describe('Playback', () => {
  test('downloaded tracks lazy-load local files and play from the library stream without signing TIDAL preview', async ({ page }) => {
    const wavBody = createSilentWavBuffer();
    let getTrackFilesRequests = 0;
    let signRequests = 0;
    let streamRequests = 0;

    await stubArtistPlaybackPage(page, {
      id: trackId,
      title: 'Local Track',
      duration: 32,
      quality: 'LOSSLESS',
      artist_name: artistName,
      album_title: 'Playback Album',
      downloaded: true,
      is_downloaded: true,
      is_monitored: true,
    });

    await page.route(`**/api/tracks/${trackId}/files`, async (route) => {
      getTrackFilesRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 321,
              file_type: 'track',
              extension: 'wav',
              quality: 'LOSSLESS',
            },
          ],
        }),
      });
    });

    await page.route(`**/api/library-files/stream/321**`, async (route) => {
      streamRequests += 1;
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'audio/wav',
          'Accept-Ranges': 'bytes',
        },
        body: wavBody,
      });
    });

    await page.route(`**/api/playback/stream/sign/${trackId}**`, async (route) => {
      signRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: `/api/playback/stream/play/${trackId}?exp=1&sig=never-used` }),
      });
    });

    await page.goto(`${baseURL}/artist/${artistId}`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await page.getByRole('button', { name: /play track/i }).click();

    const audio = page.locator('audio').first();
    await expect(audio).toBeAttached();
    await expect.poll(() => getTrackFilesRequests).toBe(1);
    await expect.poll(async () => audio.evaluate((element) => (element as HTMLAudioElement).src)).toContain('/api/library-files/stream/321');
    await expect.poll(() => signRequests).toBe(0);
    await expect.poll(() => streamRequests).toBeGreaterThan(0);
    await page.waitForTimeout(800);
    const baselineStreamRequests = streamRequests;

    await page.evaluate(() => {
      window.dispatchEvent(new Event('discogenius:activity-refresh'));
    });

    await page.waitForTimeout(900);
    await expect.poll(() => streamRequests).toBe(baselineStreamRequests);
  });

  test('downloaded tracks fall back from a broken local stream to a signed preview stream', async ({ page }) => {
    const wavBody = createSilentWavBuffer();
    let signRequests = 0;

    await stubArtistPlaybackPage(page, {
      id: trackId,
      title: 'Fallback Track',
      duration: 28,
      quality: 'LOSSLESS',
      artist_name: artistName,
      album_title: 'Playback Album',
      downloaded: true,
      is_downloaded: true,
      is_monitored: true,
      files: [
        {
          id: 654,
          file_type: 'track',
          extension: 'wav',
          quality: 'LOSSLESS',
        },
      ],
    });

    await page.route('**/api/library-files/stream/654**', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'broken local stream' }),
      });
    });

    await page.route(`**/api/playback/stream/sign/${trackId}**`, async (route) => {
      signRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: `/api/playback/stream/play/${trackId}?exp=123&sig=fallback` }),
      });
    });

    await page.route(`**/api/playback/stream/play/${trackId}**`, async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'audio/wav',
          'Accept-Ranges': 'bytes',
        },
        body: wavBody,
      });
    });

    await page.goto(`${baseURL}/artist/${artistId}`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await page.getByRole('button', { name: /play track/i }).click();

    const audio = page.locator('audio').first();
    await expect(audio).toBeAttached();
    await expect.poll(() => signRequests).toBe(1);
    await expect.poll(async () => audio.evaluate((element) => (element as HTMLAudioElement).src)).toContain(`/api/playback/stream/play/${trackId}?exp=123&sig=fallback`);
  });
});
