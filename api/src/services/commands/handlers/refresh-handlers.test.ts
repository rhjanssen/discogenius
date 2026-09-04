import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { enableVideoLibraryForTests } from "../../../test-support/active-schema-fixture.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-refresh-handlers-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let appEvents: typeof import("../app-events.js").appEvents;
let AppEvent: typeof import("../app-events.js").AppEvent;
let handleMatchArtistProviders: typeof import("./refresh-handlers.js").handleMatchArtistProviders;
let handleRefreshArtist: typeof import("./refresh-handlers.js").handleRefreshArtist;
let RefreshArtistService: typeof import("../../music/refresh-artist-service.js").RefreshArtistService;
let ArtistStatisticsService: typeof import("../../music/artist-statistics-service.js").ArtistStatisticsService;
let MediaSeedService: typeof import("../../music/media-seed-service.js").MediaSeedService;
let handleSeedVideo: typeof import("./refresh-handlers.js").handleSeedVideo;
let dbModule: typeof import("../../../database.js");
let CommandNames: typeof import("../command-names.js").CommandNames;

before(async () => {
  dbModule = await import("../../../database.js");
  dbModule.initDatabase();
  enableVideoLibraryForTests(dbModule.db);
  ({ appEvents, AppEvent } = await import("../app-events.js"));
  ({ handleMatchArtistProviders, handleRefreshArtist, handleSeedVideo } = await import("./refresh-handlers.js"));
  ({ CommandNames } = await import("../command-names.js"));
  ({ RefreshArtistService } = await import("../../music/refresh-artist-service.js"));
  ({ ArtistStatisticsService } = await import("../../music/artist-statistics-service.js"));
  ({ MediaSeedService } = await import("../../music/media-seed-service.js"));
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM LibraryArtists").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
  dbModule.db.prepare("DELETE FROM commands").run();
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
  const { seedLibraryArtistMonitoring } = await import("../../../test-support/active-schema-fixture.js");
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES
      ('credited-success-mbid', 'Credited success'),
      ('credited-failure-mbid', 'Credited failure')
  `).run();
  seedLibraryArtistMonitoring(dbModule.db, "credited-success-mbid");
  seedLibraryArtistMonitoring(dbModule.db, "credited-failure-mbid");
  dbModule.db.prepare(`
    UPDATE LibraryArtists SET library_origin = 'musicbrainz-credit', metadata_last_checked_at = NULL
    WHERE artist_metadata_id IN (
      SELECT id FROM ArtistMetadata WHERE mbid IN ('credited-success-mbid', 'credited-failure-mbid')
    )
  `).run();

  const originalMatch = RefreshArtistService.matchArtistProviders;
  const originalRefreshStats = ArtistStatisticsService.refresh;
  (ArtistStatisticsService as any).refresh = () => undefined;

  const context = {
    updateCommandDescription: () => undefined,
    formatArtistPhaseDescription: (_job: unknown, phase: string) => phase,
  } as any;
  const makeJob = (artistKey: string) => ({
    id: artistKey === "credited-success" ? 51 : 52,
    name: "MatchArtistProviders",
    status: "started",
    priority: -9,
    payload: {
      artistId: `${artistKey}-mbid`,
      artistName: artistKey,
      artistMbid: `${artistKey}-mbid`,
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
    SELECT membership.metadata_last_checked_at AS last_scanned, membership.library_origin
    FROM LibraryArtists membership
    JOIN ArtistMetadata metadata ON metadata.id = membership.artist_metadata_id
    WHERE metadata.mbid = 'credited-success-mbid'
    LIMIT 1
  `).get() as { last_scanned: string | null; library_origin: string | null };
  assert.ok(success.last_scanned);
  assert.equal(success.library_origin, "musicbrainz-credit-hydrated");

  const failure = dbModule.db.prepare(`
    SELECT membership.metadata_last_checked_at AS last_scanned, membership.library_origin
    FROM LibraryArtists membership
    JOIN ArtistMetadata metadata ON metadata.id = membership.artist_metadata_id
    WHERE metadata.mbid = 'credited-failure-mbid'
    LIMIT 1
  `).get() as { last_scanned: string | null; library_origin: string | null };
  assert.equal(failure.last_scanned, null);
  assert.equal(failure.library_origin, "musicbrainz-credit");
});

test("a recurring artist refresh catalogues new collaborators in-process without queue fan-out", async () => {
  const { seedLibraryArtistMonitoring } = await import("../../../test-support/active-schema-fixture.js");
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name, content_hash) VALUES
      ('selected-artist-mbid', 'Selected artist', 'selected-hydrated'),
      ('new-credit-mbid', 'New collaborator', NULL),
      ('known-credit-mbid', 'Known collaborator', 'already-hydrated')
  `).run();
  seedLibraryArtistMonitoring(dbModule.db, "selected-artist-mbid");

  const originalRefresh = RefreshArtistService.refreshArtist;
  const originalRefreshStats = ArtistStatisticsService.refresh;
  const refreshedIds: string[] = [];
  (RefreshArtistService as any).refreshArtist = async (artistId: string) => {
    refreshedIds.push(artistId);
    if (artistId === "selected-artist-mbid") {
      return {
        artistMbid: "selected-artist-mbid",
        shouldHydrateCatalog: true,
        metadataChanged: true,
        isNewArtist: false,
        creditedArtistMbids: ["new-credit-mbid", "known-credit-mbid", "new-credit-mbid"],
      };
    }
    return {
      artistMbid: artistId,
      shouldHydrateCatalog: true,
      metadataChanged: true,
      isNewArtist: true,
      creditedArtistMbids: [],
    };
  };
  (ArtistStatisticsService as any).refresh = () => undefined;

  try {
    await handleRefreshArtist({
      id: 60,
      name: "RefreshArtist",
      status: "started",
      priority: 3,
      trigger: 2,
      payload: {
        artistId: "selected-artist-mbid",
        artistName: "Selected artist",
        workflow: "refresh-scan",
        monitorArtist: false,
        hydrateCatalog: true,
        hydrateAlbumTracks: false,
        scanLibrary: true,
        forceUpdate: false,
      },
    } as any, {
      updateCommandDescription: () => undefined,
      formatArtistPhaseDescription: (_job: unknown, phase: string) => phase,
      yieldToEventLoop: async () => undefined,
    } as any);
  } finally {
    (RefreshArtistService as any).refreshArtist = originalRefresh;
    (ArtistStatisticsService as any).refresh = originalRefreshStats;
  }

  assert.deepEqual(refreshedIds, ["selected-artist-mbid", "new-credit-mbid"]);

  const childRefreshes = dbModule.db.prepare(`
    SELECT COUNT(*) AS count
    FROM commands
    WHERE name = ? AND ref_id IN ('new-credit-mbid', 'known-credit-mbid')
  `).get(CommandNames.RefreshArtist) as { count: number };
  assert.equal(childRefreshes.count, 0);

  const matchJobs = dbModule.db.prepare(`
    SELECT ref_id
    FROM commands
    WHERE name = ?
    ORDER BY id
  `).all(CommandNames.MatchArtistProviders) as Array<{ ref_id: string }>;
  assert.equal(matchJobs.length, 0);
});

test("a credited-artist background fill cannot recursively expand", async () => {
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name, content_hash)
    VALUES ('second-hop-mbid', 'Second hop', NULL)
  `).run();

  const originalRefresh = RefreshArtistService.refreshArtist;
  const originalRefreshStats = ArtistStatisticsService.refresh;
  (RefreshArtistService as any).refreshArtist = async () => ({
    artistMbid: "first-hop-mbid",
    shouldHydrateCatalog: true,
    metadataChanged: true,
    isNewArtist: true,
    creditedArtistMbids: ["second-hop-mbid"],
  });
  (ArtistStatisticsService as any).refresh = () => undefined;

  try {
    await handleRefreshArtist({
      id: 61,
      name: "RefreshArtist",
      status: "started",
      priority: -10,
      payload: {
        artistId: "first-hop-mbid",
        artistName: "First hop",
        workflow: "metadata-refresh",
        monitorArtist: false,
        hydrateCatalog: true,
        hydrateAlbumTracks: false,
        scanLibrary: false,
        forceUpdate: false,
      },
    } as any, {
      updateCommandDescription: () => undefined,
      formatArtistPhaseDescription: (_job: unknown, phase: string) => phase,
      yieldToEventLoop: async () => undefined,
    } as any);
  } finally {
    (RefreshArtistService as any).refreshArtist = originalRefresh;
    (ArtistStatisticsService as any).refresh = originalRefreshStats;
  }

  const queuedSecondHop = dbModule.db.prepare(`
    SELECT COUNT(*) AS count
    FROM commands
    WHERE name = ? AND ref_id = 'second-hop-mbid'
  `).get(CommandNames.RefreshArtist) as { count: number };
  assert.equal(queuedSecondHop.count, 0);
});

test("stored-offer-only provider matching does not re-stamp a fresh artist", async () => {
  const { seedLibraryArtistMonitoring } = await import("../../../test-support/active-schema-fixture.js");
  const originalTimestamp = "2001-02-03 04:05:06";
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES ('fresh-artist-mbid', 'Fresh artist')
  `).run();
  seedLibraryArtistMonitoring(dbModule.db, "fresh-artist-mbid");
  dbModule.db.prepare(`
    UPDATE LibraryArtists
    SET library_origin = 'musicbrainz-credit-hydrated',
        metadata_last_checked_at = ?
    WHERE artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = 'fresh-artist-mbid')
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
        artistId: "fresh-artist-mbid",
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
    SELECT membership.metadata_last_checked_at AS last_scanned, membership.library_origin
    FROM LibraryArtists membership
    JOIN ArtistMetadata metadata ON metadata.id = membership.artist_metadata_id
    WHERE metadata.mbid = 'fresh-artist-mbid'
    LIMIT 1
  `).get() as { last_scanned: string; library_origin: string };
  assert.equal(row.last_scanned, originalTimestamp);
  assert.equal(row.library_origin, "musicbrainz-credit-hydrated");
});

test("SeedVideo monitors only the requested provider offer when IDs collide", async () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES ('artist-mbid', 'Bastille')").run();
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

test("MatchArtistProviders never carries an inline curation policy", async () => {
  const originalMatch = RefreshArtistService.matchArtistProviders;
  const originalRefreshStats = ArtistStatisticsService.refresh;
  (ArtistStatisticsService as any).refresh = () => undefined;

  const seen: Array<{ workflow: string | undefined; hasDeferCuration: boolean }> = [];
  (RefreshArtistService as any).matchArtistProviders = async (
    _artistId: string,
    _artistMbid: string | null,
    options: Record<string, unknown>,
  ) => {
    seen.push({ workflow: currentWorkflow, hasDeferCuration: "deferCuration" in options });
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
    await run("monitoring-intake");
    await run("full-monitoring");
    await run("refresh-scan");
    await run("metadata-refresh");
    await run(undefined);
  } finally {
    (RefreshArtistService as any).matchArtistProviders = originalMatch;
    (ArtistStatisticsService as any).refresh = originalRefreshStats;
    appEvents.removeAllListeners();
  }

  assert.deepEqual(
    seen.map((entry) => [entry.workflow ?? "(none)", entry.hasDeferCuration]),
    [
      ["monitoring-intake", false],
      ["full-monitoring", false],
      ["refresh-scan", false],
      ["metadata-refresh", false],
      ["(none)", false],
    ],
  );
});

test("MatchArtistProviders never folds rename or retag into refresh", async () => {
  const originalMatch = RefreshArtistService.matchArtistProviders;
  const originalRefreshStats = ArtistStatisticsService.refresh;
  (RefreshArtistService as any).matchArtistProviders = async () => undefined;
  (ArtistStatisticsService as any).refresh = () => undefined;

  const context = {
    updateCommandDescription: () => undefined,
    formatArtistPhaseDescription: (_job: unknown, phase: string) => phase,
  } as any;
  const job = {
    id: 81,
    name: "MatchArtistProviders",
    status: "started",
    priority: 0,
    payload: {
      artistId: "artist-sync",
      artistName: "Bastille",
      artistMbid: "artist-sync-mbid",
      shouldHydrateCatalog: false,
      metadataChanged: true,
      isNewArtist: false,
    },
  } as any;

  try {
    await handleMatchArtistProviders(job, context);
    const queued = dbModule.db.prepare(`
      SELECT name FROM commands
      WHERE name IN (?, ?, ?, ?)
    `).all(
      CommandNames.RenameArtist,
      CommandNames.RenameFiles,
      CommandNames.RetagArtist,
      CommandNames.RetagFiles,
    ) as Array<{ name: string }>;
    assert.deepEqual(queued, []);
  } finally {
    (RefreshArtistService as any).matchArtistProviders = originalMatch;
    (ArtistStatisticsService as any).refresh = originalRefreshStats;
  }
});
