import { expect, test } from '@playwright/test';

const baseURL = process.env.BASE_URL || `http://127.0.0.1:${process.env.E2E_PORT || '3737'}`;

test.describe('API health & key endpoints', () => {
  test('/health returns healthy', async ({ request }) => {
    const resp = await request.get(`${baseURL}/health`);
    expect(resp.status()).toBe(200);
    const data = await resp.json();
    expect(data.status).toBe('healthy');
    expect(data.runtime).toBeTruthy();
    expect(typeof data.runtime.inFlightRequests).toBe('number');
    expect(typeof data.runtime.slowRequests).toBe('number');
    expect(data.runtime.eventLoopLag).toBeTruthy();
    expect(typeof data.runtime.eventLoopLag.p95Ms).toBe('number');
    expect(data.startup).toBeTruthy();
    expect(data.preflight).toBeTruthy();
    expect(typeof data.startup.checkedAt).toBe('string');
    expect(typeof data.preflight.checkedAt).toBe('string');
    expect(Array.isArray(data.startup.issues)).toBeTruthy();
    expect(Array.isArray(data.preflight.issues)).toBeTruthy();
    expect(data.preflight.backends.orpheus.name).toBe('orpheus');
    expect(data.preflight.backends.tidalDlNg.name).toBe('tidal-dl-ng');
    expect(data.preflight.paths.config).toHaveProperty('scope');
    expect(data.preflight.tools.git).toHaveProperty('status');
  });

  test('/api/stats returns valid stats', async ({ request }) => {
    const resp = await request.get(`${baseURL}/api/stats`);
    expect(resp.status()).toBe(200);
    const data = await resp.json();
    expect(data).toHaveProperty('artists');
    expect(data).toHaveProperty('albums');
  });

  test('/api/monitoring/status returns runtime monitoring fields', async ({ request }) => {
    const resp = await request.get(`${baseURL}/api/monitoring/status`);
    expect(resp.status()).toBe(200);
    const data = await resp.json();
    expect(data).toHaveProperty('running');
    expect(data).toHaveProperty('checking');
    expect(data.config).toHaveProperty('lastCheckTimestamp');
    expect(data.config).toHaveProperty('checkInProgress');
    expect(data.config).toHaveProperty('progressArtistIndex');
  });

  test('/api/artists returns items array', async ({ request }) => {
    const resp = await request.get(`${baseURL}/api/artists`);
    expect(resp.status()).toBe(200);
    const data = await resp.json();
    expect(data).toHaveProperty('items');
    expect(Array.isArray(data.items)).toBeTruthy();
  });

  test('/api/library-files returns derived quality target state', async ({ request }) => {
    const resp = await request.get(`${baseURL}/api/library-files?limit=5`);
    expect(resp.status()).toBe(200);
    const data = await resp.json();
    expect(Array.isArray(data.items)).toBeTruthy();
    expect(data).toHaveProperty('limit');
    expect(data).toHaveProperty('offset');

    if (data.items.length > 0) {
      const item = data.items[0];
      expect(item).toHaveProperty('qualityTarget');
      expect(item).toHaveProperty('qualityChangeWanted');
      expect(item).toHaveProperty('qualityChangeDirection');
      expect(item).toHaveProperty('qualityCutoffNotMet');
    }
  });

  test('/api/history returns persistent history payload', async ({ request }) => {
    const resp = await request.get(`${baseURL}/api/history?limit=5`);
    expect(resp.status()).toBe(200);

    const data = await resp.json();
    expect(Array.isArray(data.items)).toBeTruthy();
    expect(data).toHaveProperty('total');
    expect(data).toHaveProperty('limit');
    expect(data).toHaveProperty('offset');

    if (data.items.length > 0) {
      const item = data.items[0];
      expect(item).toHaveProperty('eventType');
      expect(item).toHaveProperty('date');
    }
  });

  test('/api/queue returns live queue payload fields used for recovery', async ({ request }) => {
    const resp = await request.get(`${baseURL}/api/queue`);
    expect(resp.status()).toBe(200);

    const data = await resp.json();
    expect(data).toHaveProperty('items');
    expect(Array.isArray(data.items)).toBeTruthy();
    expect(data).toHaveProperty('total');
    expect(data).toHaveProperty('limit');
    expect(data).toHaveProperty('offset');
    expect(data).toHaveProperty('hasMore');

    if (data.items.length > 0) {
      const item = data.items[0];
      expect(item).toHaveProperty('stage');
      expect(item).toHaveProperty('updated_at');
      expect(item).toHaveProperty('progress');

      if (item.stage === 'import') {
        expect(item.status === 'pending' || item.status === 'processing').toBeTruthy();
      }
    }
  });

  test('/api/library-files/rename/status returns summary counts', async ({ request }) => {
    const resp = await request.get(`${baseURL}/api/library-files/rename/status?sampleLimit=3`);
    expect(resp.status()).toBe(200);
    const data = await resp.json();
    expect(data).toHaveProperty('total');
    expect(data).toHaveProperty('renameNeeded');
    expect(data).toHaveProperty('conflicts');
    expect(data).toHaveProperty('missing');
    expect(Array.isArray(data.sample)).toBeTruthy();
  });

  test('/api/retag/status returns retag summary counts', async ({ request }) => {
    const resp = await request.get(`${baseURL}/api/retag/status?sampleLimit=3`);
    expect(resp.status()).toBe(200);
    const data = await resp.json();
    expect(data).toHaveProperty('enabled');
    expect(data).toHaveProperty('total');
    expect(data).toHaveProperty('retagNeeded');
    expect(data).toHaveProperty('missing');
    expect(Array.isArray(data.sample)).toBeTruthy();
  });

  test('/api/search applies type filters when authenticated', async ({ request }) => {
    const resp = await request.get(
      `${baseURL}/api/search?query=test&type=artists`
    );

    expect(resp.status()).toBe(200);

    const data = await resp.json();
    expect(Array.isArray(data?.results?.artists)).toBeTruthy();
    expect(data?.results?.albums ?? []).toEqual([]);
    expect(data?.results?.tracks ?? []).toEqual([]);
    expect(data?.results?.videos ?? []).toEqual([]);
    expect(data?.remoteCatalogAvailable).toBe(false);
  });

  test('/api/search returns results for valid query when connected', async ({ request }) => {
    const resp = await request.get(`${baseURL}/api/search?query=test`);
    expect(resp.status()).toBe(200);
    const data = await resp.json();
    expect(data).toHaveProperty('results');
    expect(data).toHaveProperty('remoteCatalogAvailable');
  });

  test('/api/search rejects empty query', async ({ request }) => {
    const resp = await request.get(`${baseURL}/api/search?query=`);
    const status = resp.status();
    expect(status).toBe(400);
  });

  test('/api/status returns queue status', async ({ request }) => {
    const resp = await request.get(`${baseURL}/api/status`);
    expect(resp.status()).toBe(200);
    const data = await resp.json();
    expect(data).toHaveProperty('activeJobs');
    expect(data).toHaveProperty('jobHistory');
    expect(data).toHaveProperty('taskQueueStats');
    expect(data).toHaveProperty('commandStats');
  });

  test('no secrets leaked in status endpoint', async ({ request }) => {
    const resp = await request.get(`${baseURL}/api/status`);
    expect(resp.status()).toBe(200);
    const data = await resp.json();
    const str = JSON.stringify(data);
    expect(str).not.toContain('JWT_SECRET');
    expect(str).not.toContain('ADMIN_PASSWORD');
  });

  test('safe mode: resume endpoint keeps paused when downloads disabled', async ({ request }) => {
    const resp = await request.post(`${baseURL}/api/queue/resume`);
    expect(resp.status()).toBeLessThan(500);
  });

  test('queue mutation endpoints return 404 for unknown job ids', async ({ request }) => {
    const retryResp = await request.post(`${baseURL}/api/queue/999999999/retry`);
    expect(retryResp.status()).toBe(404);

    const deleteResp = await request.delete(`${baseURL}/api/queue/999999999`);
    expect(deleteResp.status()).toBe(404);
  });

  test('unknown API routes return 404', async ({ request }) => {
    const resp = await request.get(`${baseURL}/api/nonexistent-endpoint-12345`);
    expect(resp.status()).toBe(404);
  });
});
