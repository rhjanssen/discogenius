import { expect, test, type Page } from '@playwright/test';

import { baseURL, stubShellApis } from './utils/mockShell';

type DashboardStubOptions = {
  stats?: Record<string, unknown>;
  status?: Record<string, unknown>;
  activityItems?: unknown[];
  queue?: Record<string, unknown>;
  historyItems?: unknown[];
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
  const activityItems = options?.activityItems || [];

  await stubShellApis(page, {
    libraryStats: {
      ...EMPTY_STATS,
      ...(options?.stats || {}),
    },
    statusOverview: {
      activity: {
        pending: activityItems.filter((item: any) => item?.status === 'pending').length,
        processing: activityItems.filter((item: any) => item?.status === 'running' || item?.status === 'processing').length,
        history: activityItems.filter((item: any) => ['completed', 'failed', 'cancelled'].includes(String(item?.status || ''))).length,
      },
      taskQueueStats: [],
      commandStats: {},
      ...(options?.status || {}),
    },
    activityResponse: {
      items: activityItems,
      total: activityItems.length,
      limit: 100,
      offset: 0,
      hasMore: false,
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
      `**/api/queue/${options.retryJobId}/retry`,
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
      activity: {
        pending: 1,
        processing: 3,
        history: 2,
      },
      taskQueueStats: [
        { type: 'ImportDownload', status: 'processing', count: 1 },
        { type: 'RefreshArtist', status: 'processing', count: 1 },
        { type: 'MissingAlbumSearch', status: 'running', count: 1 },
        { type: 'DownloadAlbum', status: 'pending', count: 1 },
      ],
      commandStats: {
        downloads: { pending: 1, processing: 1, failed: 0 },
        scans: { pending: 0, processing: 1, failed: 0 },
        other: { pending: 0, processing: 1, failed: 0 },
      },
    },
    activityItems: [
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
        status: 'processing',
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
      {
        id: 6,
        type: 'DownloadAlbum',
        status: 'pending',
        description: 'Queued album: Discovery by Daft Punk',
        queuePosition: 1,
        startTime: now - 15_000,
        payload: { title: 'Discovery', artist: 'Daft Punk', reason: 'monitoring' },
      },
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
      activity: {
        pending: 0,
        processing: 0,
        history: 1,
      },
      taskQueueStats: [],
      commandStats: { downloads: { failed: 1 } },
    },
    activityItems: [
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
    retryJobId: 77,
  };
}

function createFailedImportSuppressedFixture() {
  const now = Date.now();
  return {
    stats: {
      artists: { total: 1, monitored: 1, downloaded: 0 },
      albums: { total: 1, monitored: 1, downloaded: 0 },
      tracks: { total: 10, monitored: 10, downloaded: 0 },
      videos: { total: 0, monitored: 0, downloaded: 0 },
    },
    status: {
      activity: {
        pending: 1,
        processing: 0,
        history: 1,
      },
      taskQueueStats: [],
      commandStats: { downloads: { pending: 1, failed: 1 } },
    },
    activityHistoryItems: [
      {
        id: 177,
        type: 'ImportDownload',
        status: 'failed',
        description: 'Album: Around the World by Daft Punk',
        startTime: now - 90_000,
        endTime: now - 60_000,
        error: 'Failed to move files into the library',
        payload: {
          type: 'album',
          tidalId: 'tidal-album-123',
          originalJobId: 120,
          resolved: { title: 'Around the World', artist: 'Daft Punk' },
        },
      },
    ],
    inFlightItems: [
      {
        id: 178,
        type: 'DownloadAlbum',
        status: 'pending',
        description: 'Queued album: Around the World by Daft Punk',
        startTime: now - 5_000,
        payload: {
          type: 'album',
          tidalId: 'tidal-album-123',
          title: 'Around the World',
          artist: 'Daft Punk',
        },
      },
    ],
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
    status: {
      activity: {
        pending: 0,
        processing: 0,
        history: 0,
      },
      taskQueueStats: [],
      commandStats: {},
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

async function stubDashboardApisWithActivity(page: Page) {
  const fixture = createActivityFixture();
  await stubDashboardApis(page, fixture);
}

async function stubDashboardApisWithFailedImportActivity(page: Page) {
  const fixture = createFailedImportFixture();
  await stubDashboardApis(page, fixture);
}

async function stubDashboardApisWithFailedAlbumQueue(page: Page) {
  const fixture = createFailedAlbumQueueFixture();
  await stubDashboardApis(page, fixture);
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
    await expect(page.getByText('Download Album').first()).toBeVisible();
    await expect(page.getByText('Around the World by Daft Punk').first()).toBeVisible();
  });

  test('activity tab surfaces library audit context for imported and renamed files', async ({ page }) => {
    await stubDashboardApisWithActivity(page);
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await page.getByRole('tab', { name: /^Activity$/i }).click();

    const eventsSection = page.locator('section[aria-label="Events"]');
    await expect(eventsSection).toContainText('File imported');
    await expect(eventsSection).toContainText('Imported to …/Daft Punk/Around the World.flac');
    await expect(eventsSection).toContainText('File renamed');
    await expect(eventsSection).toContainText('…/Daft Punk/Old Name.flac → …/Daft Punk/Around the World.flac');
    await expect(eventsSection).toContainText('FLAC');
  });

  test('tasks tab keeps only scheduled and queue sections while activity stays event-driven', async ({ page }) => {
    await stubDashboardApisWithActivity(page);
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await page.getByRole('tab', { name: /^Tasks$/i }).click();
    const queueSection = page.locator('section[aria-label="Queue"]');

    await expect(queueSection).toContainText('Import Album');
    await expect(queueSection).toContainText('Download Album');

    const taskSectionLabels = await page.locator('section[aria-label]').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('aria-label')),
    );

    expect(taskSectionLabels).toEqual(['Scheduled tasks', 'Queue']);

    await page.getByRole('tab', { name: /^Activity$/i }).click();

    const eventsSection = page.locator('section[aria-label="Events"]');
    await expect(eventsSection).toContainText('Download Album');
    await expect(eventsSection).toContainText('File imported');

    const sectionLabels = await page.locator('section[aria-label]').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('aria-label')),
    );

    expect(sectionLabels).toEqual(['Events']);
  });

  test('failed import activity shows context, error, and retry action', async ({ page }) => {
    await stubDashboardApisWithFailedImportActivity(page);
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await page.getByRole('tab', { name: /^Activity$/i }).click();

    await expect(page.getByText('Import Album').first()).toBeVisible();
    await expect(page.getByText('Around the World by Daft Punk')).toBeVisible();
    await expect(page.getByText('Error: Failed to move files into the library')).toBeVisible();
    await expect(page.getByRole('button', { name: /Retry Job/i })).toBeVisible();
  });

  test('failed import activity hides retry when superseding in-flight activity exists', async ({ page }) => {
    const fixture = createFailedImportSuppressedFixture();
    await stubDashboardApis(page, {
      stats: fixture.stats,
      status: fixture.status,
      activityItems: fixture.activityHistoryItems,
    });

    await page.route('**/api/activity**', async (route) => {
      const url = new URL(route.request().url());
      const statuses = (url.searchParams.get('statuses') || '').split(',').filter(Boolean);

      const items = statuses.includes('completed') || statuses.includes('failed') || statuses.includes('cancelled')
        ? fixture.activityHistoryItems
        : fixture.inFlightItems;

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items,
          total: items.length,
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      });
    });

    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await page.getByRole('tab', { name: /^Activity$/i }).click();

    await expect(page.getByText('Import Album').first()).toBeVisible();
    await expect(page.getByText('Error: Failed to move files into the library')).toBeVisible();
    await expect(page.getByRole('button', { name: /Retry Job/i })).toHaveCount(0);
  });

  test('failed import activity conservatively hides retry when in-flight feed is paged', async ({ page }) => {
    const now = Date.now();
    const historyItems = [
      {
        id: 277,
        type: 'ImportDownload',
        status: 'failed',
        description: 'Album: Around the World by Daft Punk',
        startTime: now - 90_000,
        endTime: now - 60_000,
        error: 'Failed to move files into the library',
        payload: {
          type: 'album',
          tidalId: 'tidal-album-456',
          originalJobId: 220,
          resolved: { title: 'Around the World', artist: 'Daft Punk' },
        },
      },
    ];

    await stubDashboardApis(page, {
      activityItems: historyItems,
      status: {
        activity: {
          pending: 1,
          processing: 0,
          history: 1,
        },
        taskQueueStats: [],
        commandStats: { downloads: { pending: 1, failed: 1 } },
      },
    });

    await page.route('**/api/activity**', async (route) => {
      const url = new URL(route.request().url());
      const statuses = (url.searchParams.get('statuses') || '').split(',').filter(Boolean);
      const isHistoryRequest = statuses.includes('completed') || statuses.includes('failed') || statuses.includes('cancelled');

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: isHistoryRequest ? historyItems : [],
          total: isHistoryRequest ? historyItems.length : 200,
          limit: 100,
          offset: 0,
          hasMore: !isHistoryRequest,
        }),
      });
    });

    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await page.getByRole('tab', { name: /^Activity$/i }).click();

    await expect(page.getByText('Import Album').first()).toBeVisible();
    await expect(page.getByText('Error: Failed to move files into the library')).toBeVisible();
    await expect(page.getByRole('button', { name: /Retry Job/i })).toHaveCount(0);
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
