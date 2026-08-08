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
      priority: 9,
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
  assert.equal(emitted.priority, 9);
});

test("deferred provider matching stamps credited artists only after a successful hydrated match", async () => {
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, library_origin, last_scanned)
    VALUES ('credited-success', 'Credited success', 'credited-success-mbid', 'musicbrainz-credit', NULL)
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, library_origin, last_scanned)
    VALUES ('credited-failure', 'Credited failure', 'credited-failure-mbid', 'musicbrainz-credit', NULL)
  `).run();

  const originalMatch = RefreshArtistService.matchArtistProviders;
  const originalRefreshStats = ArtistStatisticsService.refresh;
  (ArtistStatisticsService as any).refresh = () => undefined;

  const context = {
    updateCommandDescription: () => undefined,
    formatArtistPhaseDescription: (_job: unknown, phase: string) => phase,
  } as any;
  const makeJob = (artistId: string) => ({
    id: artistId === "credited-success" ? 51 : 52,
    name: "MatchArtistProviders",
    status: "started",
    priority: -9,
    payload: {
      artistId,
      artistName: artistId,
      artistMbid: `${artistId}-mbid`,
      shouldHydrateCatalog: true,
      metadataChanged: true,
      isNewArtist: true,
    },
  } as any);

  try {
    (RefreshArtistService as any).matchArtistProviders = async () => undefined;
    await handleMatchArtistProviders(makeJob("credited-success"), context);

    (RefreshArtistService as any).matchArtistProviders = async () => {
      throw new Error("provider match failed");
    };
    await assert.rejects(
      handleMatchArtistProviders(makeJob("credited-failure"), context),
      /provider match failed/,
    );
  } finally {
    (RefreshArtistService as any).matchArtistProviders = originalMatch;
    (ArtistStatisticsService as any).refresh = originalRefreshStats;
  }

  const success = dbModule.db.prepare(`
    SELECT last_scanned, library_origin
    FROM Artists
    WHERE id = 'credited-success'
  `).get() as { last_scanned: string | null; library_origin: string | null };
  assert.ok(success.last_scanned);
  assert.equal(success.library_origin, "musicbrainz-credit-hydrated");

  const failure = dbModule.db.prepare(`
    SELECT last_scanned, library_origin
    FROM Artists
    WHERE id = 'credited-failure'
  `).get() as { last_scanned: string | null; library_origin: string | null };
  assert.equal(failure.last_scanned, null);
  assert.equal(failure.library_origin, "musicbrainz-credit");
});

test("stored-offer-only provider matching does not re-stamp a fresh artist", async () => {
  const originalTimestamp = "2001-02-03 04:05:06";
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, library_origin, last_scanned)
    VALUES ('fresh-artist', 'Fresh artist', 'fresh-artist-mbid', 'musicbrainz-credit-hydrated', ?)
  `).run(originalTimestamp);

  const originalMatch = RefreshArtistService.matchArtistProviders;
  const originalRefreshStats = ArtistStatisticsService.refresh;
  (RefreshArtistService as any).matchArtistProviders = async () => undefined;
  (ArtistStatisticsService as any).refresh = () => undefined;

  try {
    await handleMatchArtistProviders({
      id: 53,
      name: "MatchArtistProviders",
      status: "started",
      priority: 0,
      payload: {
        artistId: "fresh-artist",
        artistName: "Fresh artist",
        artistMbid: "fresh-artist-mbid",
        shouldHydrateCatalog: false,
        metadataChanged: false,
        isNewArtist: false,
      },
    } as any, {
      updateCommandDescription: () => undefined,
      formatArtistPhaseDescription: (_job: unknown, phase: string) => phase,
    } as any);
  } finally {
    (RefreshArtistService as any).matchArtistProviders = originalMatch;
    (ArtistStatisticsService as any).refresh = originalRefreshStats;
  }

  const row = dbModule.db.prepare(`
    SELECT last_scanned, library_origin
    FROM Artists
    WHERE id = 'fresh-artist'
  `).get() as { last_scanned: string; library_origin: string };
  assert.equal(row.last_scanned, originalTimestamp);
  assert.equal(row.library_origin, "musicbrainz-credit-hydrated");
});

test("SeedVideo monitors only the requested provider offer when IDs collide", async () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES ('artist-mbid', 'Bastille')").run();
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES ('artist-local', 'Bastille', 'artist-mbid')").run();
  dbModule.db.prepare(`
    INSERT INTO Recordings (
      id, mbid, artist_mbid, title, is_video
    ) VALUES (101, 'tidal-recording', 'artist-mbid', 'Tidal video', 1),
      (102, 'apple-recording', 'artist-mbid', 'Apple video', 1)
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'video', '42', 'Tidal video'),
    ('apple-music', 'video', '42', 'Apple video')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    )
    SELECT id, 101, 'accepted', 'automatic', 1, 'test', 1
    FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'video' AND provider_id = '42'
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    )
    SELECT id, 102, 'accepted', 'automatic', 1, 'test', 1
    FROM ProviderItems
    WHERE provider = 'apple-music' AND entity_type = 'video' AND provider_id = '42'
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
    // Selected into the Video Library — that row IS the monitoring statement.
    (dbModule.db.prepare("SELECT COUNT(*) AS n FROM LibraryVideos WHERE video_recording_id = 101")
      .get() as { n: number }).n > 0 ? 1 : 0,
    1,
  );
  assert.equal(
    (dbModule.db.prepare("SELECT COUNT(*) AS n FROM LibraryVideos WHERE video_recording_id = 102")
      .get() as { n: number }).n > 0 ? 1 : 0,
    0,
  );
});

/**
 * The queued artist workflow is RefreshArtist -> MatchArtistProviders ->
 * RescanFolders -> CurateArtist. MatchArtistProviders also curated the whole
 * artist inline, so every monitored workflow curated twice; on a prolific
 * artist the redundant second pass is what overran the command lease and
 * poison-failed. It may only skip the inline pass when a CurateArtist really
 * does follow, which is a property of the workflow, not of the command.
 */
test("MatchArtistProviders defers curation exactly when the workflow queues CurateArtist", async () => {
  const originalMatch = RefreshArtistService.matchArtistProviders;
  const originalRefreshStats = ArtistStatisticsService.refresh;
  (ArtistStatisticsService as any).refresh = () => undefined;

  const seen: Array<{ workflow: string | undefined; deferCuration: unknown }> = [];
  (RefreshArtistService as any).matchArtistProviders = async (
    _artistId: string,
    _artistMbid: string | null,
    options: { deferCuration?: boolean },
  ) => {
    seen.push({ workflow: currentWorkflow, deferCuration: options.deferCuration });
  };

  let currentWorkflow: string | undefined;
  const run = async (workflow: string | undefined) => {
    currentWorkflow = workflow;
    await handleMatchArtistProviders({
      id: 70,
      name: "MatchArtistProviders",
      status: "started",
      priority: 0,
      payload: {
        artistId: "artist-defer",
        artistName: "Artist",
        artistMbid: "artist-defer-mbid",
        shouldHydrateCatalog: false,
        ...(workflow ? { workflow } : {}),
      },
    } as any, {
      updateCommandDescription: () => undefined,
      formatArtistPhaseDescription: (_job: unknown, phase: string) => phase,
    } as any);
  };

  try {
    // Curating workflows: RescanFolders -> CurateArtist follows, so one pass.
    await run("monitoring-intake");
    await run("full-monitoring");
    // Non-curating workflows: nothing follows, so this command must curate.
    await run("refresh-scan");
    await run("metadata-refresh");
    // An absent or unrecognised workflow must curate rather than silently skip.
    await run(undefined);
  } finally {
    (RefreshArtistService as any).matchArtistProviders = originalMatch;
    (ArtistStatisticsService as any).refresh = originalRefreshStats;
    appEvents.removeAllListeners();
  }

  assert.deepEqual(
    seen.map((entry) => [entry.workflow ?? "(none)", entry.deferCuration]),
    [
      ["monitoring-intake", true],
      ["full-monitoring", true],
      ["refresh-scan", false],
      ["metadata-refresh", false],
      ["(none)", false],
    ],
  );
});
