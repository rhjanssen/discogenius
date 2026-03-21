import { expect, test, type Page } from '@playwright/test';

import { baseURL, stubShellApis } from './utils/mockShell';

type DashboardStubOptions = {
  stats?: Record<string, unknown>;
  status?: Record<string, unknown>;
  queue?: Record<string, unknown>;
  historyItems?: unknown[];
  statusHistory?: Record<string, unknown>;
  unmapped?: unknown[];
  retryJobId?: number;
  retryResponse?: Record<string, unknown>;
};

const EMPTY_STATS = {
  artists: { total: 0, monitored: 0, downloaded: 0 },
  albums: { total: 0, monitored: 0, downloaded: 0 },
  tracks: { total: 0, monitored: 0, downloaded: 0 },
  videos: { total: 0, monitored: 0, downloaded: 0 },
};

async function stubDashboardApis(page: Page, options?: DashboardStubOptions) {
  await stubShellApis(page, {
    libraryStats: {
      ...EMPTY_STATS,
      ...(options?.stats || {}),
    },
    statusOverview: {
      activeJobs: [],
      queuedJobs: [],
      jobHistory: [],
      taskQueueStats: [],
      commandStats: {},
      ...(options?.status || {}),
    },
    queueResponse: {
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
      ...(options?.queue || {}),
    },
    monitoringStatus: {
      running: false,
      checking: false,
    },
  });

  await page.route('**/api/status/history?*', async (route) => {
    await route.fulfill({ json: options?.statusHistory || { jobHistory: [] } });
  });

  await page.route('**/api/history?*', async (route) => {
    const items = options?.historyItems || [];
    await route.fulfill({
      json: {
        items,
        total: items.length,
        limit: 12,
        offset: 0,
      },
    });
  });

  await page.route('**/api/unmapped**', async (route) => {
    await route.fulfill({ json: options?.unmapped || [] });
  });

  if (typeof options?.retryJobId === 'number') {
    await page.route(
      '**/api/queue/${options.retryJobId}/retry',
      async (route) => {
        await route.fulfill({ json: options?.retryResponse || { message: 'Job queued for retry' } });
      },
    );
  }
}

function createActivityFixture() {
  const now = Date.now();
  return {
    stats: {
      artists: { total: 1, monitored: 1, downloaded: 0 },
      albums: { total: 1, monitored: 1, downloaded: 0 },
      tracks: { total: 2, monitored: 2, downloaded: 0 },
      videos: { total: 0, monitored: 0, downloaded: 0 },
    },
    status: {
      activeJobs: [
        {
          id: 1,
          type: 'ImportDownload',
          status: 'running',
          description: 'Album: Around the World by Daft Punk',
          startTime: now,
          payload: { type: 'album', reason: 'upgrade', resolved: { title: 'Around the World', artist: 'Daft Punk' } },
        },
        {
          id: 2,
          type: 'RefreshArtist',
          status: 'running',
          description: 'Daft Punk',
          startTime: now,
        },
        {
          id: 3,
          type: 'MissingAlbumSearch',
          status: 'running',
          description: 'Daft Punk',
          startTime: now,
        },
      ],
      queuedJobs: [
        {
          id: 6,
          type: 'DownloadAlbum',
          status: 'pending',
          description: 'Queued album: Discovery by Daft Punk',
          startTime: now - 15_000,
          payload: { title: 'Discovery', artist: 'Daft Punk', reason: 'monitoring' },
        },
      ],
      jobHistory: [
        {
          id: 4,
          type: 'DownloadAlbum',
          status: 'completed',
          description: 'Downloading album: Around the World by Daft Punk',
          startTime: now - 30_000,
          endTime: now - 10_000,
          payload: { title: 'Around the World', artist: 'Daft Punk' },
        },
        {
          id: 5,
          type: 'ImportDownload',
          status: 'completed',
          description: 'Album: Around the World by Daft Punk',
          startTime: now - 20_000,
          endTime: now - 5_000,
          payload: { type: 'album', resolved: { title: 'Around the World', artist: 'Daft Punk' } },
        },
      ],
    },
    historyItems: [
      {
        id: 90,
        artistId: 11,
        albumId: 22,
        mediaId: 33,
        libraryFileId: 44,
        eventType: 'TrackFileImported',
        quality: 'FLAC',
        sourceTitle: 'Around the World',
        data: {
          importedPath: 'E:/music/Daft Punk/Around the World.flac',
        },
        date: new Date(now - 3_000).toISOString(),
      },
      {
        id: 91,
        artistId: 11,
        albumId: 22,
        mediaId: 33,
        libraryFileId: 44,
        eventType: 'TrackFileRenamed',
        quality: 'FLAC',
        sourceTitle: 'Around the World',
        data: {
          fromPath: 'E:/music/Daft Punk/Old Name.flac',
          toPath: 'E:/music/Daft Punk/Around the World.flac',
        },
        date: new Date(now - 60_000).toISOString(),
      },
    ],
  };
}

function createFailedImportFixture() {
  const now = Date.now();
  return {
    stats: {
      artists: { total: 1, monitored: 1, downloaded: 0 },
      albums: { total: 1, monitored: 1, downloaded: 0 },
      tracks: { total: 10, monitored: 10, downloaded: 0 },
      videos: { total: 0, monitored: 0, downloaded: 0 },
    },
    status: {
      jobHistory: [
        {
          id: 77,
          type: 'ImportDownload',
          status: 'failed',
          description: 'Album: Around the World by Daft Punk',
          startTime: now - 40_000,
          endTime: now - 15_000,
          error: 'Failed to move files into the library',
          payload: {
            type: 'album',
            originalJobId: 12,
            resolved: { title: 'Around the World', artist: 'Daft Punk' },
          },
        },
      ],
    },
    retryJobId: 77,
  };
}

function createFailedAlbumQueueFixture() {
  const nowIso = new Date().toISOString();
  return {
    stats: {
      artists: { total: 1, monitored: 1, downloaded: 0 },
      albums: { total: 1, monitored: 1, downloaded: 0 },
      tracks: { total: 10, monitored: 10, downloaded: 0 },
      videos: { total: 0, monitored: 0, downloaded: 0 },
    },
    queue: {
      items: [
        {
          id: 501,
          url: 'https://tidal.com/album/album-501',
          tidalId: 'album-501',
          type: 'album',
          status: 'failed',
          progress: 62,
          error: 'Network timeout while downloading album',
          created_at: nowIso,
          updated_at: nowIso,
          title: 'From A Bakermat Point Of View',
          artist: 'Bakermat',
          cover: null,
          album_id: 'album-501',
          album_title: 'From A Bakermat Point Of View',
        },
      ],
      total: 1,
      hasMore: false,
    },
  };
}

test.describe('Dashboard queue and activity tabs', () => {
  test('queue tab shows the empty-state card', async ({ page }) => {
    await stubDashboardApis(page);
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Queue$/i })).toBeVisible();
    await expect(page.getByText('No items in queue')).toBeVisible();
  });

  test('activity tab shows the empty-state card', async ({ page }) => {
    await stubDashboardApis(page);
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await page.getByRole('tab', { name: /^Activity$/i }).click();
    await expect(page.getByText('No recent activity')).toBeVisible();
  });

  test('dashboard tab switching stays stable', async ({ page }) => {
    await stubDashboardApis(page);
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

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
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await expect(page.getByRole('tab', { name: /^Queue$/i })).toBeVisible();
    await page.waitForTimeout(1000);
    expect(statusCalls.length).toBeGreaterThan(0);
  });

  test('activity tab uses action labels and clean subtitles', async ({ page }) => {
    await stubDashboardApisWithActivity(page);
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await page.getByRole('tab', { name: /^Activity$/i }).click();

    await expect(page.getByText('Import Album').first()).toBeVisible();
    await expect(page.getByText('Refresh Artist')).toBeVisible();
    await expect(page.getByText('Missing Album Search')).toBeVisible();
    await expect(page.getByText('Around the World by Daft Punk').first()).toBeVisible();
    await expect(page.getByText('Daft Punk').first()).toBeVisible();
  });

  test('activity tab surfaces library audit context for imported and renamed files', async ({ page }) => {
    await stubDashboardApisWithActivity(page);
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await page.getByRole('tab', { name: /^Activity$/i }).click();

    const auditSection = page.locator('section[aria-label="Library audit"]');
    await expect(auditSection).toContainText('File imported');
    await expect(auditSection).toContainText('Imported to …/Daft Punk/Around the World.flac');
    await expect(auditSection).toContainText('File renamed');
    await expect(auditSection).toContainText('…/Daft Punk/Old Name.flac → …/Daft Punk/Around the World.flac');
    await expect(auditSection).toContainText('FLAC');
  });

  test('activity tab keeps running, queued, and recent work in separate sections', async ({ page }) => {
    await stubDashboardApisWithActivity(page);
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await page.getByRole('tab', { name: /^Activity$/i }).click();

    await expect(page.getByLabel('Running')).toContainText('Import Album');
    await expect(page.getByLabel('Queued')).toContainText('Discovery by Daft Punk');
    await expect(page.getByLabel('Recent')).toContainText('Download Album');

    const sectionLabels = await page.locator('section[aria-label]').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('aria-label'))
    );

    expect(sectionLabels).toEqual(['Running', 'Queued', 'Recent', 'Library audit']);
  });

  test('failed import activity shows context, error, and retry action', async ({ page }) => {
    await stubDashboardApisWithFailedImportActivity(page);
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

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
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await expect(page.getByText('From A Bakermat Point Of View')).toBeVisible();
    await expect(page.getByText('Network timeout while downloading album').first()).toBeVisible();
    await expect(page.getByText('Bakermat - Bad Influence')).toBeVisible();
    await expect(page.getByText('Bakermat - Queen of NY')).toBeVisible();
    await page.waitForTimeout(200);
    await expect(page.getByText('Queued')).toHaveCount(0);
  });
});
