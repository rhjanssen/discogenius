import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-refresh-handlers-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let appEvents: typeof import("../app-events.js").appEvents;
let AppEvent: typeof import("../app-events.js").AppEvent;
let handleMatchArtistProviders: typeof import("./refresh-handlers.js").handleMatchArtistProviders;
let RefreshArtistService: typeof import("../../music/refresh-artist-service.js").RefreshArtistService;
let ArtistStatisticsService: typeof import("../../music/artist-statistics-service.js").ArtistStatisticsService;

before(async () => {
  ({ appEvents, AppEvent } = await import("../app-events.js"));
  ({ handleMatchArtistProviders } = await import("./refresh-handlers.js"));
  ({ RefreshArtistService } = await import("../../music/refresh-artist-service.js"));
  ({ ArtistStatisticsService } = await import("../../music/artist-statistics-service.js"));
});

after(() => {
  appEvents.removeAllListeners();
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
