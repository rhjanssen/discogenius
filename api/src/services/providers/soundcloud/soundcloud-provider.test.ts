import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-soundcloud-"));
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.YT_DLP_BIN = "yt-dlp-test";

const {
  clearSoundCloudCredentials,
  loadSoundCloudCredentials,
  saveSoundCloudCredentials,
  SOUNDCLOUD_CREDENTIALS_FILE,
  SOUNDCLOUD_COOKIES_FILE,
  SOUNDCLOUD_DEFAULT_CLIENT_ID,
} = await import("./soundcloud-auth.js");
const {
  SoundCloudProvider,
  parseSoundCloudUrl,
  soundCloudArtworkUrl,
} = await import("./soundcloud-provider.js");
const {
  buildSoundCloudSourceUrl,
  SoundCloudBackend,
} = await import("./soundcloud-backend.js");
const { pickPlayableTranscoding, soundcloudResourceId } = await import("./soundcloud-api.js");
const { soundcloudQualityMapping } = await import("./soundcloud-quality.js");

const user = {
  id: 1478437,
  username: "BASTILLE",
  permalink_url: "https://soundcloud.com/bastilleuk",
  avatar_url: "https://i1.sndcdn.com/avatars-bastille-large.jpg",
  followers_count: 1_200_000,
};

const album = {
  id: 1891733180,
  title: "& (Ampersand)",
  permalink_url: "https://soundcloud.com/bastilleuk/sets/ampersand",
  artwork_url: "https://i1.sndcdn.com/artworks-album-large.jpg",
  duration: 420_000,
  track_count: 2,
  is_album: true,
  release_date: "2024-10-25",
  user,
  publisher_metadata: { upc_or_ean: "602465123456" },
  tracks: [
    {
      id: 194886453,
      title: "Met You",
      duration: 210_000,
      permalink_url: "https://soundcloud.com/mauns/met-you",
      artwork_url: "https://i1.sndcdn.com/artworks-track-large.jpg",
      user,
      publisher_metadata: { isrc: "GBUM71234567" },
      media: {
        transcodings: [{
          url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:194886453/progressive",
          snipped: false,
          format: { protocol: "progressive", mime_type: "audio/mpeg" },
        }],
      },
    },
    {
      id: 194886454,
      title: "Second",
      duration: 180_000,
      user,
      media: {
        transcodings: [{
          url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:194886454/hls",
          snipped: false,
          format: { protocol: "cbc-encrypted-hls", mime_type: "audio/mp4" },
        }],
      },
    },
  ],
};

test("SoundCloud origin artwork selects the original CDN rendition", async () => {
  const provider = new SoundCloudProvider(async () => {
    throw new Error("direct image ids must not call the catalog");
  });
  const source = "https://i1.sndcdn.com/artworks-album-t500x500.jpg";
  assert.equal(
    soundCloudArtworkUrl(source, "origin"),
    "https://i1.sndcdn.com/artworks-album-original.jpg",
  );
  assert.equal(
    await provider.getArtworkUrl({ entityType: "album", imageId: source, size: "origin" }),
    "https://i1.sndcdn.com/artworks-album-original.jpg",
  );
});

const track = album.tracks[0]!;

const snipOnlyTrack = {
  id: 194886499,
  title: "SNIP Only",
  duration: 180_000,
  user,
  policy: "SNIP",
  media: {
    transcodings: [{
      url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:194886499/preview",
      snipped: true,
      format: { protocol: "progressive", mime_type: "audio/mpeg" },
    }],
  },
};

const progressiveMedia = {
  transcodings: [{
    url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:progressive/progressive",
    snipped: false,
    format: { protocol: "progressive", mime_type: "audio/mpeg" },
  }],
};

const drmMedia = {
  transcodings: [
    {
      url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:drm/hls",
      snipped: false,
      format: { protocol: "hls", mime_type: "audio/mpeg" },
    },
    {
      url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:drm/enc",
      snipped: false,
      format: { protocol: "ctr-encrypted-hls", mime_type: "audio/mp4" },
    },
  ],
};

/** OPH-like fan playlist: covers the 7 MB tracks plus extras (superset OK). */
const ophPlaylist = {
  id: 1468083688,
  title: "Other Peoples Heartache",
  permalink_url: "https://soundcloud.com/emmatad/sets/other-peoples-heartache",
  artwork_url: "https://i1.sndcdn.com/artworks-oph-large.jpg",
  duration: 2_000_000,
  track_count: 10,
  is_album: false,
  set_type: "",
  release_date: null,
  user: { id: 999001, username: "emma tad", permalink_url: "https://soundcloud.com/emmatad" },
  tracks: [
    { id: 1001, title: "Adagio for Strings", duration: 239_000, user, policy: "ALLOW", media: progressiveMedia },
    { id: 1002, title: "What Would You Do?", duration: 203_000, user, policy: "ALLOW", media: progressiveMedia },
    { id: 1003, title: "Requiem for Blue Jeans", duration: 237_000, user, policy: "ALLOW", media: progressiveMedia },
    { id: 1004, title: "Of the Night", duration: 213_000, user, policy: "ALLOW", media: progressiveMedia },
    { id: 1005, title: "Titanium", duration: 174_000, user, policy: "ALLOW", media: progressiveMedia },
    { id: 1006, title: "Love Don't Live Here", duration: 362_000, user, policy: "ALLOW", media: progressiveMedia },
    { id: 1007, title: "Falling", duration: 225_000, user, policy: "ALLOW", media: progressiveMedia },
    { id: 1008, title: "Bonus Fan Cut", duration: 180_000, user, policy: "ALLOW", media: progressiveMedia },
    { id: 1009, title: "Extra Interlude", duration: 90_000, user, policy: "ALLOW", media: progressiveMedia },
    { id: 1010, title: "Outro Sketch", duration: 120_000, user, policy: "ALLOW", media: progressiveMedia },
  ],
};

/** Official-style DRM shell that title-covers OPH but is undownloadable. */
const ophDrmOfficial = {
  id: 2881942,
  title: "Other People's Heartache",
  permalink_url: "https://soundcloud.com/bastilleuk/sets/other-peoples-heartache",
  track_count: 7,
  is_album: true,
  set_type: "ep",
  user,
  tracks: [
    { id: 26282908, title: "Adagio for Strings", duration: 239_000, user, policy: "ALLOW", media: drmMedia },
    { id: 26282909, title: "What Would You Do?", duration: 203_000, user, policy: "ALLOW", media: drmMedia },
    { id: 26282910, title: "Requiem for Blue Jeans", duration: 237_000, user, policy: "ALLOW", media: drmMedia },
    { id: 26282911, title: "Of the Night", duration: 213_000, user, policy: "ALLOW", media: drmMedia },
    { id: 26282912, title: "Titanium", duration: 174_000, user, policy: "ALLOW", media: drmMedia },
    { id: 26282913, title: "Love Don't Live Here", duration: 362_000, user, policy: "ALLOW", media: drmMedia },
    { id: 26282914, title: "Falling", duration: 225_000, user, policy: "ALLOW", media: drmMedia },
  ],
};

const ophIncompletePlaylist = {
  id: 220003151,
  title: "Other People's Heartache part 1",
  permalink_url: "https://soundcloud.com/rumourhasit_nm/sets/other-peoples-heartache-part-1",
  track_count: 3,
  is_album: false,
  set_type: "",
  user: { id: 999002, username: "Nafissa_", permalink_url: "https://soundcloud.com/rumourhasit_nm" },
  tracks: [
    { id: 2001, title: "Adagio for Strings", duration: 239_000, user, policy: "ALLOW", media: progressiveMedia },
    { id: 2002, title: "What Would You Do?", duration: 203_000, user, policy: "ALLOW", media: progressiveMedia },
    { id: 2003, title: "Unrelated Filler", duration: 200_000, user, policy: "ALLOW", media: progressiveMedia },
  ],
};

/** Mixed fan/official set: covers all 7 titles but one covering track is DRM. */
const ophMixedDrmPlaylist = {
  id: 220003999,
  title: "Other People's Heartache part 1 mixed",
  permalink_url: "https://soundcloud.com/rumourhasit_nm/sets/other-peoples-heartache-mixed",
  track_count: 7,
  is_album: false,
  set_type: "",
  user: { id: 999002, username: "Nafissa_", permalink_url: "https://soundcloud.com/rumourhasit_nm" },
  tracks: [
    { id: 3001, title: "Adagio for Strings", duration: 239_000, user, policy: "ALLOW", media: progressiveMedia },
    { id: 26282908, title: "What Would You Do?", duration: 203_000, user, policy: "ALLOW", media: drmMedia },
    { id: 3003, title: "Requiem for Blue Jeans", duration: 237_000, user, policy: "ALLOW", media: progressiveMedia },
    { id: 3004, title: "Of the Night", duration: 213_000, user, policy: "ALLOW", media: progressiveMedia },
    { id: 3005, title: "Titanium", duration: 174_000, user, policy: "ALLOW", media: progressiveMedia },
    { id: 3006, title: "Love Don't Live Here", duration: 362_000, user, policy: "ALLOW", media: progressiveMedia },
    { id: 3007, title: "Falling", duration: 225_000, user, policy: "ALLOW", media: progressiveMedia },
  ],
};

const ophCanonicalTracks = [
  { title: "Adagio for Strings", durationSec: 239, trackNumber: 1 },
  { title: "What Would You Do?", durationSec: 203, trackNumber: 2 },
  { title: "Requiem for Blue Jeans", durationSec: 237, trackNumber: 3 },
  { title: "Of the Night", durationSec: 213, trackNumber: 4 },
  { title: "Titanium", durationSec: 174, trackNumber: 5 },
  { title: "Love Don't Live Here", durationSec: 362, trackNumber: 6 },
  { title: "Falling", durationSec: 225, trackNumber: 7 },
];

function fixtureFetch(input: string) {
  const url = new URL(input);
  let payload: unknown = null;
  let status = 200;

  if (url.pathname === "/me") {
    payload = { id: 491572725, username: "Robert Janssen", consumer_subscription: { product: { id: "free" } } };
  } else if (url.pathname === "/search/users") {
    payload = { collection: [user] };
  } else if (url.pathname === "/search/albums") {
    payload = { collection: [album] };
  } else if (url.pathname === "/search/playlists") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    if (q.includes("heartache") || q.includes("bastille")) {
      payload = { collection: [ophDrmOfficial, ophPlaylist, ophIncompletePlaylist, ophMixedDrmPlaylist] };
    } else {
      payload = { collection: [] };
    }
  } else if (url.pathname === "/search/tracks") {
    payload = { collection: [track, album.tracks[1], snipOnlyTrack] };
  } else if (url.pathname === "/users/1478437") {
    payload = user;
  } else if (url.pathname === "/users/1478437/albums") {
    payload = { collection: [album] };
  } else if (url.pathname === "/playlists/1891733180") {
    payload = album;
  } else if (url.pathname === "/playlists/1468083688") {
    payload = ophPlaylist;
  } else if (url.pathname === "/playlists/220003151") {
    payload = ophIncompletePlaylist;
  } else if (url.pathname === "/playlists/220003999") {
    payload = ophMixedDrmPlaylist;
  } else if (url.pathname === "/playlists/2881942") {
    payload = ophDrmOfficial;
  } else if (url.pathname === "/tracks/194886453") {
    payload = track;
  } else if (url.pathname === "/tracks/194886454") {
    payload = album.tracks[1];
  } else if (/^\/tracks\/(3001|3003|3004|3005|3006|3007|26282908)$/u.test(url.pathname)) {
    const id = Number(url.pathname.slice("/tracks/".length));
    payload = ophMixedDrmPlaylist.tracks.find((item) => item.id === id)
      || ophDrmOfficial.tracks.find((item) => item.id === id);
  } else if (url.pathname.startsWith("/media/")) {
    payload = { url: "https://cf-media.sndcdn.com/fixture.128.mp3" };
  } else if (url.hostname === "cf-media.sndcdn.com") {
    const body = Buffer.from("ID3fixture-audio");
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => "audio/mpeg" },
      json: async () => ({}),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      text: async () => "",
    });
  } else {
    status = 404;
    payload = { error: `No fixture for ${url.pathname}` };
  }

  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => payload,
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => JSON.stringify(payload),
  });
}

test("SoundCloud auth stores oauth token under the provider config root", () => {
  clearSoundCloudCredentials();
  saveSoundCloudCredentials({
    oauthToken: "OAuth 2-326587-test-token",
    clientId: "test-client-id",
  });
  const loaded = loadSoundCloudCredentials();
  assert.equal(loaded?.oauthToken, "2-326587-test-token");
  assert.equal(loaded?.clientId, "test-client-id");
  assert.ok(fs.existsSync(SOUNDCLOUD_CREDENTIALS_FILE));
  clearSoundCloudCredentials();
});

test("SoundCloud auth defaults client id and rejects empty or multiline tokens", () => {
  clearSoundCloudCredentials();
  assert.throws(() => saveSoundCloudCredentials({ oauthToken: "" }), /oauthToken is required/i);
  assert.throws(
    () => saveSoundCloudCredentials({ oauthToken: "short" }),
    /single-line session token/i,
  );
  assert.throws(
    () => saveSoundCloudCredentials({ oauthToken: "2-326587-test-token\nextra" }),
    /single-line session token/i,
  );
  const saved = saveSoundCloudCredentials({ oauthToken: "2-326587-test-token" });
  assert.equal(saved.clientId, SOUNDCLOUD_DEFAULT_CLIENT_ID);
  assert.equal(loadSoundCloudCredentials()?.clientId, SOUNDCLOUD_DEFAULT_CLIENT_ID);
  clearSoundCloudCredentials();
});

test("SoundCloud auth accepts Netscape cookies for yt-dlp fallback", () => {
  clearSoundCloudCredentials();
  saveSoundCloudCredentials({
    oauthToken: "2-326587-test-token",
    cookies: "# Netscape HTTP Cookie File\n.soundcloud.com\tTRUE\t/\tFALSE\t2147483647\toauth_token\t2-326587-test-token\n",
  });
  assert.ok(fs.existsSync(SOUNDCLOUD_COOKIES_FILE));
  clearSoundCloudCredentials();
});

test("SoundCloud maps api-v2 search into provider-neutral resources", async () => {
  saveSoundCloudCredentials({ oauthToken: "2-326587-test-token" });
  const provider = new SoundCloudProvider(fixtureFetch);
  const result = await provider.search("Bastille", { limit: 5 });
  assert.equal(result.artists[0]?.providerId, "1478437");
  assert.equal(result.albums[0]?.providerId, "1891733180");
  assert.equal(result.albums[0]?.upc, "602465123456");
  assert.equal(result.tracks[0]?.isrc, "GBUM71234567");
  assert.equal(result.tracks[0]?.duration, 210);
  assert.equal(result.videos.length, 0);
});

test("SoundCloud mappers do not fabricate public links from numeric ids", async () => {
  saveSoundCloudCredentials({ oauthToken: "2-326587-test-token" });
  const withoutPermalinks = (input: string) => {
    const url = new URL(input);
    let payload: unknown;
    if (url.pathname === "/users/1478437") {
      payload = { ...user, permalink_url: undefined };
    } else if (url.pathname === "/playlists/1891733180") {
      payload = {
        ...album,
        permalink_url: undefined,
        user: { ...user, permalink_url: undefined },
      };
    } else if (url.pathname === "/tracks/194886453") {
      payload = {
        ...track,
        permalink_url: undefined,
        user: { ...user, permalink_url: undefined },
      };
    } else {
      return fixtureFetch(input);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => payload,
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => JSON.stringify(payload),
    });
  };
  const provider = new SoundCloudProvider(withoutPermalinks);

  assert.equal((await provider.getArtist("1478437")).url, undefined);
  assert.equal((await provider.getAlbum("1891733180")).url, undefined);
  assert.equal((await provider.getTrack("194886453")).url, undefined);
});

test("SoundCloud album tracklists keep provider track ids and positions", async () => {
  saveSoundCloudCredentials({ oauthToken: "2-326587-test-token" });
  const provider = new SoundCloudProvider(fixtureFetch);
  const tracks = await provider.getAlbumTracks("1891733180");
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0]?.providerId, "194886453");
  assert.equal(tracks[0]?.trackNumber, 1);
  assert.equal(tracks[1]?.providerId, "194886454");
  assert.equal(tracks[1]?.trackNumber, 2);
});

test("SoundCloud quality mapping is lossy-only", () => {
  assert.equal(soundcloudQualityMapping.toNeutralAudio("SOUNDCLOUD_LOSSY"), "lossy");
  assert.equal(soundcloudQualityMapping.fromNeutralAudio("lossless"), "SOUNDCLOUD_LOSSY");
  assert.deepEqual(soundcloudQualityMapping.toNeutral(["SOUNDCLOUD_LOSSY"]), { audio: "lossy", spatial: [] });
});

test("SoundCloud skips encrypted and snipped transcodings for native play", () => {
  assert.equal(
    pickPlayableTranscoding(track)?.format?.protocol,
    "progressive",
  );
  assert.equal(
    pickPlayableTranscoding(album.tracks[1]!),
    null,
  );
  assert.equal(soundcloudResourceId("soundcloud:tracks:194886453"), "194886453");
});

test("SoundCloud preview may use snipped progressive when full streams are DRM-only", () => {
  const snippedOnly = {
    ...album.tracks[1]!,
    media: {
      transcodings: [
        {
          url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:194886454/preview/stream/progressive",
          snipped: true,
          format: { protocol: "progressive", mime_type: "audio/mpeg" },
        },
        {
          url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:194886454/enc/stream/ctr-encrypted-hls",
          snipped: false,
          format: { protocol: "ctr-encrypted-hls", mime_type: "audio/mp4" },
        },
      ],
    },
  };
  assert.equal(pickPlayableTranscoding(snippedOnly), null);
  assert.equal(
    pickPlayableTranscoding(snippedOnly, { allowSnipped: true })?.format?.protocol,
    "progressive",
  );
  assert.equal(
    pickPlayableTranscoding(snippedOnly, { allowSnipped: true })?.snipped,
    true,
  );
});

test("SoundCloud URL builders accept numeric ids and permalink hosts", () => {
  assert.equal(
    buildSoundCloudSourceUrl("track", "194886453"),
    "https://api.soundcloud.com/tracks/194886453",
  );
  assert.equal(
    buildSoundCloudSourceUrl("album", "1891733180"),
    "https://api.soundcloud.com/playlists/1891733180",
  );
  assert.deepEqual(
    parseSoundCloudUrl("https://api.soundcloud.com/tracks/194886453"),
    { type: "track", providerId: "194886453" },
  );
});

test("SoundCloud yt-dlp args include oauth header and provider-id output template", () => {
  saveSoundCloudCredentials({ oauthToken: "2-326587-test-token", clientId: "client-x" });
  const backend = new SoundCloudBackend({ preferNative: false });
  const args = backend.buildYtDlpArgs({
    provider: "soundcloud",
    entityType: "track",
    providerId: "194886453",
    downloadPath: path.join(tempDir, "dl"),
  });
  assert.ok(args.includes("--add-header"));
  assert.ok(args.some((arg) => arg.includes("Authorization:OAuth 2-326587-test-token")));
  assert.ok(args.some((arg) => arg.includes("%(id)s.%(ext)s")));
  assert.ok(args.includes("https://api.soundcloud.com/tracks/194886453"));
});

test("SoundCloud native backend downloads progressive MP3 named by provider id", async () => {
  saveSoundCloudCredentials({ oauthToken: "2-326587-test-token" });
  const downloadPath = path.join(tempDir, "native-dl");
  fs.mkdirSync(downloadPath, { recursive: true });
  const backend = new SoundCloudBackend({
    fetchImpl: fixtureFetch,
    preferNative: true,
    spawnImpl: () => {
      throw new Error("yt-dlp should not be required for progressive fixtures");
    },
  });
  const progress: number[] = [];
  await backend.download({
    provider: "soundcloud",
    entityType: "track",
    providerId: "194886453",
    downloadPath,
  }, {
    onProgress: (event) => progress.push(event.progress ?? -1),
  });
  const output = path.join(downloadPath, "194886453.mp3");
  assert.ok(fs.existsSync(output));
  assert.ok(fs.statSync(output).size > 0);
  assert.ok(progress.length > 0);
});

test("SoundCloud album omits DRM tracks and downloads the playable remainder", async () => {
  saveSoundCloudCredentials({ oauthToken: "2-326587-test-token" });
  const downloadPath = path.join(tempDir, "album-partial-dl");
  fs.rmSync(downloadPath, { recursive: true, force: true });
  fs.mkdirSync(downloadPath, { recursive: true });
  let fallbackRuns = 0;
  const warnings: string[] = [];
  const skippedStatuses: string[] = [];
  const backend = new SoundCloudBackend({
    fetchImpl: fixtureFetch,
    preferNative: true,
    spawnImpl: () => {
      fallbackRuns += 1;
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: () => boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => child.emit("close", 0, null));
      return child as any;
    },
  });

  await backend.download({
    provider: "soundcloud",
    entityType: "album",
    providerId: "1891733180",
    downloadPath,
  }, {
    onProgress: (event) => {
      if (event.warningMessage) warnings.push(event.warningMessage);
      if (event.tracks) {
        for (const track of event.tracks) {
          if (track.status === "skipped") skippedStatuses.push(track.providerTrackId || track.title);
        }
      }
    },
  });
  assert.equal(fallbackRuns, 0);
  assert.deepEqual(fs.readdirSync(downloadPath).sort(), ["194886453.mp3"]);
  assert.deepEqual(warnings, []);
  assert.deepEqual(skippedStatuses, []);
});

test("SoundCloud mixed album downloads 6 progressive tracks and never queues the DRM row", async () => {
  saveSoundCloudCredentials({ oauthToken: "2-326587-test-token" });
  const downloadPath = path.join(tempDir, "album-mixed-6-of-7-dl");
  fs.rmSync(downloadPath, { recursive: true, force: true });
  fs.mkdirSync(downloadPath, { recursive: true });
  let fallbackRuns = 0;
  const warnings: string[] = [];
  const seenIds = new Set<string>();
  const backend = new SoundCloudBackend({
    fetchImpl: fixtureFetch,
    preferNative: true,
    spawnImpl: () => {
      fallbackRuns += 1;
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: () => boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => child.emit("close", 0, null));
      return child as any;
    },
  });

  await backend.download({
    provider: "soundcloud",
    entityType: "album",
    providerId: "220003999",
    downloadPath,
  }, {
    onProgress: (event) => {
      if (event.warningMessage) warnings.push(event.warningMessage);
      for (const track of event.tracks || []) {
        if (track.providerTrackId) seenIds.add(track.providerTrackId);
      }
    },
  });
  assert.equal(fallbackRuns, 0);
  assert.deepEqual(
    fs.readdirSync(downloadPath).sort(),
    ["3001.mp3", "3003.mp3", "3004.mp3", "3005.mp3", "3006.mp3", "3007.mp3"],
  );
  assert.deepEqual(warnings, []);
  assert.ok(!seenIds.has("26282908"));
});

test("SoundCloud removes staged native album files when a later transfer fails", async () => {
  saveSoundCloudCredentials({ oauthToken: "2-326587-test-token" });
  const downloadPath = path.join(tempDir, "album-transfer-failure-dl");
  fs.rmSync(downloadPath, { recursive: true, force: true });
  fs.mkdirSync(downloadPath, { recursive: true });
  const progressiveSecondTrack = {
    ...album.tracks[1],
    media: {
      transcodings: [{
        url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:194886454/progressive",
        snipped: false,
        format: { protocol: "progressive", mime_type: "audio/mpeg" },
      }],
    },
  };
  const transferFailureFetch = (input: string) => {
    const url = new URL(input);
    if (url.pathname === "/tracks/194886454") {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => progressiveSecondTrack,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => JSON.stringify(progressiveSecondTrack),
      });
    }
    if (url.pathname.startsWith("/media/")) {
      const providerTrackId = url.pathname.match(/tracks:(\d+)/u)?.[1] || "unknown";
      const payload = { url: `https://cf-media.sndcdn.com/${providerTrackId}.mp3` };
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => payload,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => JSON.stringify(payload),
      });
    }
    if (url.hostname === "cf-media.sndcdn.com") {
      const fails = url.pathname.includes("194886454");
      const body = Buffer.from("ID3fixture-audio");
      return Promise.resolve({
        ok: !fails,
        status: fails ? 503 : 200,
        headers: { get: () => "audio/mpeg" },
        json: async () => ({}),
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        text: async () => "",
      });
    }
    return fixtureFetch(input);
  };
  let fallbackRuns = 0;
  const backend = new SoundCloudBackend({
    fetchImpl: transferFailureFetch,
    preferNative: true,
    spawnImpl: () => {
      fallbackRuns += 1;
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: () => boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => child.emit("close", 0, null));
      return child as any;
    },
    mediaFileFinder: async () => [path.join(downloadPath, "194886453.mp3")],
  });

  await backend.download({
    provider: "soundcloud",
    entityType: "album",
    providerId: "1891733180",
    downloadPath,
  }, {
    onProgress: () => undefined,
  });

  assert.equal(fallbackRuns, 1);
  assert.deepEqual(fs.readdirSync(downloadPath), []);
});

test("SoundCloud provider auth status reports connected user from /me", async () => {
  saveSoundCloudCredentials({ oauthToken: "2-326587-test-token" });
  const provider = new SoundCloudProvider(fixtureFetch);
  const status = await provider.getAuthStatus();
  assert.equal(status.connected, true);
  assert.equal(status.user?.username, "Robert Janssen");
  assert.match(String(status.message || ""), /SNIP\/DRM|Go\+/i);
});

test("SoundCloud mixtape search matches covering fan playlists as supersets", async () => {
  saveSoundCloudCredentials({ oauthToken: "2-326587-test-token" });
  const provider = new SoundCloudProvider(fixtureFetch);
  const offers = await provider.searchReleaseGroup({
    artistName: "Bastille",
    releaseGroupTitle: "Other People's Heartache",
    slot: "stereo",
    primaryType: "EP",
    secondaryTypes: ["Mixtape/Street"],
    preferredTrackCount: 7,
    preferredTracks: ophCanonicalTracks,
  });
  // Progressive fan set ranks above mixed DRM covers; DRM-only official is out.
  assert.ok(offers.length >= 1);
  assert.equal(offers[0]?.providerId, "1468083688");
  assert.equal(offers[0]?.type, "PLAYLIST");
  assert.equal(
    (offers[0]?.raw as { _discogeniusMatchMethod?: string } | undefined)?._discogeniusMatchMethod,
    "playlist-tracklist-coverage",
  );
  assert.equal(
    (offers[0]?.raw as { _discogeniusDownloadableCovered?: number } | undefined)
      ?._discogeniusDownloadableCovered,
    7,
  );
  assert.ok(!offers.some((album) => album.providerId === "2881942"));
  const mixed = offers.find((album) => album.providerId === "220003999");
  if (mixed) {
    const topIdx = offers.findIndex((album) => album.providerId === "1468083688");
    const mixedIdx = offers.findIndex((album) => album.providerId === "220003999");
    assert.ok(topIdx >= 0 && mixedIdx > topIdx);
  }
});

test("SoundCloud mixtape search rejects DRM-only official shells", async () => {
  saveSoundCloudCredentials({ oauthToken: "2-326587-test-token" });
  const provider = new SoundCloudProvider(fixtureFetch);
  const offers = await provider.searchReleaseGroup({
    artistName: "Bastille",
    releaseGroupTitle: "Other People's Heartache",
    slot: "stereo",
    primaryType: "EP",
    secondaryTypes: ["Mixtape/Street"],
    preferredTrackCount: 7,
    preferredTracks: ophCanonicalTracks,
  });
  assert.ok(!offers.some((album) => album.providerId === "2881942"));
  assert.ok(offers.some((album) => album.providerId === "1468083688"));
});

test("SoundCloud track search filters DRM and SNIP results", async () => {
  saveSoundCloudCredentials({ oauthToken: "2-326587-test-token" });
  const provider = new SoundCloudProvider(fixtureFetch);
  const results = await provider.search("bastille", { types: ["tracks"], limit: 10 });
  assert.ok(results.tracks.some((row) => row.providerId === "194886453"));
  assert.ok(!results.tracks.some((row) => row.providerId === "194886454"));
  assert.ok(!results.tracks.some((row) => row.providerId === "194886499"));
});

test("SoundCloud official album search does not query fan playlists", async () => {
  saveSoundCloudCredentials({ oauthToken: "2-326587-test-token" });
  const seenPaths: string[] = [];
  const trackingFetch = (input: string) => {
    seenPaths.push(new URL(input).pathname);
    return fixtureFetch(input);
  };
  const provider = new SoundCloudProvider(trackingFetch);
  const offers = await provider.searchReleaseGroup({
    artistName: "Bastille",
    releaseGroupTitle: "Ampersand",
    slot: "stereo",
    primaryType: "Album",
    secondaryTypes: [],
    preferredTrackCount: 2,
  });
  assert.ok(offers.some((album) => album.providerId === "1891733180"));
  assert.ok(!seenPaths.includes("/search/playlists"));
});
