import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { prepareActiveSchemaEnv, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";

const { tempDir } = prepareActiveSchemaEnv("tidal-session-hold");
const dbModule = await import("../../database.js");
dbModule.initDatabase();

const { DownloadWaitQueue } = await import("./download-wait-queue.js");
const { DownloadProcessor } = await import("./download-processor.js");
const { downloadBackendRegistry } = await import("./download-backend.js");
const { streamingProviderManager } = await import("../providers/index.js");
const { CommandQueueManager } = await import("../commands/command-queue-manager.js");
const auth = await import("../providers/provider-auth-state.js");
const { errorIndicatesProviderAuth, asProviderAuthError, ProviderAuthError, TIDAL_SESSION_WAIT_MESSAGE } = await import("../providers/provider-auth-error.js");
const {
  TidalSessionUnavailableError,
  prepareTidalTokenForDownloader,
  saveStoredTidalToken,
  clearStoredTidalToken,
  TIDAL_AUTH_TOKEN_FILE,
  resetTidalRefreshBackoffForTests,
} = await import("../providers/tidal/tidal-auth.js");

const originalTiddl = downloadBackendRegistry.get("tiddl");
const originalDeezer = downloadBackendRegistry.get("streamrip-deezer");

after(() => {
  if (originalTiddl) downloadBackendRegistry.register(originalTiddl);
  if (originalDeezer) downloadBackendRegistry.register(originalDeezer);
  clearStoredTidalToken();
  closeActiveSchemaDb(dbModule, tempDir);
});

function registerStreamingProvider(id: string): void {
  if ([...streamingProviderManager.getAllStreamingProviders()].some((p) => p.id === id)) return;
  streamingProviderManager.registerStreamingProvider({
    id,
    name: id,
    capabilities: {},
  } as never);
}

test("TidalSessionUnavailableError inherits from ProviderAuthError and is classified as auth wait", () => {
  const typedError = new TidalSessionUnavailableError();
  assert.equal(typedError instanceof ProviderAuthError, true);
  assert.equal(typedError instanceof Error, true);
  assert.equal(typedError.name, "TidalSessionUnavailableError");
  assert.equal(typedError.status, 401);
  assert.equal(typedError.provider, "tidal");
  assert.equal(typedError.code, "session_unavailable");

  assert.equal(errorIndicatesProviderAuth(typedError), true);
  assert.equal(
    errorIndicatesProviderAuth(new Error(TIDAL_SESSION_WAIT_MESSAGE)),
    true,
  );

  const fromTyped = asProviderAuthError("tidal", typedError);
  assert.ok(fromTyped);
  assert.equal(fromTyped.provider, "tidal");
  assert.equal(fromTyped.message, TIDAL_SESSION_WAIT_MESSAGE);

  const fromPlain = asProviderAuthError("tidal", new Error(TIDAL_SESSION_WAIT_MESSAGE));
  assert.ok(fromPlain);
  assert.equal(fromPlain.provider, "tidal");

  const copy = auth.providerAuthCopy("tidal", TIDAL_SESSION_WAIT_MESSAGE);
  assert.equal(copy.queueMessage, "Waiting for Tidal token refresh");
  assert.equal(copy.banner, TIDAL_SESSION_WAIT_MESSAGE);
});

test("prepareTidalTokenForDownloader throws TidalSessionUnavailableError when token is within handoff margin", async () => {
  resetTidalRefreshBackoffForTests();
  const tokenDir = path.dirname(TIDAL_AUTH_TOKEN_FILE);
  fs.mkdirSync(tokenDir, { recursive: true });

  fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify({
    access_token: "expiring-token",
    refresh_token: "test-refresh-token",
    expires_at: Math.floor(Date.now() / 1000) + 180,
  }));

  fs.writeFileSync(path.join(tokenDir, "refresh-pause.json"), JSON.stringify({
    until: new Date(Date.now() + 30 * 60_000).toISOString(),
  }));

  try {
    await assert.rejects(
      prepareTidalTokenForDownloader(),
      (error: unknown) => error instanceof TidalSessionUnavailableError && error instanceof ProviderAuthError,
    );
  } finally {
    fs.rmSync(path.join(tokenDir, "refresh-pause.json"), { force: true });
  }
});

test("a TIDAL album job whose token is inside the handoff margin ends queued or waiting on TIDAL with no fallback offer chosen, and resumes once refreshed", async () => {
  registerStreamingProvider("tidal");
  registerStreamingProvider("deezer");

  dbModule.db.prepare("INSERT OR IGNORE INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-1', 'Test Artist')").run();
  dbModule.db.prepare("INSERT OR IGNORE INTO Albums (id, mbid, title, artist_mbid, primary_type) VALUES (1, 'rg-1', 'Test Album', 'artist-1', 'album')").run();
  dbModule.db.prepare(`
    INSERT OR IGNORE INTO AlbumEditions (id, mbid, release_group_id, title, release_group_mbid, artist_mbid, date, track_count)
    VALUES (1, 'release-1', 1, 'Test Album', 'rg-1', 'artist-1', '2024-01-01', 1)
  `).run();
  dbModule.db.prepare(`
    INSERT OR IGNORE INTO Recordings (id, mbid, artist_mbid, title, length_ms, is_video, metadata_status)
    VALUES (1, 'rec-1', 'artist-1', 'Track 1', 180000, 0, 'complete')
  `).run();
  dbModule.db.prepare(`
    INSERT OR IGNORE INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title, release_mbid, recording_mbid)
    VALUES (1, 'track-1', 1, 1, 1, 1, 'Track 1', 'release-1', 'rec-1')
  `).run();

  dbModule.db.prepare(`
    INSERT OR REPLACE INTO ProviderItems (id, provider, entity_type, provider_id, title, availability)
    VALUES (101, 'tidal', 'release', 'tidal-album-1', 'Test Album', 'available')
  `).run();
  dbModule.db.prepare(`
    INSERT OR REPLACE INTO ProviderEditionMatches (
      id, provider_edition_item_id, edition_id, relation, match_state, decision_source, confidence, method, matcher_version
    ) VALUES (101, 101, 1, 'exact', 'accepted', 'automatic', 0.99, 'fixture', 5)
  `).run();
  dbModule.db.prepare(`
    INSERT OR REPLACE INTO ProviderItemAudioVariants (id, provider_item_id, variant_key, quality_class, availability)
    VALUES (101, 101, 'lossless', 'lossless', 'available')
  `).run();

  dbModule.db.prepare(`
    INSERT OR REPLACE INTO ProviderItems (id, provider, entity_type, provider_id, title, availability)
    VALUES (201, 'deezer', 'release', 'deezer-album-1', 'Test Album', 'available')
  `).run();
  dbModule.db.prepare(`
    INSERT OR REPLACE INTO ProviderEditionMatches (
      id, provider_edition_item_id, edition_id, relation, match_state, decision_source, confidence, method, matcher_version
    ) VALUES (201, 201, 1, 'exact', 'accepted', 'automatic', 0.95, 'fixture', 5)
  `).run();
  dbModule.db.prepare(`
    INSERT OR REPLACE INTO ProviderItemAudioVariants (id, provider_item_id, variant_key, quality_class, availability)
    VALUES (201, 201, 'lossless', 'lossless', 'available')
  `).run();

  let deezerCalled = false;
  let tidalDownloadAttempts = 0;

  downloadBackendRegistry.register({
    id: "tiddl",
    supportedProviders: ["tidal"],
    capabilities: ["stereo"],
    async preflight() {},
    async download(request) {
      tidalDownloadAttempts++;
      await prepareTidalTokenForDownloader();
      fs.mkdirSync(request.downloadPath, { recursive: true });
      fs.writeFileSync(path.join(request.downloadPath, "track-1.flac"), "dummy audio content");
    },
  });

  downloadBackendRegistry.register({
    id: "streamrip-deezer",
    supportedProviders: ["deezer"],
    capabilities: ["stereo"],
    async preflight() {},
    async download() {
      deezerCalled = true;
    },
  });

  resetTidalRefreshBackoffForTests();
  const tokenDir = path.dirname(TIDAL_AUTH_TOKEN_FILE);
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify({
    access_token: "expiring-token",
    refresh_token: "refresh-token",
    expires_at: Math.floor(Date.now() / 1000) + 180,
  }));
  fs.writeFileSync(path.join(tokenDir, "refresh-pause.json"), JSON.stringify({
    until: new Date(Date.now() + 30 * 60_000).toISOString(),
  }));

  let processor: any;
  try {
    const queued = DownloadWaitQueue.enqueue({
      refKey: "tidal-album-1",
      mediaKind: "album",
      commandName: "DownloadAlbum",
      provider: "tidal",
      providerId: "tidal-album-1",
      title: "Test Album",
      artist: "Test Artist",
      payload: {
        provider: "tidal",
        providerId: "tidal-album-1",
        title: "Test Album",
        type: "album",
        releaseGroupMbid: "rg-1",
        slot: "stereo",
      },
      position: "back",
      notify: false,
    });

    const claimed = DownloadWaitQueue.claimNextPage();
    assert.ok(claimed.claimed);
    assert.equal(claimed.claimed.wait.id, queued.id);
    const commandId = claimed.claimed.commandId;
    const job = CommandQueueManager.get(commandId);
    assert.ok(job);

    processor = new DownloadProcessor() as any;
    processor.scheduleNext = () => {};
    await processor.dispatchDownloadPhase(job);

    assert.equal(tidalDownloadAttempts, 1);
    assert.equal(deezerCalled, false, "Must not take cross-provider fallback to Deezer when TIDAL session is waiting for token refresh");

    const failedCommands = (dbModule.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE status = 'failed'").get() as { n: number }).n;
    assert.equal(failedCommands, 0, "Job must not be marked failed");

    const runningCmd = dbModule.db.prepare("SELECT id FROM commands WHERE id = ?").get(commandId);
    assert.equal(runningCmd, undefined, "Started command should be released");

    const waitRow = dbModule.db.prepare("SELECT command_id, provider, payload FROM DownloadQueue WHERE id = ?").get(queued.id) as {
      command_id: number | null;
      provider: string;
      payload: string;
    };
    assert.equal(waitRow.command_id, null, "DownloadQueue row must be waiting (command_id is null)");
    assert.equal(waitRow.provider, "tidal", "Must remain on TIDAL provider");

    const payload = JSON.parse(waitRow.payload);
    assert.equal(payload.provider, "tidal", "Payload provider must remain tidal");
    assert.equal(payload.authHold?.provider, "tidal");
    assert.equal(payload.authHold?.message, "Waiting for Tidal token refresh");
    assert.equal(auth.providerNeedsReauth("tidal"), true);

    assert.equal(DownloadWaitQueue.claimNextPage().claimed, null);

    fs.rmSync(path.join(tokenDir, "refresh-pause.json"), { force: true });
    await saveStoredTidalToken({
      access_token: "fresh-access-token",
      refresh_token: "fresh-refresh-token",
      expires_at: Math.floor(Date.now() / 1000) + 14_400,
    });

    assert.equal(auth.providerNeedsReauth("tidal"), false);
    const waitRowAfterFresh = dbModule.db.prepare("SELECT command_id, payload FROM DownloadQueue WHERE id = ?").get(queued.id) as {
      command_id: number | null;
      payload: string;
    };
    assert.equal(JSON.parse(waitRowAfterFresh.payload).authHold, undefined, "authHold should be cleared after fresh token is saved");

    const resumed = DownloadWaitQueue.claimNextPage();
    assert.ok(resumed.claimed);
    assert.equal(resumed.claimed.wait.id, queued.id);
    assert.equal(resumed.claimed.wait.provider, "tidal");

    const nextJob = CommandQueueManager.get(resumed.claimed.commandId);
    assert.ok(nextJob);

    await processor.dispatchDownloadPhase(nextJob);

    assert.equal(tidalDownloadAttempts, 2, "Second attempt must download on TIDAL");
    assert.equal(deezerCalled, false, "Deezer must still never have been called");
  } finally {
    fs.rmSync(path.join(tokenDir, "refresh-pause.json"), { force: true });
    if (processor?.progressFlushTimer) {
      clearInterval(processor.progressFlushTimer);
    }
    processor?.progressBuffer?.clear();
  }
});
