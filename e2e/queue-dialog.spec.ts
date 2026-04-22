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
  const historyItems = options?.historyItems || [];

  await stubShellApis(page, {
    libraryStats: {
      ...EMPTY_STATS,
      ...(options?.stats || {}),
    },
    statusOverview: {
      activity: {
        pending: activityItems.filter((item: any) => item?.status === 'pending').length,
        processing: activityItems.filter((item: any) => item?.status === 'running' || item?.status === 'processing').length,
        history: historyItems.length,
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
    queueHistoryResponse: {
      items: historyItems,
      total: historyItems.length,
      limit: 12,
      offset: 0,
      hasMore: false,
    },
    monitoringStatus: {
      running: false,
      checking: false,
    },
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
        startTime: now - 60_000,
        payload: { type: 'album', reason: 'upgrade', resolved: { title: 'Around the World', artist: 'Daft Punk' } },
      },
      {
        id: 2,
        type: 'RefreshArtist',
        status: 'processing',
        description: 'Daft Punk',
        startTime: now - 5_000,
      },
      {
        id: 3,
        type: 'MissingAlbumSearch',
        status: 'running',
        description: 'Daft Punk',
        startTime: now - 30_000,
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
        tidalId: 'track-history-90',
        type: 'track',
        status: 'completed',
        progress: 100,
        title: 'Around the World',
        artist: 'Daft Punk',
        cover: null,
        album_id: 'album-history-22',
        album_title: 'Homework',
        quality: 'FLAC',
        created_at: new Date(now - 20_000).toISOString(),
        updated_at: new Date(now - 3_000).toISOString(),
        started_at: new Date(now - 15_000).toISOString(),
        completed_at: new Date(now - 3_000).toISOString(),
      },
      {
        id: 91,
        tidalId: 'album-history-91',
        type: 'album',
        status: 'failed',
        progress: 100,
        title: 'Discovery',
        artist: 'Daft Punk',
        cover: null,
        album_id: 'album-history-91',
        album_title: 'Discovery',
        quality: 'FLAC',
        error: 'Failed to move files into the library',
        created_at: new Date(now - 120_000).toISOString(),
        updated_at: new Date(now - 60_000).toISOString(),
        started_at: new Date(now - 90_000).toISOString(),
        completed_at: new Date(now - 60_000).toISOString(),
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

function createPendingPriorityQueueFixture() {
  const nowIso = new Date().toISOString();
  return {
    status: {
      activity: {
        pending: 2,
        processing: 0,
        history: 0,
      },
      taskQueueStats: [
        { type: 'DownloadAlbum', status: 'pending', count: 2 },
      ],
      commandStats: {
        downloads: { pending: 2, processing: 0, failed: 0 },
      },
    },
    queue: {
      items: [
        {
          id: 802,
          url: 'https://tidal.com/album/album-802',
          tidalId: 'album-802',
          type: 'album',
          status: 'pending',
          progress: 0,
          created_at: nowIso,
          updated_at: nowIso,
          title: 'Discovery',
          artist: 'Daft Punk',
          cover: null,
          album_id: 'album-802',
          album_title: 'Discovery',
        },
        {
          id: 803,
          url: 'https://tidal.com/album/album-803',
          tidalId: 'album-803',
          type: 'album',
          status: 'pending',
          progress: 0,
          created_at: nowIso,
          updated_at: nowIso,
          title: 'Homework',
          artist: 'Daft Punk',
          cover: null,
          album_id: 'album-803',
          album_title: 'Homework',
        },
      ],
      total: 3,
      hasMore: false,
    },
  };
}

function createPendingOnlyQueueFixture() {
  const nowIso = new Date().toISOString();
  return {
    status: {
      activity: {
        pending: 1,
        processing: 0,
        history: 0,
      },
      taskQueueStats: [
        { type: 'DownloadAlbum', status: 'pending', count: 1 },
      ],
      commandStats: {
        downloads: { pending: 1, processing: 0, failed: 0 },
      },
    },
    queue: {
      items: [
        {
          id: 901,
          url: 'https://tidal.com/album/album-901',
          tidalId: 'album-901',
          type: 'album',
          status: 'pending',
          progress: 0,
          created_at: nowIso,
          updated_at: nowIso,
          title: 'Discovery',
          artist: 'Daft Punk',
          cover: null,
          album_id: 'album-901',
          album_title: 'Discovery',
        },
      ],
      total: 1,
      hasMore: false,
    },
  };
}

function createMixedLiveQueueFixture() {
  const nowIso = new Date().toISOString();
  const now = Date.now();

  return {
    status: {
      activity: {
        pending: 2,
        processing: 1,
        history: 1,
      },
      taskQueueStats: [
        { type: 'DownloadAlbum', status: 'processing', count: 1 },
        { type: 'DownloadAlbum', status: 'pending', count: 2 },
      ],
      commandStats: {
        downloads: { pending: 2, processing: 1, failed: 0 },
      },
    },
    queue: {
      items: [
        {
          id: 1001,
          url: 'https://tidal.com/album/album-1001',
          tidalId: 'album-1001',
          type: 'album',
          status: 'downloading',
          progress: 48,
          created_at: nowIso,
          updated_at: nowIso,
          started_at: nowIso,
          title: 'From A Bakermat Point Of View',
          artist: 'Bakermat',
          cover: null,
          album_id: 'album-1001',
          album_title: 'From A Bakermat Point Of View',
          currentFileNum: 5,
          totalFiles: 10,
          currentTrack: 'Bakermat - Another Man',
          trackProgress: 48,
          trackStatus: 'downloading',
          state: 'downloading',
          tracks: [
            { title: 'Bakermat - One Day', trackNum: 1, status: 'completed' },
            { title: 'Bakermat - Baianá', trackNum: 2, status: 'completed' },
            { title: 'Bakermat - Learn to Lose', trackNum: 3, status: 'completed' },
            { title: 'Bakermat - Trouble', trackNum: 4, status: 'completed' },
            { title: 'Bakermat - Another Man', trackNum: 5, status: 'downloading' },
            { title: 'Bakermat - Dreamreacher', trackNum: 6, status: 'queued' },
            { title: 'Bakermat - Games Continued', trackNum: 7, status: 'queued' },
          ],
        },
        {
          id: 1002,
          url: 'https://tidal.com/album/album-1002',
          tidalId: 'album-1002',
          type: 'album',
          status: 'pending',
          progress: 0,
          created_at: nowIso,
          updated_at: nowIso,
          title: 'Discovery',
          artist: 'Daft Punk',
          cover: null,
          album_id: 'album-1002',
          album_title: 'Discovery',
        },
        {
          id: 1003,
          url: 'https://tidal.com/album/album-1003',
          tidalId: 'album-1003',
          type: 'album',
          status: 'pending',
          progress: 0,
          created_at: nowIso,
          updated_at: nowIso,
          title: 'Homework',
          artist: 'Daft Punk',
          cover: null,
          album_id: 'album-1003',
          album_title: 'Homework',
        },
      ],
      total: 3,
      hasMore: false,
    },
    historyItems: [
      {
        id: 190,
        tidalId: 'album-history-190',
        type: 'album',
        status: 'completed',
        progress: 100,
        title: 'Around the World',
        artist: 'Daft Punk',
        cover: null,
        album_id: 'album-history-190',
        album_title: 'Around the World',
        created_at: new Date(now - 90_000).toISOString(),
        updated_at: new Date(now - 30_000).toISOString(),
        started_at: new Date(now - 60_000).toISOString(),
        completed_at: new Date(now - 30_000).toISOString(),
      },
    ],
  };
}

function createBackendOrderedMixedQueueFixture() {
  const nowIso = new Date().toISOString();

  return {
    status: {
      activity: {
        pending: 1,
        processing: 1,
        history: 0,
      },
      taskQueueStats: [
        { type: 'DownloadAlbum', status: 'pending', count: 1 },
        { type: 'ImportDownload', status: 'processing', count: 1 },
        { type: 'DownloadAlbum', status: 'processing', count: 1 },
      ],
      commandStats: {
        downloads: { pending: 1, processing: 2, failed: 0 },
      },
    },
    queue: {
      items: [
        {
          id: 1201,
          url: 'https://tidal.com/album/album-1201',
          tidalId: 'album-1201',
          type: 'album',
          status: 'pending',
          progress: 0,
          created_at: nowIso,
          updated_at: nowIso,
          title: 'Alpha pending',
          artist: 'Queue Order',
          cover: null,
          album_id: 'album-1201',
          album_title: 'Alpha pending',
          queuePosition: 1,
        },
        {
          id: 1202,
          url: 'https://tidal.com/album/album-1202',
          tidalId: 'album-1202',
          type: 'album',
          status: 'processing',
          stage: 'import',
          state: 'importing',
          progress: 100,
          created_at: nowIso,
          updated_at: nowIso,
          started_at: nowIso,
          title: 'Bravo importing',
          artist: 'Queue Order',
          cover: null,
          album_id: 'album-1202',
          album_title: 'Bravo importing',
          queuePosition: 2,
        },
        {
          id: 1203,
          url: 'https://tidal.com/album/album-1203',
          tidalId: 'album-1203',
          type: 'album',
          status: 'downloading',
          stage: 'download',
          state: 'downloading',
          progress: 26,
          created_at: nowIso,
          updated_at: nowIso,
          started_at: nowIso,
          title: 'Charlie downloading',
          artist: 'Queue Order',
          cover: null,
          album_id: 'album-1203',
          album_title: 'Charlie downloading',
          queuePosition: 3,
        },
      ],
      total: 3,
      hasMore: false,
    },
  };
}

function createImportTransitionQueueFixture() {
  const nowIso = new Date().toISOString();

  return {
    status: {
      activity: {
        pending: 1,
        processing: 2,
        history: 0,
      },
      taskQueueStats: [
        { type: 'DownloadAlbum', status: 'processing', count: 2 },
        { type: 'DownloadAlbum', status: 'pending', count: 1 },
      ],
      commandStats: {
        downloads: { pending: 1, processing: 2, failed: 0 },
      },
    },
    queue: {
      items: [
        {
          id: 1301,
          url: 'https://tidal.com/album/album-1301',
          tidalId: 'album-1301',
          type: 'album',
          status: 'downloading',
          stage: 'download',
          state: 'downloading',
          progress: 51,
          created_at: nowIso,
          updated_at: nowIso,
          started_at: nowIso,
          title: 'Anchor download',
          artist: 'Queue Order',
          cover: null,
          album_id: 'album-1301',
          album_title: 'Anchor download',
          queuePosition: 1,
        },
        {
          id: 1302,
          url: 'https://tidal.com/album/album-1302',
          tidalId: 'album-1302',
          type: 'album',
          status: 'downloading',
          stage: 'download',
          state: 'downloading',
          progress: 98,
          created_at: nowIso,
          updated_at: nowIso,
          started_at: nowIso,
          title: 'Import stays second',
          artist: 'Queue Order',
          cover: null,
          album_id: 'album-1302',
          album_title: 'Import stays second',
          queuePosition: 2,
        },
        {
          id: 1303,
          url: 'https://tidal.com/album/album-1303',
          tidalId: 'album-1303',
          type: 'album',
          status: 'pending',
          progress: 0,
          created_at: nowIso,
          updated_at: nowIso,
          title: 'Next download',
          artist: 'Queue Order',
          cover: null,
          album_id: 'album-1303',
          album_title: 'Next download',
          queuePosition: 3,
        },
      ],
      total: 3,
      hasMore: false,
    },
  };
}

function createImportSubitemFixture() {
  const nowIso = new Date().toISOString();

  return {
    status: {
      activity: {
        pending: 1,
        processing: 1,
        history: 0,
      },
      taskQueueStats: [
        { type: 'ImportDownload', status: 'processing', count: 1 },
        { type: 'DownloadTrack', status: 'pending', count: 1 },
      ],
      commandStats: {
        downloads: { pending: 1, processing: 1, failed: 0 },
      },
    },
    queue: {
      items: [
        {
          id: 1401,
          url: 'https://tidal.com/track/track-1401',
          tidalId: 'track-1401',
          type: 'track',
          status: 'processing',
          stage: 'import',
          state: 'importing',
          progress: 100,
          created_at: nowIso,
          updated_at: nowIso,
          started_at: nowIso,
          title: 'Import track alpha',
          artist: 'Daft Punk',
          cover: null,
          album_id: 'album-1400',
          album_title: 'Discovery import group',
          queuePosition: 1,
        },
        {
          id: 1402,
          url: 'https://tidal.com/track/track-1402',
          tidalId: 'track-1402',
          type: 'track',
          status: 'pending',
          stage: 'download',
          progress: 0,
          created_at: nowIso,
          updated_at: nowIso,
          title: 'Queued track beta',
          artist: 'Daft Punk',
          cover: null,
          album_id: 'album-1400',
          album_title: 'Discovery import group',
          queuePosition: 2,
        },
      ],
      total: 2,
      hasMore: false,
    },
  };
}

function createQueueHistoryNavigationFixture() {
  const now = Date.now();

  return {
    stats: {
      artists: { total: 1, monitored: 1, downloaded: 0 },
      albums: { total: 1, monitored: 1, downloaded: 0 },
      tracks: { total: 1, monitored: 1, downloaded: 0 },
      videos: { total: 0, monitored: 0, downloaded: 0 },
    },
    status: {
      activity: {
        pending: 0,
        processing: 0,
        history: 1,
      },
      taskQueueStats: [],
      commandStats: {},
    },
    historyItems: [
      {
        id: 290,
        tidalId: 'track-history-1',
        type: 'track',
        status: 'completed',
        progress: 100,
        title: 'Digital Love',
        artist: 'Daft Punk',
        cover: null,
        album_id: 'album-history-1',
        album_title: 'Discovery',
        created_at: new Date(now - 120_000).toISOString(),
        updated_at: new Date(now - 45_000).toISOString(),
        started_at: new Date(now - 90_000).toISOString(),
        completed_at: new Date(now - 45_000).toISOString(),
      },
    ],
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

    const runningSectionText = await page.locator('section[aria-label="Running"]').innerText();
    expect(runningSectionText.indexOf('Import Album')).toBeLessThan(runningSectionText.indexOf('Refresh Artist'));
    expect(runningSectionText.indexOf('Refresh Artist')).toBeLessThan(runningSectionText.indexOf('Missing Album Search'));
  });

  test('activity tab uses the current running, queued, and recent sections', async ({ page }) => {
    await stubDashboardApisWithActivity(page);
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await page.getByRole('tab', { name: /^Activity$/i }).click();

    await expect(page.locator('section[aria-label="Running"]')).toContainText('Import Album');
    await expect(page.locator('section[aria-label="Queued"]')).toContainText('Download Album');
    await expect(page.locator('section[aria-label="Recent"]')).toContainText('Download Album');
    await expect(page.locator('section[aria-label="Library audit"]')).toHaveCount(0);

    const sectionLabels = await page.locator('section[aria-label]').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('aria-label')),
    );

    expect(sectionLabels).toEqual(['Running', 'Queued', 'Recent']);
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
          type: 'progress-batch',
          data: [{
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
          }],
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

  test('queue tab inserts an active album from live started and progress events before queue refresh completes', async ({ page }) => {
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
          type: 'started',
          data: {
            jobId: 901,
            tidalId: 'album-901',
            type: 'album',
            title: 'Discovery',
            artist: 'Daft Punk',
            cover: null,
          },
        },
        {
          type: 'progress-batch',
          data: [{
            jobId: 901,
            tidalId: 'album-901',
            type: 'album',
            title: 'Discovery',
            artist: 'Daft Punk',
            progress: 21,
            currentFileNum: 3,
            totalFiles: 14,
            state: 'downloading',
          }],
        },
      ],
    });

    await stubDashboardApis(page, {
      queue: {
        items: [],
        total: 0,
        hasMore: false,
      },
    });

    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await expect(page.getByText('Discovery')).toBeVisible();
    await expect(page.getByText('Daft Punk')).toBeVisible();
    await expect(page.getByText('Album', { exact: true })).toBeVisible();
    await expect(page.getByText('No items in queue')).toHaveCount(0);
  });

  test('queue tab keeps pending-only queue groups visible', async ({ page }) => {
    await stubDashboardApis(page, createPendingOnlyQueueFixture());
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await expect(page.getByText('Discovery')).toBeVisible();
    await expect(page.getByText('Daft Punk')).toBeVisible();
    await expect(page.getByRole('button', { name: /Move Discovery up/i })).toBeVisible();
  });

  test('queue history row navigates to the album page when track history includes album context', async ({ page }) => {
    await stubDashboardApis(page, createQueueHistoryNavigationFixture());

    await page.route('**/api/albums/album-history-1/page', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          album: {
            id: 'album-history-1',
            title: 'Discovery',
            artist_id: 'artist-history-1',
            artist_name: 'Daft Punk',
            is_downloaded: false,
            downloaded: 0,
            cover_id: null,
            vibrant_color: null,
            is_monitored: true,
            monitor_locked: false,
            num_tracks: 0,
            last_scanned: null,
            quality: null,
            release_date: '2001-03-13',
            files: [],
          },
          tracks: [],
          otherVersions: [],
          similarAlbums: [],
          artistPicture: null,
          artistCoverImageUrl: null,
        }),
      });
    });

    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    const historyRow = page.locator('section[aria-label="Queue history"]').getByRole('link', { name: /Open Digital Love/i });

    await expect(historyRow).toBeVisible();
    await historyRow.click();

    await expect(page).toHaveURL(`${baseURL}/album/album-history-1`);
    await expect(page.getByText('No tracks found')).toBeVisible();
  });

  test('queue tab shows inline pending reorder controls without a dialog', async ({ page }) => {
    await stubDashboardApis(page, createPendingPriorityQueueFixture());
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    await expect(page.getByRole('button', { name: 'Edit priorities' })).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await expect(page.getByText('Discovery')).toBeVisible();
    await expect(page.getByText('Homework')).toBeVisible();
    await expect(page.getByRole('button', { name: /Move Discovery up/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Move Discovery down/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Move Homework up/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Move Homework down/i })).toBeVisible();
  });

  test('queue tab keeps active and pending live queue groups visible in a stable list', async ({ page }) => {
    await stubDashboardApis(page, createMixedLiveQueueFixture());
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    const liveQueue = page.locator('section[aria-label="Active"]');
    const liveGroups = liveQueue.locator('[data-queue-group-id]');

    await expect(liveQueue.getByText('From A Bakermat Point Of View')).toBeVisible();
    await expect(liveQueue.getByText('Discovery')).toBeVisible();
    await expect(liveQueue.getByText('Homework')).toBeVisible();
    await expect(liveQueue.getByText('Bakermat - Dreamreacher')).toBeVisible();
    await expect(liveQueue.getByRole('button', { name: /Move Discovery up/i })).toBeVisible();
    await expect(liveQueue.getByRole('button', { name: /Move Homework down/i })).toBeVisible();

    const boxesBeforeHover = await liveGroups.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
      }),
    );

    expect(boxesBeforeHover).toHaveLength(3);
    expect(boxesBeforeHover.every((box) => box.height > 0)).toBeTruthy();
    for (let index = 1; index < boxesBeforeHover.length; index += 1) {
      expect(boxesBeforeHover[index].top).toBeGreaterThanOrEqual(boxesBeforeHover[index - 1].bottom - 1);
    }

    await liveGroups.nth(0).hover();

    const boxesAfterHover = await liveGroups.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
      }),
    );

    expect(boxesAfterHover).toHaveLength(3);
    expect(boxesAfterHover.every((box) => box.height > 0)).toBeTruthy();
    for (let index = 1; index < boxesAfterHover.length; index += 1) {
      expect(boxesAfterHover[index].top).toBeGreaterThanOrEqual(boxesAfterHover[index - 1].bottom - 1);
    }
  });

  test('queue tab keeps pending rows visible in backend order under mixed pending, importing, and downloading states', async ({ page }) => {
    await stubDashboardApis(page, createBackendOrderedMixedQueueFixture());
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    const liveQueue = page.locator('section[aria-label="Active"]');
    const liveGroups = liveQueue.locator('[data-queue-group-id]');

    await expect(liveGroups).toHaveCount(3);
    await expect(liveGroups.nth(0)).toContainText('Bravo importing');
    await expect(liveGroups.nth(1)).toContainText('Charlie downloading');
    await expect(liveGroups.nth(2)).toContainText('Alpha pending');
    await expect(liveQueue.getByRole('button', { name: /Move Alpha pending up/i })).toBeVisible();
    await expect(liveGroups.nth(0).getByText(/^importing$/i)).toBeVisible();
  });

  test('queue tab keeps an importing row in place when a later item starts downloading', async ({ page }) => {
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
            for (const item of mockEvents) {
              setTimeout(() => {
                const callbacks = this.listeners[item.type] || [];
                const event = { data: JSON.stringify(item.data) } as MessageEvent;
                callbacks.forEach((callback) => callback(event));
              }, item.delayMs);
            }
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
        { delayMs: 0, type: 'status', data: { isPaused: false, stats: [] } },
        {
          delayMs: 150,
          type: 'progress-batch',
          data: [{
            jobId: 1302,
            tidalId: 'album-1302',
            type: 'album',
            title: 'Import stays second',
            artist: 'Queue Order',
            progress: 100,
            state: 'importing',
            statusMessage: 'Waiting to import',
          }],
        },
        {
          delayMs: 200,
          type: 'started',
          data: {
            jobId: 1303,
            tidalId: 'album-1303',
            type: 'album',
            title: 'Next download',
            artist: 'Queue Order',
            cover: null,
          },
        },
        {
          delayMs: 240,
          type: 'progress-batch',
          data: [{
            jobId: 1303,
            tidalId: 'album-1303',
            type: 'album',
            title: 'Next download',
            artist: 'Queue Order',
            progress: 14,
            state: 'downloading',
          }],
        },
      ],
    });

    await stubDashboardApis(page, createImportTransitionQueueFixture());
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    const liveGroups = page.locator('section[aria-label="Active"] [data-queue-group-id]');

    await expect(liveGroups).toHaveCount(3);
    await expect(liveGroups.nth(0)).toContainText('Import stays second');
    await expect(liveGroups.nth(1)).toContainText('Anchor download');
    await expect(liveGroups.nth(2)).toContainText('Next download');

    await page.waitForTimeout(500);

    await expect(liveGroups.nth(0)).toContainText('Import stays second');
    await expect(liveGroups.nth(0).getByText(/^importing$/i)).toBeVisible();
    await expect(liveGroups.nth(1)).toContainText('Anchor download');
    await expect(liveGroups.nth(2)).toContainText('Next download');
  });

  test('queue tab renders import status text cleanly inside subitems instead of clipping it into the status gutter', async ({ page }) => {
    await stubDashboardApis(page, createImportSubitemFixture());
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:$|\?)/);

    const importTrackRow = page
      .locator('section[aria-label="Active"] [data-queue-subitem-row="true"]')
      .filter({ hasText: 'Import track alpha' })
      .first();
    const importStatus = importTrackRow.locator('[data-queue-track-status="importing"]');

    await expect(importTrackRow).toBeVisible();
    await expect(importStatus).toBeVisible();

    const [rowBox, statusBox] = await Promise.all([
      importTrackRow.boundingBox(),
      importStatus.boundingBox(),
    ]);

    expect(rowBox).not.toBeNull();
    expect(statusBox).not.toBeNull();
    expect(statusBox!.width).toBeGreaterThan(20);
    expect(statusBox!.x).toBeGreaterThan(rowBox!.x + 24);
    expect(statusBox!.x + statusBox!.width).toBeLessThan(rowBox!.x + rowBox!.width - 16);
  });
});
