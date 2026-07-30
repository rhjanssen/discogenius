import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-refresh-artist-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let refreshServiceModule: typeof import("./refresh-artist-service.js");
let refreshMatchModule: typeof import("./refresh-artist-match.js");
let providersModule: typeof import("../providers/index.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  refreshServiceModule = await import("./refresh-artist-service.js");
  refreshMatchModule = await import("./refresh-artist-match.js");
  providersModule = await import("../providers/index.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM Tracks").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM AlbumEditions").run();
  dbModule.db.prepare("DELETE FROM ArtistReleaseGroups").run();
  dbModule.db.prepare("DELETE FROM Albums").run();
  dbModule.db.prepare("DELETE FROM Artists").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedSoundCloudMixtapeCatalog() {
  const artistMbid = "7808accb-6395-4b25-858c-678bbb73896b";
  const releaseGroupMbid = "375227dd-11c1-4fec-afc0-f4c37a6de604";
  const editionMbid = "b8f50118-3d3c-4826-a4b3-cf6228a97515";
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run(artistMbid, "Bastille");
  dbModule.db.prepare(`
    INSERT INTO Albums (
      mbid, artist_mbid, title, primary_type, secondary_types, first_release_date
    ) VALUES (?, ?, ?, 'EP', ?, '2012-02-17')
  `).run(
    releaseGroupMbid,
    artistMbid,
    "Other People's Heartache",
    JSON.stringify(["Mixtape/Street"]),
  );
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_mbid, artist_mbid, title, status, date, media_count, track_count
    ) VALUES (?, ?, ?, ?, 'Official', '2012-02-17', 1, 2)
  `).run(editionMbid, releaseGroupMbid, artistMbid, "Other People's Heartache");
  const canonicalTracks = [
    { id: "sc-track-mbid-1", recording: "sc-recording-mbid-1", title: "Adagio for Strings", duration: 239 },
    { id: "sc-track-mbid-2", recording: "sc-recording-mbid-2", title: "Falling", duration: 225 },
  ];
  canonicalTracks.forEach((track, index) => {
    dbModule.db.prepare("INSERT INTO Recordings (mbid, title, length_ms) VALUES (?, ?, ?)")
      .run(track.recording, track.title, track.duration * 1000);
    dbModule.db.prepare(`
      INSERT INTO Tracks (
        mbid, recording_mbid, edition_mbid, title, length_ms,
        medium_position, position, number
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      track.id,
      track.recording,
      editionMbid,
      track.title,
      track.duration * 1000,
      index + 1,
      String(index + 1),
    );
  });
  return { artistMbid, releaseGroupMbid, editionMbid, canonicalTracks };
}

test("bulk provider tracklists are accepted only when the album is complete", () => {
  const complete = Array.from({ length: 24 }, (_, index) => ({ id: index + 1 }));
  const truncated = complete.slice(0, 20);

  assert.equal(refreshServiceModule.completeBulkTrackList(24, truncated), null);
  assert.equal(refreshServiceModule.completeBulkTrackList(24, undefined), null);
  assert.equal(refreshServiceModule.completeBulkTrackList(24, complete), complete);
});

test("artist metadata seeding queries the explicitly requested provider", async () => {
  const providerId = "provider-choice-test";
  let fetchedArtistId: string | null = null;
  providersModule.streamingProviderManager.registerStreamingProvider({
    id: providerId,
    name: "Provider Choice Test",
    capabilities: {
      catalogSearch: true,
      artistCatalog: true,
      followedArtists: false,
      audioPreviews: false,
      audioDownloads: false,
      lossyStereo: false,
      losslessStereo: false,
      hiResStereo: false,
      spatialAudio: false,
      lyrics: false,
      musicVideos: false,
      videoPreviews: false,
      videoDownloads: false,
      artwork: false,
      editorialMetadata: false,
      providerIds: true,
    },
    search: async () => ({ artists: [], albums: [], tracks: [], videos: [] }),
    getArtist: async (id) => {
      fetchedArtistId = String(id);
      return { providerId: String(id), name: "Bastille" };
    },
    getArtistAlbums: async () => [],
    getAlbum: async () => { throw new Error("not used"); },
    getAlbumTracks: async () => [],
    getTrack: async () => { throw new Error("not used"); },
    getAuthStatus: async () => ({
      connected: false,
      tokenExpired: false,
      refreshTokenExpired: false,
      hoursUntilExpiry: 0,
      canAccessShell: false,
      canAccessLocalLibrary: false,
      remoteCatalogAvailable: true,
      canAuthenticate: false,
    }),
  });

  const identityModule = await import("../metadata/provider-artist-identity-service.js");
  const originalResolve = identityModule.ProviderArtistIdentityService.resolve;
  const originalStore = identityModule.ProviderArtistIdentityService.store;
  const originalUpsert = refreshServiceModule.RefreshArtistService.upsertMusicBrainzArtist;
  (identityModule.ProviderArtistIdentityService as any).resolve = async (selectedProvider: string) => ({
    providerId: "42",
    provider: selectedProvider,
    mbid: "7808accb-6395-4b25-858c-678bbb73896b",
    status: "verified",
    confidence: 1,
    method: "test",
    evidence: {},
  });
  (identityModule.ProviderArtistIdentityService as any).store = () => undefined;
  (refreshServiceModule.RefreshArtistService as any).upsertMusicBrainzArtist = async () => "42";

  try {
    await refreshServiceModule.RefreshArtistService.refreshArtistMetadata("42", {
      provider: providerId,
      forceUpdate: true,
    });
  } finally {
    (identityModule.ProviderArtistIdentityService as any).resolve = originalResolve;
    (identityModule.ProviderArtistIdentityService as any).store = originalStore;
    (refreshServiceModule.RefreshArtistService as any).upsertMusicBrainzArtist = originalUpsert;
  }

  assert.equal(fetchedArtistId, "42");
});

test("unmatched provider offers retain discovery provenance without claiming canonical ownership", () => {
  const artistMbid = "artist-mbid-bastille";
  const album = {
    provider_id: "314738795",
    title: "Happier",
    artist_name: "Marshmello & Bastille",
    quality: "LOSSLESS",
  };

  (refreshServiceModule.RefreshArtistService as any).storeProviderAlbumOffers(
    "tidal",
    artistMbid,
    [album],
    new Map(),
  );

  const row = dbModule.db.prepare(`
    SELECT artist_mbid, release_group_mbid, discovered_from_artist_mbid, match_status
    FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'album' AND provider_id = ?
  `).get(album.provider_id) as {
    artist_mbid: string | null;
    release_group_mbid: string | null;
    discovered_from_artist_mbid: string | null;
    match_status: string;
  };

  assert.equal(row.artist_mbid, null);
  assert.equal(row.release_group_mbid, null);
  assert.equal(row.discovered_from_artist_mbid, artistMbid);
  assert.equal(row.match_status, "unmatched");
});

test("hybrid candidates retain discovery provenance without publishing direct availability", () => {
  const artistMbid = "artist-mbid-bastille";
  const album = {
    provider_id: "candidate-album-1",
    title: "Partial provider edition",
    artist_name: "Bastille",
    quality: "LOSSLESS",
  };

  (refreshServiceModule.RefreshArtistService as any).storeProviderAlbumOffers(
    "tidal",
    artistMbid,
    [album],
    new Map([[album.provider_id, {
      providerId: album.provider_id,
      status: "candidate",
      confidence: 0.24,
      method: "musicbrainz-recording-isrc",
      editionMbid: "release-mbid-candidate",
      releaseGroup: {
        mbid: "release-group-mbid-candidate",
        title: "Canonical album",
      },
      evidence: { isrcOverlap: 1 },
    }]]),
  );

  const offer = dbModule.db.prepare(`
    SELECT artist_mbid, release_group_mbid, edition_mbid,
           discovered_from_artist_mbid, match_status
    FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'album' AND provider_id = ?
  `).get(album.provider_id) as Record<string, string | null>;
  const directMatchCount = dbModule.db.prepare(`
    SELECT COUNT(*) AS count
    FROM ProviderEditionMatches match
    JOIN ProviderItems item ON item.id = match.provider_edition_item_id
    WHERE item.provider = 'tidal'
      AND item.entity_type = 'release'
      AND item.provider_id = ?
  `).get(album.provider_id) as { count: number };

  assert.equal(offer.artist_mbid, artistMbid);
  assert.equal(offer.release_group_mbid, "release-group-mbid-candidate");
  assert.equal(offer.edition_mbid, "release-mbid-candidate");
  assert.equal(offer.discovered_from_artist_mbid, artistMbid);
  assert.equal(offer.match_status, "candidate");
  assert.equal(directMatchCount.count, 0);
});

test("stored SoundCloud playlist coverage is revalidated and its permalink is backfilled", async () => {
  const { artistMbid, releaseGroupMbid, editionMbid, canonicalTracks } = seedSoundCloudMixtapeCatalog();
  const providerAlbumId = "220003151";
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('soundcloud', 'release', ?, ?)
  `).run( providerAlbumId, "Other People's Heartache part 1" );

  const artist = { providerId: "sc-user", name: "Nafissa_" };
  const album = {
    providerId: providerAlbumId,
    title: "Other People's Heartache part 1",
    artist,
    artists: [artist],
    releaseDate: "2012-02-17",
    trackCount: 2,
    volumeCount: 1,
    type: "PLAYLIST",
    quality: "SOUNDCLOUD_LOSSY",
    qualityTags: ["SOUNDCLOUD_LOSSY", "MP3"],
    url: "https://soundcloud.com/rumourhasit_nm/sets/other-peoples-heartache-part-1",
  };
  const tracks = canonicalTracks.map((track, index) => ({
    providerId: String(1000 + index),
    title: track.title,
    artist,
    artists: [artist],
    album,
    duration: track.duration,
    trackNumber: index + 1,
    volumeNumber: 1,
    quality: "SOUNDCLOUD_LOSSY",
  }));
  const provider = {
    id: "soundcloud",
    getAlbum: async () => album,
    getAlbumTracks: async () => tracks,
    searchReleaseGroup: async () => {
      throw new Error("valid stored offer should avoid a new wide search");
    },
  };

  const result = await (refreshServiceModule.RefreshArtistService as any)
    .searchSoundCloudMixtapePlaylistOffers(provider, artistMbid, new Set());
  assert.equal(result.albums.length, 1);
  assert.equal(result.albums[0].provider_id, providerAlbumId);

  await (refreshServiceModule.RefreshArtistService as any).storeProviderAlbumOffers(
    "soundcloud",
    artistMbid,
    result.albums,
    result.matches,
  );
  const stored = dbModule.db.prepare(`
    SELECT provider_url, availability, match_status
    FROM ProviderItems
    WHERE provider = 'soundcloud' AND entity_type = 'album' AND provider_id = ?
  `).get(providerAlbumId) as {
    provider_url: string | null;
    availability: string | null;
    match_status: string;
  };
  assert.equal(stored.provider_url, album.url);
  assert.equal(stored.availability, "available");
  assert.equal(stored.match_status, "probable");
});

test("all durable SoundCloud playlist offers are revalidated after the first valid one", async () => {
  const { artistMbid, releaseGroupMbid, editionMbid, canonicalTracks } = seedSoundCloudMixtapeCatalog();
  const validId = "110003151";
  const staleId = "220003151";
  const insertOffer = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, quality, artist_mbid,
      release_group_mbid, edition_mbid, match_status, match_confidence,
      match_method, availability, updated_at
    ) VALUES (
      'soundcloud', 'album', ?, ?, 'SOUNDCLOUD_LOSSY', ?, ?, ?,
      'probable', 0.85, 'playlist-tracklist-coverage', 'available', ?
    )
  `);
  insertOffer.run(
    validId,
    "Other People's Heartache",
    artistMbid,
    releaseGroupMbid,
    editionMbid,
    "2030-01-01 00:00:00",
  );
  insertOffer.run(
    staleId,
    "Other People's Heartache",
    artistMbid,
    releaseGroupMbid,
    editionMbid,
    "2020-01-01 00:00:00",
  );

  const artist = { providerId: "sc-user", name: "Fan uploader" };
  const makeAlbum = (providerId: string) => ({
    providerId,
    title: "Other People's Heartache",
    artist,
    artists: [artist],
    releaseDate: "2012-02-17",
    trackCount: 2,
    volumeCount: 1,
    type: "PLAYLIST",
    quality: "SOUNDCLOUD_LOSSY",
    qualityTags: ["SOUNDCLOUD_LOSSY", "MP3"],
    url: `https://soundcloud.com/fan/sets/${providerId}`,
  });
  const validAlbum = makeAlbum(validId);
  const validTracks = canonicalTracks.map((track, index) => ({
    providerId: String(3000 + index),
    title: track.title,
    artist,
    artists: [artist],
    album: validAlbum,
    duration: track.duration,
    trackNumber: index + 1,
    volumeNumber: 1,
    quality: "SOUNDCLOUD_LOSSY",
  }));
  const checked: string[] = [];
  const provider = {
    id: "soundcloud",
    getAlbum: async (id: string) => makeAlbum(String(id)),
    getAlbumTracks: async (id: string) => {
      checked.push(String(id));
      return String(id) === validId ? validTracks : [];
    },
    searchReleaseGroup: async () => {
      throw new Error("a retained stored offer should avoid a new wide search");
    },
  };

  const result = await (refreshServiceModule.RefreshArtistService as any)
    .searchSoundCloudMixtapePlaylistOffers(provider, artistMbid, new Set());
  assert.deepEqual(checked, [validId, staleId]);
  assert.deepEqual(result.albums.map((row: any) => row.provider_id), [validId]);
  const stale = dbModule.db.prepare(`
    SELECT availability, match_status
    FROM ProviderItems
    WHERE provider = 'soundcloud' AND entity_type = 'album' AND provider_id = ?
  `).get(staleId);
  assert.deepEqual(stale, { availability: "unavailable", match_status: "rejected" });
});

test("empty stored SoundCloud playlist is rejected and a covering replacement is selected", async () => {
  const { artistMbid, releaseGroupMbid, editionMbid, canonicalTracks } = seedSoundCloudMixtapeCatalog();
  const staleId = "220003151";
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('soundcloud', 'release', ?, ?)
  `).run( staleId, "Other People's Heartache" );
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, availability
    ) VALUES ('soundcloud', 'track', 'stale-child-track', 'Stale Track', 'available')
  `).run();
  const artist = { providerId: "sc-user", name: "Fan uploader" };
  const makeAlbum = (providerId: string) => ({
    providerId,
    title: "Other People's Heartache",
    artist,
    artists: [artist],
    releaseDate: "2012-02-17",
    trackCount: 2,
    volumeCount: 1,
    type: "PLAYLIST",
    quality: "SOUNDCLOUD_LOSSY",
    qualityTags: ["SOUNDCLOUD_LOSSY", "MP3"],
    url: `https://soundcloud.com/fan/sets/${providerId}`,
  });
  const replacement = makeAlbum("330004252");
  const replacementTracks = canonicalTracks.map((track, index) => ({
    providerId: String(2000 + index),
    title: track.title,
    artist,
    artists: [artist],
    album: replacement,
    duration: track.duration,
    trackNumber: index + 1,
    volumeNumber: 1,
    quality: "SOUNDCLOUD_LOSSY",
  }));
  const provider = {
    id: "soundcloud",
    getAlbum: async (id: string) => makeAlbum(String(id)),
    getAlbumTracks: async (id: string) => String(id) === staleId ? [] : replacementTracks,
    searchReleaseGroup: async () => [replacement],
  };

  const result = await (refreshServiceModule.RefreshArtistService as any)
    .searchSoundCloudMixtapePlaylistOffers(provider, artistMbid, new Set());
  assert.equal(result.albums.length, 1);
  assert.equal(result.albums[0].provider_id, replacement.providerId);

  const stale = dbModule.db.prepare(`
    SELECT availability, match_status
    FROM ProviderItems
    WHERE provider = 'soundcloud' AND entity_type = 'album' AND provider_id = ?
  `).get(staleId) as { availability: string | null; match_status: string };
  const normalizedStale = dbModule.db.prepare(`
    SELECT availability, availability_reason AS availabilityReason
    FROM ProviderItems
    WHERE provider = 'soundcloud' AND entity_type = 'release' AND provider_id = ?
  `).get(staleId) as { availability: string; availabilityReason: string };
  const staleChild = dbModule.db.prepare(`
    SELECT availability, match_status
    FROM ProviderItems
    WHERE provider = 'soundcloud'
      AND entity_type = 'track'
      AND provider_id = 'stale-child-track'
  `).get() as { availability: string | null; match_status: string };
  assert.deepEqual(stale, { availability: "unavailable", match_status: "rejected" });
  assert.deepEqual(staleChild, { availability: "unavailable", match_status: "rejected" });
  assert.deepEqual(normalizedStale, { availability: "unavailable", availabilityReason: "empty" });
});

test("provider release-group matching passes spatial quality and release disambiguation", () => {
  const artistMbid = "artist-mbid-bastille";
  const releaseGroupMbid = "release-group-mtv-unplugged";

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run(artistMbid, "Bastille");
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(releaseGroupMbid, artistMbid, "MTV Unplugged – Live in London", "Album", "2023-04-22");
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_mbid, artist_mbid, title, disambiguation, status, date, media_count, track_count
    ) VALUES
      (?, ?, ?, ?, NULL, 'Official', '2023-04-22', 1, 15),
      (?, ?, ?, ?, 'Dolby Atmos mix', 'Official', '2023-04-22', 1, 15)
  `).run(
    "normal-digital-release",
    releaseGroupMbid,
    artistMbid,
    "MTV Unplugged – Live in London",
    "dolby-atmos-release",
    releaseGroupMbid,
    artistMbid,
    "MTV Unplugged – Live in London",
  );

  const matches = refreshMatchModule.buildProviderReleaseGroupMatches(
    artistMbid,
    [{
      provider_id: "291445075",
      title: "MTV Unplugged",
      quality: "DOLBY_ATMOS",
      qualityTags: ["DOLBY_ATMOS"],
      release_date: "2023-04-22",
      type: "ALBUM",
      num_tracks: 15,
      num_volumes: 1,
    }],
  ) as Map<string, any>;

  const match = matches.get("291445075");
  assert.equal(match?.status, "verified");
  assert.equal(match?.editionMbid, "dolby-atmos-release");
});

test("matched provider release discovery stores normalized facts without publishing a trackless typed edge", () => {
  const artistMbid = "artist-mbid-bastille";
  const album = {
    provider_id: "provider-album-1",
    title: "Doom Days",
    artist_name: "Bastille",
    quality: "LOSSLESS",
  };

  (refreshServiceModule.RefreshArtistService as any).storeProviderAlbumOffers(
    "tidal",
    artistMbid,
    [album],
    new Map([
      [album.provider_id, {
        providerId: album.provider_id,
        status: "verified",
        confidence: 1,
        method: "musicbrainz-release-upc",
        editionMbid: "release-mbid-1",
        releaseGroup: {
          mbid: "release-group-mbid-1",
          title: "Doom Days",
        },
        evidence: {
          providerTitle: "Doom Days",
        },
      }],
    ]),
  );

  const row = dbModule.db.prepare(`
    SELECT artist_mbid, release_group_mbid, edition_mbid, match_status
    FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'album' AND provider_id = ?
  `).get(album.provider_id) as {
    artist_mbid: string | null;
    release_group_mbid: string | null;
    edition_mbid: string | null;
    match_status: string;
  };

  assert.equal(row.artist_mbid, artistMbid);
  assert.equal(row.release_group_mbid, "release-group-mbid-1");
  assert.equal(row.edition_mbid, "release-mbid-1");
  assert.equal(row.match_status, "verified");

  const normalized = dbModule.db.prepare(`
    SELECT id, title, availability
    FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'release' AND provider_id = ?
  `).get(album.provider_id) as { id: number; title: string; availability: string };
  assert.deepEqual(
    { title: normalized.title, availability: normalized.availability },
    { title: "Doom Days", availability: "available" },
  );
  const typedMatchCount = dbModule.db.prepare(`
    SELECT COUNT(*) AS count
    FROM ProviderEditionMatches
    WHERE provider_edition_item_id = ?
  `).get(normalized.id) as { count: number };
  assert.equal(typedMatchCount.count, 0);
});

test("matched provider offers persist the best compatible MusicBrainz release version", () => {
  const artistMbid = "artist-mbid-bastille";
  const releaseGroupMbid = "release-group-gmtf";
  const standardReleaseMbid = "release-gmtf-standard";
  const expandedReleaseMbid = "release-gmtf-expanded";
  const album = {
    provider_id: "tidal-expanded",
    title: "Give Me The Future + Dreams Of The Past",
    artist_name: "Bastille",
    quality: "HIRES_LOSSLESS",
  };

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run(artistMbid, "Bastille");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run(artistMbid, "Bastille", artistMbid);
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(releaseGroupMbid, artistMbid, "Give Me the Future", "Album", "2022-02-04");
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_mbid, artist_mbid, title, status, country, date, media_count, track_count
    ) VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    standardReleaseMbid,
    releaseGroupMbid,
    artistMbid,
    "Give Me the Future",
    "Official",
    JSON.stringify(["XW"]),
    "2022-02-04",
    1,
    13,
    expandedReleaseMbid,
    releaseGroupMbid,
    artistMbid,
    "Give Me the Future + Dreams of the Past",
    "Official",
    JSON.stringify(["XW"]),
    "2022-08-26",
    3,
    27,
  );

  (refreshServiceModule.RefreshArtistService as any).storeProviderAlbumOffers(
    "tidal",
    artistMbid,
    [album],
    new Map([
      [album.provider_id, {
        providerId: album.provider_id,
        status: "verified",
        confidence: 1,
        method: "musicbrainz-release-group-title-year-type-track-count",
        editionMbid: null,
        releaseGroup: {
          mbid: releaseGroupMbid,
          title: "Give Me the Future",
        },
        evidence: {
          providerTitle: "Give Me The Future + Dreams Of The Past",
          availableReleaseMbids: [standardReleaseMbid, expandedReleaseMbid],
        },
      }],
    ]),
  );

  const row = dbModule.db.prepare(`
    SELECT release_group_mbid, edition_mbid, match_status
    FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'album' AND provider_id = ?
  `).get(album.provider_id) as {
    release_group_mbid: string | null;
    edition_mbid: string | null;
    match_status: string;
  };

  assert.equal(row.release_group_mbid, releaseGroupMbid);
  assert.equal(row.edition_mbid, expandedReleaseMbid);
  assert.equal(row.match_status, "verified");
});

test("public remote catalog hydrates missing video offers without provider authentication", async () => {
  const artistMbid = "11111111-1111-4111-8111-111111111111";
  const providerArtistId = "fake-video-artist";
  let videoFetches = 0;
  let fakeProviderEnabled = false;

  providersModule.streamingProviderManager.registerStreamingProvider({
    id: "fake-video-provider",
    name: "Fake Video Provider",
    capabilities: {
      catalogSearch: true,
      artistCatalog: true,
      followedArtists: false,
      audioPreviews: false,
      audioDownloads: false,
      lossyStereo: false,
      losslessStereo: false,
      hiResStereo: false,
      spatialAudio: false,
      lyrics: false,
      musicVideos: true,
      videoPreviews: true,
      videoDownloads: true,
      artwork: true,
      editorialMetadata: false,
      providerIds: true,
    },
    isAuthenticated: () => fakeProviderEnabled,
    search: async () => ({ artists: [], albums: [], tracks: [], videos: [] }),
    getArtist: async () => ({ providerId: providerArtistId, name: "Video Artist" }),
    getArtistAlbums: async () => [],
    getAlbum: async () => {
      throw new Error("not used");
    },
    getAlbumTracks: async () => [],
    getTrack: async () => {
      throw new Error("not used");
    },
    getArtistVideos: async (id) => {
      assert.equal(id, providerArtistId);
      videoFetches += 1;
      return [{
        providerId: "fake-video-1",
        title: "Fresh Path Video",
        artist: { providerId: providerArtistId, name: "Video Artist" },
        duration: 184,
        releaseDate: "2024-01-02",
        cover: "fake-video-cover",
        quality: "MP4_1080P",
        url: "https://example.test/video/fake-video-1",
      }];
    },
    getAuthStatus: async () => ({
      connected: true,
      tokenExpired: false,
      refreshTokenExpired: false,
      hoursUntilExpiry: 24,
      canAccessShell: true,
      canAccessLocalLibrary: false,
      remoteCatalogAvailable: true,
      canAuthenticate: true,
    }),
  });

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run(artistMbid, "Video Artist");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid, monitored, last_scanned) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)")
    .run("artist-local", "Video Artist", artistMbid, 1);
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES (?, 'artist', ?, ?)
  `).run( "fake-video-provider", providerArtistId, "Video Artist" );

  try {
    await refreshServiceModule.RefreshArtistService.matchArtistProviders(
      "artist-local",
      artistMbid,
      {},
      false,
    );
  } finally {
    fakeProviderEnabled = false;
  }

  const row = dbModule.db.prepare(`
    SELECT provider, provider_id, entity_type, artist_mbid, recording_id
    FROM ProviderItems
    WHERE provider = ? AND entity_type = 'video' AND provider_id = ?
  `).get("fake-video-provider", "fake-video-1") as {
    provider: string;
    provider_id: string;
    entity_type: string;
    artist_mbid: string;
    recording_id: number | null;
  } | undefined;

  assert.equal(videoFetches, 1);
  assert.ok(row);
  assert.equal(row.artist_mbid, artistMbid);
  assert.ok(row.recording_id);
});



