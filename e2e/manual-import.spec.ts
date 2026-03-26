import { expect, test } from '@playwright/test';

const baseURL = process.env.BASE_URL || `http://127.0.0.1:${process.env.E2E_PORT || '3737'}`;

test.describe('Manual import flow', () => {
  test('lets the user choose a release and assign tracks in the manual import modal', async ({ page }) => {
    let unmappedFiles = [
      {
        id: 101,
        file_path: '/library/music/Test Artist/Test Album/01 - First Song.flac',
        relative_path: 'Test Artist/Test Album/01 - First Song.flac',
        library_root: 'music',
        filename: '01 - First Song.flac',
        extension: '.flac',
        file_size: 1024,
        detected_artist: 'Test Artist',
        detected_album: 'Test Album',
        detected_track: 'First Song',
        audio_quality: '24-BIT 48.0KHZ FLAC',
        reason: 'No matching TIDAL track found',
        ignored: false,
      },
      {
        id: 102,
        file_path: '/library/music/Test Artist/Test Album/02 - Second Song.flac',
        relative_path: 'Test Artist/Test Album/02 - Second Song.flac',
        library_root: 'music',
        filename: '02 - Second Song.flac',
        extension: '.flac',
        file_size: 2048,
        detected_artist: 'Test Artist',
        detected_album: 'Test Album',
        detected_track: 'Second Song',
        audio_quality: '24-BIT 48.0KHZ FLAC',
        reason: 'No matching TIDAL track found',
        ignored: false,
      },
    ];

    await page.route('**/api/stats', async (route) => {
      await route.fulfill({
        json: {
          artists: { total: 1, monitored: 1, downloaded: 0 },
          albums: { total: 1, monitored: 1, downloaded: 0 },
          tracks: { total: 2, monitored: 2, downloaded: 0 },
          videos: { total: 0, monitored: 0, downloaded: 0 },
        },
      });
    });

    await page.route('**/api/status', async (route) => {
      await route.fulfill({
        json: {
          activity: { pending: 0, processing: 0, history: 0 },
          taskQueueStats: [],
          commandStats: {},
        },
      });
    });

    await page.route('**/api/activity**', async (route) => {
      await route.fulfill({
        json: {
          items: [],
          total: 0,
          limit: 100,
          offset: 0,
          hasMore: false,
        },
      });
    });

    await page.route('**/api/unmapped**', async (route, request) => {
      if (request.method() === 'GET') {
        await route.fulfill({ json: unmappedFiles });
        return;
      }
      await route.fallback();
    });

    await page.route('**/api/search?*', async (route) => {
      await route.fulfill({
        json: {
          success: true,
          results: {
            albums: [
              {
                id: '555',
                type: 'album',
                name: 'Test Album',
                subtitle: 'Test Artist',
                imageId: null,
                explicit: true,
                quality: 'HI_RES_LOSSLESS',
                monitored: false,
                in_library: false,
                release_date: '2022-01-01',
              },
            ],
            artists: [],
            tracks: [],
            videos: [],
          },
          mode: 'mock',
          remoteCatalogAvailable: false,
        },
      });
    });

    await page.route('**/api/tidal/albums/555/tracks', async (route) => {
      await route.fulfill({
        json: [
          { tidal_id: '9001', title: 'First Song', track_number: 1, volume_number: 1, duration: 180 },
          { tidal_id: '9002', title: 'Second Song', track_number: 2, volume_number: 1, duration: 200 },
        ],
      });
    });

    await page.route('**/api/unmapped/identify', async (route) => {
      await route.fulfill({
        json: {
          success: true,
          mappedTracks: { 101: '9001', 102: '9002' },
          matchedCount: 2,
          totalFiles: 2,
          averageCost: 8,
          coverage: 1,
          confidence: 0.91,
        },
      });
    });

    await page.route('**/api/unmapped/bulk-map', async (route) => {
      unmappedFiles = [];
      await route.fulfill({ json: { success: true, message: 'Successfully mapped 2 files.' } });
    });

    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await page.getByRole('tab', { name: /^Unmapped Files$/i }).click();
    await page.getByRole('button', { name: /Review Test Album/i }).click();
    await expect(page.getByRole('dialog')).toContainText('Manual Import');

    const albumCard = page.getByRole('link', { name: /Test Album/i }).first();
    await expect(albumCard).toBeVisible();
    await albumCard.click();

    const firstTrackSelect = page.getByRole('combobox').nth(0);
    const secondTrackSelect = page.getByRole('combobox').nth(1);
    await expect(firstTrackSelect).toBeVisible();
    await firstTrackSelect.selectOption('9001');
    await secondTrackSelect.selectOption('9002');

    await expect(firstTrackSelect).toHaveValue('9001');
    await expect(secondTrackSelect).toHaveValue('9002');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTitle('01 - First Song.flac')).toBeVisible();
    await expect(dialog.getByTitle('02 - Second Song.flac')).toBeVisible();
  });
});

