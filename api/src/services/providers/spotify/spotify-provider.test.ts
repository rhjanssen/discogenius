import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type {
  SpotifyAuthStore,
  SpotifyCredentialInput,
  SpotifyCredentials,
} from "./spotify-auth.js";
import { FileSpotifyAuthStore, looksLikeNetscapeCookies } from "./spotify-auth.js";
import {
  SPOTIFY_TOKEN_URL,
  SpotifyApi,
  SpotifyApiError,
  type SpotifyFetchLike,
} from "./spotify-api.js";
import { SpotifyCatalog } from "./spotify-catalog.js";
import { SPOTIFY_FIXTURE_IDS, recordedSpotifyFixture } from "./spotify-fixtures.js";
import { SpotifyProvider } from "./spotify-provider.js";
import { spotifyQualityMapping } from "./spotify-quality.js";
import {
  VOTIFY_PIP_REQUIREMENT,
  VotifyBackend,
  parseVotifyProgressLine,
  resolveVotifyAudioQuality,
  type VotifyRunRequest,
} from "./votify-backend.js";

class MemoryAuthStore implements SpotifyAuthStore {
  constructor(public credentials: SpotifyCredentials | null) {}

  load(): SpotifyCredentials | null {
    return this.credentials;
  }

  save(input: SpotifyCredentialInput): SpotifyCredentials {
    const clientId = String(input.clientId ?? "").trim();
    const clientSecret = String(input.clientSecret ?? "").trim();
    this.credentials = { clientId, clientSecret, cookiesPath: String(input.cookiesPath ?? "") || null };
    return this.credentials;
  }

  clear(): void {
    this.credentials = null;
  }
}

function response(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    async json() { return payload; },
  };
}

function fixtureApi(calls: Array<{ url: string; init?: Parameters<SpotifyFetchLike>[1] }> = []) {
  const authStore = new MemoryAuthStore({ clientId: "fixture-id", clientSecret: "fixture-secret" });
  const fetchImpl: SpotifyFetchLike = async (url, init) => {
    calls.push({ url, init });
    return response(recordedSpotifyFixture(url));
  };
  return new SpotifyApi({ authStore, fetchImpl, now: () => 1_000_000 });
}

test("file auth store persists catalog credentials and provider-owned Netscape cookies", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-spotify-auth-"));
  const store = new FileSpotifyAuthStore(tempDir);
  const cookies = "# Netscape HTTP Cookie File\n.spotify.com\tTRUE\t/\tTRUE\t2147483647\tsp_dc\tsecret";
  const saved = store.save({ clientId: "client", clientSecret: "secret", cookiesText: cookies });

  assert.equal(saved.cookiesPath, path.join(tempDir, "cookies.txt"));
  assert.equal(store.load()?.clientId, "client");
  assert.match(fs.readFileSync(path.join(tempDir, "cookies.txt"), "utf8"), /sp_dc/);
  const serialized = fs.readFileSync(path.join(tempDir, "credentials.json"), "utf8");
  assert.doesNotMatch(serialized, /sp_dc/);
  assert.match(serialized, /"cookiesPath": "cookies.txt"/);

  store.clear();
  assert.equal(store.load(), null);
  assert.equal(fs.existsSync(path.join(tempDir, "cookies.txt")), false);
});

test("file auth store supports an externally mounted cookies path and rejects non-Netscape text", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-spotify-auth-"));
  const store = new FileSpotifyAuthStore(tempDir);
  const external = path.join(tempDir, "mounted-cookies.txt");
  const saved = store.save({ clientId: "client", clientSecret: "secret", cookiesPath: external });
  assert.equal(saved.cookiesPath, external);
  assert.equal(store.load()?.cookiesPath, external);
  assert.throws(
    () => store.save({ clientId: "client", clientSecret: "secret", cookiesText: "sp_dc=not-netscape" }),
    /Netscape/,
  );
  assert.equal(looksLikeNetscapeCookies(".spotify.com\tTRUE\t/\tTRUE\t0\tsp_dc\tvalue"), true);
});

test("Spotify API uses the official client-credentials token flow and caches its token", async () => {
  const calls: Array<{ url: string; init?: Parameters<SpotifyFetchLike>[1] }> = [];
  const api = fixtureApi(calls);
  await api.request(`/artists/${SPOTIFY_FIXTURE_IDS.artist}`);
  await api.request(`/artists/${SPOTIFY_FIXTURE_IDS.artist}`);

  const tokenCalls = calls.filter((call) => call.url === SPOTIFY_TOKEN_URL);
  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0].init?.method, "POST");
  assert.equal(tokenCalls[0].init?.body, "grant_type=client_credentials");
  assert.equal(tokenCalls[0].init?.headers?.Authorization, `Basic ${Buffer.from("fixture-id:fixture-secret").toString("base64")}`);
  assert.equal(calls.filter((call) => call.url.includes("/v1/artists/")).length, 2);
  assert.equal(calls.at(-1)?.init?.headers?.Authorization, "Bearer fixture-access-token");
});

test("Spotify token and provider-status probes abort on a bounded deadline", async () => {
  const authStore = new MemoryAuthStore({ clientId: "fixture-id", clientSecret: "fixture-secret" });
  const signals: AbortSignal[] = [];
  const api = new SpotifyApi({
    authStore,
    tokenTimeoutMs: 10,
    fetchImpl: async (_url, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<never>(() => undefined);
    },
  });

  await assert.rejects(
    () => api.getAccessToken(),
    (error: unknown) => error instanceof SpotifyApiError && error.status === 504 && /timed out/u.test(error.message),
  );
  assert.equal(signals[0]?.aborted, true);

  const provider = new SpotifyProvider({
    authStore,
    api,
    catalog: new SpotifyCatalog(api),
    backend: new VotifyBackend({ authStore, binaryAvailable: () => false }),
  });
  const status = await provider.getAuthStatus();
  assert.equal(status.connected, false);
  assert.equal(status.remoteCatalogAvailable, false);
  assert.equal(status.canAuthenticate, false);
  assert.match(status.message || "", /Soon/u);
  // Coming-soon auth status short-circuits before a second token probe.
  assert.equal(signals.length, 1);
});

test("Spotify API refreshes once after a catalog 401 and surfaces retry-after metadata", async () => {
  let tokenCount = 0;
  let catalogCount = 0;
  const store = new MemoryAuthStore({ clientId: "id", clientSecret: "secret" });
  const api = new SpotifyApi({
    authStore: store,
    fetchImpl: async (url) => {
      if (url === SPOTIFY_TOKEN_URL) return response({ access_token: `token-${++tokenCount}`, expires_in: 3600 });
      catalogCount += 1;
      if (catalogCount === 1) return response({ error: { message: "expired" } }, 401);
      return response({ error: { message: "slow down" } }, 429, { "retry-after": "7" });
    },
  });
  await assert.rejects(
    () => api.request("/search?q=Bastille&type=artist"),
    (error: unknown) => error instanceof SpotifyApiError && error.status === 429 && error.retryAfterSeconds === 7,
  );
  assert.equal(tokenCount, 2);
  assert.equal(catalogCount, 2);
});

test("catalog maps search evidence including stable IDs, artwork, UPC, ISRC, explicit and preview", async () => {
  const catalog = new SpotifyCatalog(fixtureApi());
  const results = await catalog.search("Bastille", { limit: 10 });
  assert.equal(results.artists[0].providerId, SPOTIFY_FIXTURE_IDS.artist);
  assert.equal(results.artists[0].picture, "https://i.scdn.co/image/bastille-640");
  assert.equal(results.albums[0].upc, "00602537312733");
  assert.equal(results.albums[0].releaseDate, "2013-03-04");
  assert.equal(results.tracks[0].isrc, "GBUM71300776");
  assert.equal(results.tracks[0].duration, 214);
  assert.equal((results.tracks[0] as { explicit?: boolean }).explicit, false);
  assert.equal((results.tracks[0] as { previewUrl?: string }).previewUrl, "https://p.scdn.co/mp3-preview/pompeii-preview");
  assert.deepEqual(results.videos, []);
});

test("catalog follows pagination for artist releases and de-duplicates stable album IDs", async () => {
  const calls: Array<{ url: string }> = [];
  const api = fixtureApi(calls);
  const albums = await new SpotifyCatalog(api).getArtistAlbums(SPOTIFY_FIXTURE_IDS.artist);
  assert.deepEqual(albums.map((album) => album.providerId), [SPOTIFY_FIXTURE_IDS.album, SPOTIFY_FIXTURE_IDS.secondAlbum]);
  assert.equal(albums[1].type, "EP");
  assert.equal(albums[1].releaseDate, "2012");
  assert.equal(calls.some((call) => call.url.includes("offset=1")), true);
});

test("catalog follows album-track pagination and attaches complete album evidence", async () => {
  const tracks = await new SpotifyCatalog(fixtureApi()).getAlbumTracks(SPOTIFY_FIXTURE_IDS.album);
  assert.equal(tracks.length, 2);
  assert.equal(tracks[1].providerId, SPOTIFY_FIXTURE_IDS.secondTrack);
  assert.equal(tracks[1].trackNumber, 2);
  assert.equal(tracks[1].volumeNumber, 1);
  assert.equal(tracks[1].album.providerId, SPOTIFY_FIXTURE_IDS.album);
  assert.equal(tracks[1].album.upc, "00602537312733");
  assert.equal((tracks[1] as { explicit?: boolean }).explicit, true);
});

test("Spotify previews are returned only when the Web API supplies preview_url", async () => {
  const catalog = new SpotifyCatalog(fixtureApi());
  assert.equal(await catalog.getTrackPreviewUrl(SPOTIFY_FIXTURE_IDS.track), "https://p.scdn.co/mp3-preview/pompeii-preview");
});

test("Spotify quality mapping advertises only the configured Vorbis lossy path", () => {
  assert.equal(spotifyQualityMapping.toNeutralAudio("VORBIS_MEDIUM"), "lossy");
  assert.equal(spotifyQualityMapping.toNeutralAudio("FLAC"), null);
  assert.equal(spotifyQualityMapping.fromNeutralAudio("lossy"), "VORBIS_MEDIUM");
  assert.throws(() => spotifyQualityMapping.fromNeutralAudio("lossless"), /does not support/);
  assert.equal(resolveVotifyAudioQuality(undefined), "vorbis-medium");
  assert.equal(resolveVotifyAudioQuality("320"), "vorbis-high");
  assert.throws(() => resolveVotifyAudioQuality("HIRES_LOSSLESS"), /not supported/);
});

test("Votify progress parser extracts track status and its zero/nonzero error summary", () => {
  assert.deepEqual(parseVotifyProgressLine('[Track 2] Downloading "Pompeii"'), {
    currentFileNum: 2,
    currentTrack: "Pompeii",
    trackStatus: "downloading",
    statusMessage: '[Track 2] Downloading "Pompeii"',
  });
  assert.equal(parseVotifyProgressLine("Finished with 0 error(s)")?.errorCount, 0);
  assert.equal(parseVotifyProgressLine("Finished with 3 error(s)")?.trackStatus, "error");
});

test("Votify backend builds a non-interactive deterministic media-id invocation", () => {
  const backend = new VotifyBackend();
  const args = backend.buildArgs({
    provider: "spotify",
    entityType: "album",
    providerId: SPOTIFY_FIXTURE_IDS.album,
    downloadPath: "/downloads/job_1",
    slot: "stereo",
  }, "/config/providers/spotify/cookies.txt");
  assert.deepEqual(args.slice(0, 8), [
    "--no-config-file", "--no-exceptions", "--wait-interval", "0",
    "--session-type", "librespot", "--cookies-path", "/config/providers/spotify/cookies.txt",
  ]);
  assert.equal(args[args.indexOf("--single-disc-file-template") + 1], "{media_id}");
  assert.equal(args[args.indexOf("--multi-disc-file-template") + 1], "{media_id}");
  assert.equal(args[args.indexOf("--no-album-file-template") + 1], "{media_id}");
  assert.equal(args[args.indexOf("--audio-quality") + 1], "vorbis-medium");
  assert.equal(args.includes("--no-synced-lyrics-file"), false);
  assert.equal(args.at(-1), `https://open.spotify.com/album/${SPOTIFY_FIXTURE_IDS.album}`);
  assert.throws(() => backend.buildArgs({
    provider: "spotify", entityType: "video", providerId: "video", downloadPath: "/tmp", slot: "video",
  }, "/cookies.txt"), /stereo audio only/);
});

test("Votify backend reports progress and treats output files as the success boundary", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-votify-"));
  const cookiesPath = path.join(tempDir, "cookies.txt");
  fs.writeFileSync(cookiesPath, "fixture");
  const authStore = new MemoryAuthStore({ clientId: "id", clientSecret: "secret", cookiesPath });
  const progress: number[] = [];
  const invocations: VotifyRunRequest[] = [];
  const backend = new VotifyBackend({
    authStore,
    binary: () => "votify-fixture",
    binaryAvailable: () => true,
    runner: async (request) => {
      invocations.push(request);
      request.onLine('[Track 1] Downloading "Pompeii"', "stdout");
      request.onLine("Finished with 0 error(s)", "stdout");
      return { code: 0 };
    },
    mediaFiles: async () => [path.join(tempDir, `${SPOTIFY_FIXTURE_IDS.track}.ogg`)],
  });
  await backend.download({
    provider: "spotify",
    entityType: "track",
    providerId: SPOTIFY_FIXTURE_IDS.track,
    downloadPath: tempDir,
    slot: "stereo",
  }, { onProgress: (event) => progress.push(event.progress ?? -1) });
  assert.equal(invocations[0]?.command, "votify-fixture");
  assert.equal(invocations[0]?.args.at(-1), `https://open.spotify.com/track/${SPOTIFY_FIXTURE_IDS.track}`);
  assert.deepEqual(progress, [-1, -1, 100]);
});

test("Votify backend rejects CLI partial failures, silent no-file success, and cancellation", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-votify-"));
  const cookiesPath = path.join(tempDir, "cookies.txt");
  fs.writeFileSync(cookiesPath, "fixture");
  const authStore = new MemoryAuthStore({ clientId: "id", clientSecret: "secret", cookiesPath });
  const request = {
    provider: "spotify",
    entityType: "track" as const,
    providerId: SPOTIFY_FIXTURE_IDS.track,
    downloadPath: tempDir,
    slot: "stereo",
  };
  const failed = new VotifyBackend({
    authStore,
    binaryAvailable: () => true,
    runner: async (run) => {
      run.onLine("Finished with 1 error(s)", "stdout");
      return { code: 0 };
    },
    mediaFiles: async () => [path.join(tempDir, "partial.ogg")],
  });
  await assert.rejects(() => failed.download(request, { onProgress() {} }), /Votify failed/);

  const empty = new VotifyBackend({
    authStore,
    binaryAvailable: () => true,
    runner: async () => ({ code: 0 }),
    mediaFiles: async () => [],
  });
  await assert.rejects(() => empty.download(request, { onProgress() {} }), /no media files/);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => empty.download(request, { signal: controller.signal, onProgress() {} }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("Spotify provider manifest, URL parsing, preview and auth status stay capability-honest", async () => {
  const calls: Array<{ url: string }> = [];
  const api = fixtureApi(calls);
  const authStore = new MemoryAuthStore({ clientId: "fixture-id", clientSecret: "fixture-secret" });
  const backend = new VotifyBackend({ authStore, binaryAvailable: () => false });
  const provider = new SpotifyProvider({ authStore, api, catalog: new SpotifyCatalog(api), backend });
  assert.equal(provider.capabilities.lossyStereo, true);
  assert.equal(provider.capabilities.losslessStereo, false);
  assert.equal(provider.capabilities.musicVideos, false);
  assert.deepEqual(provider.manifest.downloadBackends[0].capabilities, ["stereo"]);
  assert.equal(provider.manifest.auth.comingSoon, true);
  assert.equal(provider.manifest.downloadBackends[0].enabled, false);
  assert.equal(provider.isAuthenticated(), false);
  assert.equal((await provider.getAuthStatus()).canAuthenticate, false);
  assert.deepEqual(provider.parseMediaUrl(`spotify:track:${SPOTIFY_FIXTURE_IDS.track}`), {
    type: "track", providerId: SPOTIFY_FIXTURE_IDS.track,
  });
  assert.deepEqual(provider.parseMediaUrl(`https://open.spotify.com/intl-nl/album/${SPOTIFY_FIXTURE_IDS.album}?si=x`), {
    type: "album", providerId: SPOTIFY_FIXTURE_IDS.album,
  });
  assert.equal(provider.parseMediaUrl("https://example.com/not-spotify"), null);
  assert.deepEqual(await provider.getPlaybackInfo(SPOTIFY_FIXTURE_IDS.track), {
    type: "bts", url: "https://p.scdn.co/mp3-preview/pompeii-preview",
  });
  assert.equal((await provider.getAuthStatus()).connected, false);
  assert.equal((await provider.getAuthStatus()).canAuthenticate, false);
  const diagnostics = await provider.getDiagnostics();
  assert.equal(diagnostics.find((item) => item.kind === "download-backend")?.status, "error");
  assert.equal(provider.manifest.downloadBackends[0].setupNote?.includes(VOTIFY_PIP_REQUIREMENT), true);
});
