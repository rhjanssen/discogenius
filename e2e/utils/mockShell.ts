import type { Page } from '@playwright/test';

export const baseURL = process.env.BASE_URL || `http://127.0.0.1:${process.env.E2E_PORT || '3737'}`;

export const mockConnectedAuthStatus = {
  connected: true,
  refreshTokenExpired: false,
  tokenExpired: false,
  hoursUntilExpiry: 24,
  mode: 'live',
  canAccessShell: true,
  canAccessLocalLibrary: true,
  remoteCatalogAvailable: true,
  authBypassed: false,
  canAuthenticate: true,
  user: {
    user_id: 'mock-user',
    username: 'mock-user',
    country_code: 'NL',
  },
  message: null,
};

export const mockStatusOverview = {
  activity: {
    pending: 0,
    processing: 0,
    history: 0,
  },
  taskQueueStats: [],
  commandStats: {},
};

export const mockActivityResponse = {
  items: [],
  total: 0,
  limit: 100,
  offset: 0,
  hasMore: false,
};

export const mockQueueResponse = {
  items: [],
  total: 0,
  limit: 50,
  offset: 0,
  hasMore: false,
};

export const mockQueueHistoryResponse = {
  items: [],
  total: 0,
  limit: 12,
  offset: 0,
  hasMore: false,
};

export const mockMonitoringStatus = {
  running: false,
  checking: false,
  config: {},
};

export const mockLibraryStats = {
  artists: { total: 1, monitored: 1, downloaded: 0 },
  albums: { total: 1, monitored: 0, downloaded: 0 },
  tracks: { total: 1, monitored: 0, downloaded: 0 },
  videos: { total: 1, monitored: 0, downloaded: 0 },
};

export async function stubShellApis(
  page: Page,
  options?: {
    authStatus?: Record<string, unknown>;
    statusOverview?: Record<string, unknown>;
    activityResponse?: Record<string, unknown>;
    tasksResponse?: Record<string, unknown>;
    queueResponse?: Record<string, unknown>;
    queueHistoryResponse?: Record<string, unknown>;
    monitoringStatus?: Record<string, unknown>;
    libraryStats?: Record<string, unknown>;
  },
) {
  await page.route('**/api/app-auth/is-auth-active', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ isAuthActive: false }),
    });
  });

  await page.route('**/api/auth/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...mockConnectedAuthStatus,
        ...(options?.authStatus || {}),
      }),
    });
  });

  await page.route('**/api/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...mockStatusOverview,
        ...(options?.statusOverview || {}),
      }),
    });
  });

  await page.route('**/api/activity**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...mockActivityResponse,
        ...(options?.activityResponse || {}),
      }),
    });
  });

  await page.route('**/api/tasks**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...mockActivityResponse,
        ...(options?.tasksResponse || options?.activityResponse || {}),
      }),
    });
  });

  await page.route('**/api/queue/progress-stream**', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
      body: 'event: ready\ndata: {"items":[]}\n\n',
    });
  });

  await page.route('**/api/queue/progress-stream*', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
      body: 'event: ready\ndata: {"ok":true}\n\n',
    });
  });

  await page.route((url) => url.pathname === '/api/queue', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...mockQueueResponse,
        ...(options?.queueResponse || {}),
      }),
    });
  });

  await page.route((url) => url.pathname === '/api/queue/history', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...mockQueueHistoryResponse,
        ...(options?.queueHistoryResponse || {}),
      }),
    });
  });

  await page.route('**/api/monitoring/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...mockMonitoringStatus,
        ...(options?.monitoringStatus || {}),
      }),
    });
  });

  await page.route((url) => url.pathname === '/api/events', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
      body: 'event: ready\ndata: {"ok":true}\n\n',
    });
  });

  await page.route('**/api/stats', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...mockLibraryStats,
        ...(options?.libraryStats || {}),
      }),
    });
  });
}

export function createSearchResponse(options?: {
  artists?: Array<Record<string, unknown>>;
  albums?: Array<Record<string, unknown>>;
  tracks?: Array<Record<string, unknown>>;
  videos?: Array<Record<string, unknown>>;
}) {
  return {
    success: true,
    results: {
      artists: options?.artists || [],
      albums: options?.albums || [],
      tracks: options?.tracks || [],
      videos: options?.videos || [],
    },
    mode: 'mock',
    remoteCatalogAvailable: true,
  };
}

export async function stubArtistPage(
  page: Page,
  options: {
    artistId: string;
    artistName: string;
    monitored?: boolean;
    rows?: unknown[];
  },
) {
  await page.route(`**/api/artists/${options.artistId}/page-db`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        artist: {
          id: options.artistId,
          name: options.artistName,
          is_monitored: options.monitored ?? false,
          files: [],
        },
        rows: options.rows || [],
        album_count: Array.isArray(options.rows) ? options.rows.length : 0,
        monitored_album_count: 0,
        needs_scan: false,
      }),
    });
  });

  await page.route(`**/api/artists/${options.artistId}/activity`, async (route) => {
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

export async function stubVideoDetail(
  page: Page,
  options: {
    videoId: string;
    title: string;
    artistId: string;
    artistName: string;
  },
) {
  await page.route(`**/api/videos/${options.videoId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: options.videoId,
        title: options.title,
        artist_id: options.artistId,
        artist_name: options.artistName,
        duration: 180,
        quality: 'FHD',
        release_date: '2024-01-01',
        explicit: false,
        cover: null,
        url: null,
        is_monitored: false,
        is_downloaded: false,
      }),
    });
  });
}

