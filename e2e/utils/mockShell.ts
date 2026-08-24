import type { Page } from '@playwright/test';

export const baseURL = process.env.BASE_URL || `http://127.0.0.1:${process.env.E2E_PORT || '3737'}`;

export const mockConnectedAuthStatus = {
  connected: true,
  refreshTokenExpired: false,
  tokenExpired: false,
  hoursUntilExpiry: 24,
  canAccessShell: true,
  canAccessLocalLibrary: true,
  remoteCatalogAvailable: true,
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
    queued: 0,
    started: 0,
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

export const mockQueueStatus = {
  isPaused: false,
  processing: false,
  stats: [],
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
    tasksResponse?: unknown[];
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

  await page.route('**/api/v1/status', async (route) => {
    const overrides = options?.statusOverview || {};
    const activity = (overrides.activity || mockStatusOverview.activity) as Record<string, unknown>;
    const commandStats = (overrides.commandStats || mockStatusOverview.commandStats) as Record<string, unknown>;
    const normalizedCommandStats = Object.fromEntries(Object.entries(commandStats).map(([key, rawBucket]) => {
      const bucket = rawBucket && typeof rawBucket === 'object' ? rawBucket as Record<string, unknown> : {};
      return [key, {
        queued: bucket.queued ?? bucket.pending,
        started: bucket.started ?? bucket.processing,
        failed: bucket.failed,
      }];
    }));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...mockStatusOverview,
        ...overrides,
        activity: {
          queued: activity.queued ?? activity.pending ?? 0,
          started: activity.started ?? activity.processing ?? 0,
          history: activity.history ?? 0,
        },
        commandStats: normalizedCommandStats,
      }),
    });
  });

  await page.route('**/api/v1/history/activity**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...mockActivityResponse,
        ...(options?.activityResponse || {}),
      }),
    });
  });

  await page.route('**/api/v1/system/task**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(options?.tasksResponse || []),
    });
  });

  await page.route('**/api/v1/queue/progress-stream**', async (route) => {
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

  await page.route('**/api/v1/queue/progress-stream*', async (route) => {
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

  await page.route((url) => url.pathname === '/api/v1/queue', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...mockQueueResponse,
        ...(options?.queueResponse || {}),
      }),
    });
  });

  await page.route((url) => url.pathname === '/api/v1/queue/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockQueueStatus),
    });
  });

  await page.route((url) => url.pathname === '/api/v1/queue/details', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  await page.route((url) => url.pathname === '/api/v1/queue/history', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...mockQueueHistoryResponse,
        ...(options?.queueHistoryResponse || {}),
      }),
    });
  });

  await page.route('**/api/v1/monitoring/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...mockMonitoringStatus,
        ...(options?.monitoringStatus || {}),
      }),
    });
  });

  await page.route((url) => url.pathname === '/api/v1/events', async (route) => {
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

  await page.route('**/api/v1/stats', async (route) => {
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
    rowsBySection?: Partial<Record<'albums' | 'tracks' | 'videos', unknown[]>>;
  },
) {
  await page.route((url) => url.pathname === `/api/v1/artist/${options.artistId}/page`, async (route) => {
    const section = new URL(route.request().url()).searchParams.get('section') || 'all';
    const sectionRows = section === 'identity'
      ? []
      : options.rowsBySection?.[section as 'albums' | 'tracks' | 'videos']
        ?? (section === 'albums' ? options.rows : undefined)
        ?? [];

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        artist: {
          id: options.artistId,
          name: options.artistName,
          is_monitored: options.monitored ?? false,
          policy: options.monitored ? 'all' : null,
          memberships: [],
          picture: null,
          cover_image_url: null,
          last_scanned: null,
          files: [],
        },
        rows: sectionRows,
        album_count: Array.isArray(options.rowsBySection?.albums)
          ? options.rowsBySection.albums.length
          : Array.isArray(options.rows) ? options.rows.length : 0,
        monitored_album_count: 0,
        needs_scan: false,
      }),
    });
  });

  await page.route('**/api/v1/artist/libraries', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  await page.route(`**/api/v1/artist/${options.artistId}/activity`, async (route) => {
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
  await page.route(`**/api/v1/video/${options.videoId}`, async (route) => {
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
        downloaded: false,
      }),
    });
  });
}

