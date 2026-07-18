import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-refresh-handlers-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let appEvents: typeof import("../app-events.js").appEvents;
let AppEvent: typeof import("../app-events.js").AppEvent;
let handleMatchArtistProviders: typeof import("./refresh-handlers.js").handleMatchArtistProviders;
let RefreshArtistService: typeof import("../../music/refresh-artist-service.js").RefreshArtistService;
let ArtistStatisticsService: typeof import("../../music/artist-statistics-service.js").ArtistStatisticsService;
let MediaSeedService: typeof import("../../music/media-seed-service.js").MediaSeedService;
let handleSeedVideo: typeof import("./refresh-handlers.js").handleSeedVideo;
let dbModule: typeof import("../../../database.js");

before(async () => {
  dbModule = await import("../../../database.js");
  dbModule.initDatabase();
  ({ appEvents, AppEvent } = await import("../app-events.js"));
  ({ handleMatchArtistProviders, handleSeedVideo } = await import("./refresh-handlers.js"));
  ({ RefreshArtistService } = await import("../../music/refresh-artist-service.js"));
  ({ ArtistStatisticsService } = await import("../../music/artist-statistics-service.js"));
  ({ MediaSeedService } = await import("../../music/media-seed-service.js"));
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
  dbModule.db.prepare("DELETE FROM Artists").run();
});

after(() => {
  appEvents.removeAllListeners();
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("provider-match completion preserves monitoring-cycle context", async () => {
  const originalMatch = RefreshArtistService.matchArtistProviders;
  const originalRefreshStats = ArtistStatisticsService.refresh;
  let emitted: Record<string, unknown> | undefined;

  (RefreshArtistService as any).matchArtistProviders = async () => undefined;
  (ArtistStatisticsService as any).refresh = () => undefined;
  appEvents.once(AppEvent.ARTIST_REFRESH_COMPLETE, (payload) => {
    emitted = payload as unknown as Record<string, unknown>;
  });

  try {
    await handleMatchArtistProviders({
      id: 42,
      name: "MatchArtistProviders",
      status: "started",
      trigger: 2,
      payload: {
        artistId: "artist-1",
        artistName: "Bastille",
        artistMbid: "artist-mbid-1",
        shouldHydrateCatalog: true,
        metadataChanged: false,
        isNewArtist: false,
        workflow: "monitoring-intake",
        scanLibrary: true,
        monitoringCycle: "full-cycle",
      },
    } as any, {
      updateCommandDescription: () => undefined,
      formatArtistPhaseDescription: (_job: unknown, phase: string) => phase,
    } as any);
  } finally {
    (RefreshArtistService as any).matchArtistProviders = originalMatch;
    (ArtistStatisticsService as any).refresh = originalRefreshStats;
  }

  assert.ok(emitted);
  assert.equal(emitted.monitoringCycle, "full-cycle");
  assert.equal(emitted.artistId, "artist-1");
});

test("SeedVideo monitors only the requested provider offer when IDs collide", async () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES ('artist-mbid', 'Bastille')").run();
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES ('artist-local', 'Bastille', 'artist-mbid')").run();
  dbModule.db.prepare(`
    INSERT INTO Recordings (id, mbid, artist_mbid, title, is_video, monitored)
    VALUES
      (101, 'tidal-recording', 'artist-mbid', 'Tidal video', 1, 0),
      (102, 'apple-recording', 'artist-mbid', 'Apple video', 1, 0)
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, recording_id, recording_mbid, title)
    VALUES
      ('tidal', 'video', '42', 101, 'tidal-recording', 'Tidal video'),
      ('apple-music', 'video', '42', 102, 'apple-recording', 'Apple video')
  `).run();

  const originalSeedVideo = MediaSeedService.seedVideo;
  let receivedProvider: string | undefined;
  (MediaSeedService as any).seedVideo = async (_providerId: string, options: { provider?: string }) => {
    receivedProvider = options.provider;
  };

  try {
    await handleSeedVideo({
      id: 7,
      name: "SeedVideo",
      status: "started",
      payload: {
        providerId: "42",
        provider: "tidal",
        monitorArtist: true,
        monitorVideo: true,
      },
    } as any, {
      updateCommandDescription: () => undefined,
    } as any);
  } finally {
    (MediaSeedService as any).seedVideo = originalSeedVideo;
  }

  assert.equal(receivedProvider, "tidal");
  assert.equal(
    (dbModule.db.prepare("SELECT monitored FROM Recordings WHERE id = 101").get() as { monitored: number }).monitored,
    1,
  );
  assert.equal(
    (dbModule.db.prepare("SELECT monitored FROM Recordings WHERE id = 102").get() as { monitored: number }).monitored,
    0,
  );
});
