import { expect, test, type Page } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:3737';

async function stubDashboardApis(page: Page) {
  await page.route('**/api/stats', async (route) => {
    await route.fulfill({
      json: {
        artists: { total: 0, monitored: 0, downloaded: 0 },
        albums: { total: 0, monitored: 0, downloaded: 0 },
        tracks: { total: 0, monitored: 0, downloaded: 0 },
        videos: { total: 0, monitored: 0, downloaded: 0 },
      },
    });
  });

  await page.route('**/api/status/history?*', async (route) => {
    await route.fulfill({ json: { jobHistory: [] } });
  });

  await page.route('**/api/status', async (route) => {
    await route.fulfill({
      json: {
        activeJobs: [],
        queuedJobs: [],
        jobHistory: [],
        taskQueueStats: [],
        commandStats: {},
      },
    });
  });

  await page.route('**/api/monitoring/status', async (route) => {
    await route.fulfill({ json: { running: false, checking: false } });
  });

  await page.route('**/api/queue**', async (route) => {
    await route.fulfill({ json: { items: [], total: 0, limit: 50, offset: 0, hasMore: false } });
  });

  await page.route('**/api/unmapped**', async (route) => {
    await route.fulfill({ json: [] });
  });
}

async function stubDashboardApisWithActivity(page: Page) {
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

  await page.route('**/api/status/history?*', async (route) => {
    await route.fulfill({ json: { jobHistory: [] } });
  });

  await page.route('**/api/status', async (route) => {
    await route.fulfill({
      json: {
        activeJobs: [
          {
            id: 1,
            type: 'ImportDownload',
            status: 'running',
            description: 'Album: Around the World by Daft Punk',
            startTime: Date.now(),
            payload: { type: 'album', resolved: { title: 'Around the World', artist: 'Daft Punk' } },
          },
          {
            id: 2,
            type: 'RefreshArtist',
            status: 'running',
            description: 'Daft Punk',
            startTime: Date.now(),
          },
          {
            id: 3,
            type: 'MissingAlbumSearch',
            status: 'running',
            description: 'Daft Punk',
            startTime: Date.now(),
          },
        ],
        queuedJobs: [
          {
            id: 6,
            type: 'DownloadAlbum',
            status: 'pending',
            description: 'Queued album: Discovery by Daft Punk',
            startTime: Date.now() - 15_000,
            payload: { title: 'Discovery', artist: 'Daft Punk' },
          },
        ],
        jobHistory: [
          {
            id: 4,
            type: 'DownloadAlbum',
            status: 'completed',
            description: 'Downloading album: Around the World by Daft Punk',
            startTime: Date.now() - 30_000,
            endTime: Date.now() - 10_000,
            payload: { title: 'Around the World', artist: 'Daft Punk' },
          },
          {
            id: 5,
            type: 'ImportDownload',
            status: 'completed',
            description: 'Album: Around the World by Daft Punk',
            startTime: Date.now() - 20_000,
            endTime: Date.now() - 5_000,
            payload: { type: 'album', resolved: { title: 'Around the World', artist: 'Daft Punk' } },
          },
        ],
        taskQueueStats: [],
        commandStats: {},
      },
    });
  });

  await page.route('**/api/monitoring/status', async (route) => {
    await route.fulfill({ json: { running: false, checking: false } });
  });

  await page.route('**/api/queue**', async (route) => {
    await route.fulfill({ json: { items: [], total: 0, limit: 50, offset: 0, hasMore: false } });
  });

  await page.route('**/api/unmapped**', async (route) => {
    await route.fulfill({ json: [] });
  });
}

async function stubDashboardApisWithFailedImportActivity(page: Page) {
  await page.route('**/api/stats', async (route) => {
    await route.fulfill({
      json: {
        artists: { total: 1, monitored: 1, downloaded: 0 },
        albums: { total: 1, monitored: 1, downloaded: 0 },
        tracks: { total: 10, monitored: 10, downloaded: 0 },
        videos: { total: 0, monitored: 0, downloaded: 0 },
      },
    });
  });

  await page.route('**/api/status/history?*', async (route) => {
    await route.fulfill({ json: { jobHistory: [] } });
  });

  await page.route('**/api/status', async (route) => {
    await route.fulfill({
      json: {
        activeJobs: [],
        queuedJobs: [],
        jobHistory: [
          {
            id: 77,
            type: 'ImportDownload',
            status: 'failed',
            description: 'Album: Around the World by Daft Punk',
            startTime: Date.now() - 40_000,
            endTime: Date.now() - 15_000,
            error: 'Failed to move files into the library',
            payload: {
              type: 'album',
              originalJobId: 12,
              resolved: { title: 'Around the World', artist: 'Daft Punk' },
            },
          },
        ],
        taskQueueStats: [],
        commandStats: {},
      },
    });
  });

  await page.route('**/api/queue/77/retry', async (route) => {
    await route.fulfill({ json: { message: 'Job queued for retry' } });
  });

  await page.route('**/api/monitoring/status', async (route) => {
    await route.fulfill({ json: { running: false, checking: false } });
  });

  await page.route('**/api/queue**', async (route) => {
    await route.fulfill({ json: { items: [], total: 0, limit: 50, offset: 0, hasMore: false } });
  });

  await page.route('**/api/unmapped**', async (route) => {
    await route.fulfill({ json: [] });
  });
}

async function stubDashboardApisWithFailedAlbumQueue(page: Page) {
  await page.route('**/api/stats', async (route) => {
    await route.fulfill({
      json: {
        artists: { total: 1, monitored: 1, downloaded: 0 },
        albums: { total: 1, monitored: 1, downloaded: 0 },
        tracks: { total: 10, monitored: 10, downloaded: 0 },
        videos: { total: 0, monitored: 0, downloaded: 0 },
      },
    });
  });

  await page.route('**/api/status/history?*', async (route) => {
    await route.fulfill({ json: { jobHistory: [] } });
  });

  await page.route('**/api/status', async (route) => {
    await route.fulfill({
      json: {
        activeJobs: [],
        queuedJobs: [],
        jobHistory: [],
        taskQueueStats: [],
        commandStats: {},
      },
    });
  });

  await page.route('**/api/monitoring/status', async (route) => {
    await route.fulfill({ json: { running: false, checking: false } });
  });

  await page.route('**/api/queue**', async (route) => {
    await route.fulfill({
      json: {
        items: [
          {
            id: 501,
            url: 'https://tidal.com/album/album-501',
            tidalId: 'album-501',
            type: 'album',
            status: 'failed',
            progress: 62,
            error: 'Network timeout while downloading album',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            title: 'From A Bakermat Point Of View',
            artist: 'Bakermat',
            cover: null,
            album_id: 'album-501',
            album_title: 'From A Bakermat Point Of View',
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
        hasMore: false,
      },
    });
  });

  await page.route('**/api/unmapped**', async (route) => {
    await route.fulfill({ json: [] });
  });

}

test.describe('Dashboard queue and activity tabs', () => {
  test('queue tab shows the empty-state card', async ({ page }) => {
    await stubDashboardApis(page);
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Queue$/i })).toBeVisible();
    await expect(page.getByText('No items in queue')).toBeVisible();
  });

  test('activity tab shows the empty-state card', async ({ page }) => {
    await stubDashboardApis(page);
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    await page.getByRole('tab', { name: /^Activity$/i }).click();
    await expect(page.getByText('No recent activity')).toBeVisible();
  });

  test('dashboard tab switching stays stable', async ({ page }) => {
    await stubDashboardApis(page);
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    const queueTab = page.getByRole('tab', { name: /^Queue$/i });
    const activityTab = page.getByRole('tab', { name: /^Activity$/i });
    const manualImportTab = page.getByRole('tab', { name: /^Unmapped Files$/i });

    await activityTab.click();
    await expect(page.getByText('No recent activity')).toBeVisible();

    await manualImportTab.click();
    await expect(page.getByText('There are no files waiting for review in your library folders.')).toBeVisible();

    await queueTab.click();
    await expect(page.getByText('No items in queue')).toBeVisible();
  });

  test('dashboard requests status data', async ({ page }) => {
    const statusCalls: string[] = [];
    await stubDashboardApis(page);

    page.on('response', (response) => {
      if (response.url().includes('/api/status')) {
        statusCalls.push(response.url());
      }
    });

    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    await expect(page.locator('main')).toBeVisible();
    await page.waitForTimeout(1000);
    expect(statusCalls.length).toBeGreaterThan(0);
  });

  test('activity tab uses action labels and clean subtitles', async ({ page }) => {
    await stubDashboardApisWithActivity(page);
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    await page.getByRole('tab', { name: /^Activity$/i }).click();

    await expect(page.getByText('Import Album').first()).toBeVisible();
    await expect(page.getByText('Refresh Artist')).toBeVisible();
    await expect(page.getByText('Missing Album Search')).toBeVisible();
    await expect(page.getByText('Around the World by Daft Punk').first()).toBeVisible();
    await expect(page.getByText('Daft Punk').first()).toBeVisible();
  });

  test('activity tab keeps running, queued, and recent work in separate sections', async ({ page }) => {
    await stubDashboardApisWithActivity(page);
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    await page.getByRole('tab', { name: /^Activity$/i }).click();

    await expect(page.getByLabel('Running')).toContainText('Import Album');
    await expect(page.getByLabel('Queued')).toContainText('Discovery by Daft Punk');
    await expect(page.getByLabel('Recent')).toContainText('Download Album');

    const sectionLabels = await page.locator('section[aria-label]').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('aria-label'))
    );

    expect(sectionLabels).toEqual(['Running', 'Queued', 'Recent']);
  });

  test('failed import activity shows context, error, and retry action', async ({ page }) => {
    await stubDashboardApisWithFailedImportActivity(page);
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    await page.getByRole('tab', { name: /^Activity$/i }).click();

    await expect(page.getByText('Import Album')).toBeVisible();
    await expect(page.getByText('Around the World by Daft Punk')).toBeVisible();
    await expect(page.getByText('Error: Failed to move files into the library')).toBeVisible();
    await expect(page.getByRole('button', { name: /Retry Job/i })).toBeVisible();
  });

  test('failed album queue keeps track rows out of queued state', async ({ page }) => {
    await page.addInitScript(({ targetUrlPart, mockEvents }) => {
      class MockEventSource {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSED = 2;
        readyState = MockEventSource.OPEN;
        url: string;
        withCredentials = false;
        onerror: ((event: Event) => void) | null = null;
        private listeners: Record<string, Array<(event: MessageEvent) => void>> = {};

        constructor(url: string) {
          this.url = url;

          if (url.includes(targetUrlPart)) {
            setTimeout(() => {
              for (const item of mockEvents) {
                const callbacks = this.listeners[item.type] || [];
                const event = { data: JSON.stringify(item.data) } as MessageEvent;
                callbacks.forEach((callback) => callback(event));
              }
            }, 0);
          }
        }

        addEventListener(type: string, callback: (event: MessageEvent) => void) {
          this.listeners[type] = this.listeners[type] || [];
          this.listeners[type].push(callback);
        }

        removeEventListener(type: string, callback: (event: MessageEvent) => void) {
          this.listeners[type] = (this.listeners[type] || []).filter((listener) => listener !== callback);
        }

        close() {
          this.readyState = MockEventSource.CLOSED;
        }
      }

      // @ts-expect-error test-only EventSource mock
      window.EventSource = MockEventSource;
    }, {
      targetUrlPart: '/api/queue/progress-stream',
      mockEvents: [
        { type: 'status', data: { isPaused: false, stats: [] } },
        {
          type: 'progress',
          data: {
            jobId: 501,
            tidalId: 'album-501',
            type: 'album',
            title: 'From A Bakermat Point Of View',
            artist: 'Bakermat',
            progress: 62,
            currentFileNum: 6,
            totalFiles: 10,
            state: 'downloading',
            tracks: [
              { title: 'Bakermat - So Glad That The Lord', trackNum: 1, status: 'completed' },
              { title: "Bakermat - Can't Bring Me Down", trackNum: 2, status: 'completed' },
              { title: 'Bakermat - Good Feeling', trackNum: 3, status: 'completed' },
              { title: 'Bakermat - Higher', trackNum: 4, status: 'completed' },
              { title: 'Bakermat - I Could Do Worse', trackNum: 5, status: 'completed' },
              { title: 'Bakermat - Bad Influence', trackNum: 6, status: 'downloading' },
              { title: 'Bakermat - Queen of NY', trackNum: 7, status: 'queued' },
              { title: 'Bakermat - Insane', trackNum: 8, status: 'queued' },
              { title: "Bakermat - Don't Wait", trackNum: 9, status: 'queued' },
              { title: 'Bakermat - Phenomenal', trackNum: 10, status: 'queued' },
            ],
          },
        },
        {
          type: 'failed',
          data: {
            jobId: 501,
            tidalId: 'album-501',
            type: 'album',
            error: 'Network timeout while downloading album',
          },
        },
      ],
    });

    await stubDashboardApisWithFailedAlbumQueue(page);
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/auth')) test.skip(true, 'Auth gate active');

    await expect(page.getByText('From A Bakermat Point Of View')).toBeVisible();
    await expect(page.getByText('Network timeout while downloading album').first()).toBeVisible();
    await expect(page.getByText('Bakermat - Bad Influence')).toBeVisible();
    await expect(page.getByText('Bakermat - Queen of NY')).toBeVisible();
    await page.waitForTimeout(200);
    await expect(page.getByText('Queued')).toHaveCount(0);
  });
});
