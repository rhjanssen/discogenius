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

function seedCanonicalArtistForRefresh(options: {
  artistId: string;
  artistMbid: string;
  lastScanned: string;
}): void {
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, 'Refresh Failure Artist')
  `).run(options.artistMbid);
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, monitored, last_scanned)
    VALUES (?, 'Refresh Failure Artist', ?, 1, ?)
  `).run(options.artistId, options.artistMbid, options.lastScanned);
}

function seedSoundCloudMixtapeCatalog() {
  const artistMbid = "7808accb-6395-4b25-858c-678bbb73896b";
  const releaseGroupMbid = "375227dd-11c1-4fec-afc0-f4c37a6de604";
  const releaseMbid = "b8f50118-3d3c-4826-a4b3-cf6228a97515";
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run(artistMbid, "Bastille");
  const releaseGroup = dbModule.db.prepare(`
    INSERT INTO Albums (
      mbid, artist_mbid, title, primary_type, secondary_types, first_release_date
    ) VALUES (?, ?, ?, 'EP', ?, '2012-02-17')
    RETURNING id
  `).get(
    releaseGroupMbid,
    artistMbid,
    "Other People's Heartache",
    JSON.stringify(["Mixtape/Street"]),
  ) as { id: number };
  const edition = dbModule.db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_id, release_group_mbid, artist_mbid, title,
      status, date, media_count, track_count
    ) VALUES (?, ?, ?, ?, ?, 'Official', '2012-02-17', 1, 2)
    RETURNING id
  `).get(
    releaseMbid,
    releaseGroup.id,
    releaseGroupMbid,
    artistMbid,
    "Other People's Heartache",
  ) as { id: number };
  const canonicalTracks = [
    { id: "sc-track-mbid-1", recording: "sc-recording-mbid-1", title: "Adagio for Strings", duration: 239 },
    { id: "sc-track-mbid-2", recording: "sc-recording-mbid-2", title: "Falling", duration: 225 },
  ];
  canonicalTracks.forEach((track, index) => {
    const recording = dbModule.db.prepare(`
      INSERT INTO Recordings (mbid, artist_mbid, title, length_ms)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `).get(track.recording, artistMbid, track.title, track.duration * 1000) as { id: number };
    dbModule.db.prepare(`
      INSERT INTO Tracks (
        mbid, album_edition_id, recording_id, recording_mbid, release_mbid,
        title, length_ms, medium_position, position, number
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      track.id,
      edition.id,
      recording.id,
      track.recording,
      releaseMbid,
      track.title,
      track.duration * 1000,
      index + 1,
      String(index + 1),
    );
  });
  return {
    artistMbid,
    releaseGroupMbid,
    releaseMbid,
    editionId: edition.id,
    canonicalTracks,
  };
}

function linkSoundCloudPlaylistOffer(options: {
  providerAlbumId: string;
  editionId: number;
  matchState?: "candidate" | "accepted";
}): number {
  const item = dbModule.db.prepare(`
    SELECT id
    FROM ProviderItems
    WHERE provider = 'soundcloud'
      AND entity_type = 'release'
      AND provider_id = ?
  `).get(options.providerAlbumId) as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, 'overlap', ?, 'automatic', 0.85, ?, 1)
  `).run(
    item.id,
    options.editionId,
    options.matchState ?? "accepted",
    "playlist-tracklist-coverage",
  );
  return item.id;
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

test("required canonical sync failure rejects without stamping success or matching providers", async () => {
  const artistId = "artist-canonical-sync-failure";
  const artistMbid = "11111111-1111-4111-8111-111111111111";
  const initialLastScanned = "2001-02-03 04:05:06";
  seedCanonicalArtistForRefresh({ artistId, artistMbid, lastScanned: initialLastScanned });

  const { servarrMetadata } = await import("../metadata/servarr-metadata.js");
  const service = refreshServiceModule.RefreshArtistService as any;
  const providerManager = providersModule.streamingProviderManager as any;
  const originalRefreshArtistMetadata = service.refreshArtistMetadata;
  const originalMatchArtistProviders = service.matchArtistProviders;
  const originalSyncArtist = servarrMetadata.syncArtist;
  const originalGetProviderPriority = providerManager.getProviderPriority;
  let providerMatchCalls = 0;

  service.refreshArtistMetadata = async () => undefined;
  service.matchArtistProviders = async () => {
    providerMatchCalls += 1;
  };
  servarrMetadata.syncArtist = async () => {
    throw new Error("required canonical artist sync failed");
  };
  providerManager.getProviderPriority = () => [];

  try {
    await assert.rejects(
      () => refreshServiceModule.RefreshArtistService.refreshArtist(artistId, { forceUpdate: true }),
      /required canonical artist sync failed/,
    );
  } finally {
    service.refreshArtistMetadata = originalRefreshArtistMetadata;
    service.matchArtistProviders = originalMatchArtistProviders;
    servarrMetadata.syncArtist = originalSyncArtist;
    providerManager.getProviderPriority = originalGetProviderPriority;
  }

  const artist = dbModule.db.prepare("SELECT last_scanned FROM Artists WHERE id = ?")
    .get(artistId) as { last_scanned: string | null };
  assert.equal(artist.last_scanned, initialLastScanned);
  assert.equal(providerMatchCalls, 0);
});

test("required scoped release hydration failure rejects before provider matching and preserves watermark", async () => {
  const artistId = "artist-release-hydration-failure";
  const artistMbid = "22222222-2222-4222-8222-222222222222";
  const releaseGroupMbid = "33333333-3333-4333-8333-333333333333";
  const initialLastScanned = "2002-03-04 05:06:07";
  seedCanonicalArtistForRefresh({ artistId, artistMbid, lastScanned: initialLastScanned });
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title)
    VALUES (?, ?, 'Release Hydration Failure Album')
  `).run(releaseGroupMbid, artistMbid);

  const { servarrMetadata } = await import("../metadata/servarr-metadata.js");
  const service = refreshServiceModule.RefreshArtistService as any;
  const providerManager = providersModule.streamingProviderManager as any;
  const originalRefreshArtistMetadata = service.refreshArtistMetadata;
  const originalSyncArtistMusicBrainzCatalog = service.syncArtistMusicBrainzCatalog;
  const originalMatchArtistProviders = service.matchArtistProviders;
  const originalSyncArtistReleaseGroups = servarrMetadata.syncArtistReleaseGroups;
  const originalGetProviderPriority = providerManager.getProviderPriority;
  let providerMatchCalls = 0;

  service.refreshArtistMetadata = async () => undefined;
  service.syncArtistMusicBrainzCatalog = async () => artistMbid;
  service.matchArtistProviders = async () => {
    providerMatchCalls += 1;
  };
  servarrMetadata.syncArtistReleaseGroups = async () => {
    throw new Error("required scoped release hydration failed");
  };
  providerManager.getProviderPriority = () => [];

  try {
    await assert.rejects(
      () => refreshServiceModule.RefreshArtistService.refreshArtist(artistId, { forceUpdate: true }),
      /required scoped release hydration failed/,
    );
  } finally {
    service.refreshArtistMetadata = originalRefreshArtistMetadata;
    service.syncArtistMusicBrainzCatalog = originalSyncArtistMusicBrainzCatalog;
    service.matchArtistProviders = originalMatchArtistProviders;
    servarrMetadata.syncArtistReleaseGroups = originalSyncArtistReleaseGroups;
    providerManager.getProviderPriority = originalGetProviderPriority;
  }

  const artist = dbModule.db.prepare("SELECT last_scanned FROM Artists WHERE id = ?")
    .get(artistId) as { last_scanned: string | null };
  assert.equal(artist.last_scanned, initialLastScanned);
  assert.equal(providerMatchCalls, 0);
});

test("unmatched provider offers persist native facts without claiming canonical ownership", () => {
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
    SELECT id, title, availability
    FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'release' AND provider_id = ?
  `).get(album.provider_id) as {
    id: number;
    title: string;
    availability: string;
  };
  const directMatchCount = dbModule.db.prepare(`
    SELECT COUNT(*) AS count
    FROM ProviderEditionMatches
    WHERE provider_edition_item_id = ?
  `).get(row.id) as { count: number };

  assert.deepEqual(
    { title: row.title, availability: row.availability },
    { title: "Happier", availability: "available" },
  );
  assert.equal(directMatchCount.count, 0);
});

test("hybrid candidates do not publish canonical ownership without a typed edition edge", () => {
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
      releaseMbid: "release-mbid-candidate",
      releaseGroup: {
        mbid: "release-group-mbid-candidate",
        title: "Canonical album",
      },
      evidence: { isrcOverlap: 1 },
    }]]),
  );

  const offer = dbModule.db.prepare(`
    SELECT id, title, availability
    FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'release' AND provider_id = ?
  `).get(album.provider_id) as { id: number; title: string; availability: string };
  const directMatchCount = dbModule.db.prepare(`
    SELECT COUNT(*) AS count
    FROM ProviderEditionMatches match
    JOIN ProviderItems item ON item.id = match.provider_edition_item_id
    WHERE item.provider = 'tidal'
      AND item.entity_type = 'release'
      AND item.provider_id = ?
  `).get(album.provider_id) as { count: number };

  assert.equal(offer.title, "Partial provider edition");
  assert.equal(offer.availability, "available");
  assert.equal(directMatchCount.count, 0);
});

test("stored SoundCloud playlist coverage is revalidated and its permalink is backfilled", async () => {
  const { artistMbid, editionId, canonicalTracks } = seedSoundCloudMixtapeCatalog();
  const providerAlbumId = "220003151";
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('soundcloud', 'release', ?, ?)
  `).run( providerAlbumId, "Other People's Heartache part 1" );
  linkSoundCloudPlaylistOffer({ providerAlbumId, editionId });

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
    SELECT item.provider_url, item.availability, release_match.match_state
    FROM ProviderItems item
    JOIN ProviderEditionMatches release_match
      ON release_match.provider_edition_item_id = item.id
     AND release_match.edition_id = ?
    WHERE item.provider = 'soundcloud'
      AND item.entity_type = 'release'
      AND item.provider_id = ?
  `).get(editionId, providerAlbumId) as {
    provider_url: string | null;
    availability: string | null;
    match_state: string;
  };
  assert.equal(stored.provider_url, album.url);
  assert.equal(stored.availability, "available");
  assert.equal(stored.match_state, "accepted");
});

test("all durable SoundCloud playlist offers are revalidated after the first valid one", async () => {
  const { artistMbid, editionId, canonicalTracks } = seedSoundCloudMixtapeCatalog();
  const validId = "110003151";
  const staleId = "220003151";
  const insertOffer = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, availability, updated_at
    ) VALUES ('soundcloud', 'release', ?, ?, 'available', ?)
  `);
  insertOffer.run(
    validId,
    "Other People's Heartache",
    "2030-01-01 00:00:00",
  );
  insertOffer.run(
    staleId,
    "Other People's Heartache",
    "2020-01-01 00:00:00",
  );
  linkSoundCloudPlaylistOffer({ providerAlbumId: validId, editionId });
  linkSoundCloudPlaylistOffer({ providerAlbumId: staleId, editionId });

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
    SELECT item.availability, release_match.match_state
    FROM ProviderItems item
    JOIN ProviderEditionMatches release_match
      ON release_match.provider_edition_item_id = item.id
     AND release_match.edition_id = ?
    WHERE item.provider = 'soundcloud'
      AND item.entity_type = 'release'
      AND item.provider_id = ?
  `).get(editionId, staleId);
  assert.deepEqual(stale, { availability: "unavailable", match_state: "rejected" });
});

test("empty stored SoundCloud playlist is rejected and a covering replacement is selected", async () => {
  const { artistMbid, editionId, canonicalTracks } = seedSoundCloudMixtapeCatalog();
  const staleId = "220003151";
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('soundcloud', 'release', ?, ?)
  `).run( staleId, "Other People's Heartache" );
  const staleReleaseItemId = linkSoundCloudPlaylistOffer({ providerAlbumId: staleId, editionId });
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, availability
    ) VALUES ('soundcloud', 'track', 'stale-child-track', 'Stale Track', 'available')
  `).run();
  const staleTrackItem = dbModule.db.prepare(`
    SELECT id
    FROM ProviderItems
    WHERE provider = 'soundcloud'
      AND entity_type = 'track'
      AND provider_id = 'stale-child-track'
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderEditionMembers (
      provider_edition_item_id, member_item_id, medium_position, position
    ) VALUES (?, ?, 1, 1)
  `).run(staleReleaseItemId, staleTrackItem.id);
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
    SELECT item.availability, release_match.match_state
    FROM ProviderItems item
    JOIN ProviderEditionMatches release_match
      ON release_match.provider_edition_item_id = item.id
     AND release_match.edition_id = ?
    WHERE item.provider = 'soundcloud'
      AND item.entity_type = 'release'
      AND item.provider_id = ?
  `).get(editionId, staleId) as { availability: string | null; match_state: string };
  const normalizedStale = dbModule.db.prepare(`
    SELECT availability, availability_reason AS availabilityReason
    FROM ProviderItems
    WHERE provider = 'soundcloud' AND entity_type = 'release' AND provider_id = ?
  `).get(staleId) as { availability: string; availabilityReason: string };
  const staleChild = dbModule.db.prepare(`
    SELECT availability, availability_reason AS availabilityReason
    FROM ProviderItems
    WHERE provider = 'soundcloud'
      AND entity_type = 'track'
      AND provider_id = 'stale-child-track'
  `).get() as { availability: string | null; availabilityReason: string };
  assert.deepEqual(stale, { availability: "unavailable", match_state: "rejected" });
  assert.deepEqual(staleChild, { availability: "unavailable", availabilityReason: "empty" });
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
  assert.equal(match?.releaseMbid, "dolby-atmos-release");
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
        releaseMbid: "release-mbid-1",
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
    SELECT id, title, availability
    FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'release' AND provider_id = ?
  `).get(album.provider_id) as {
    id: number;
    title: string;
    availability: string;
  };

  assert.deepEqual(
    { title: row.title, availability: row.availability },
    { title: "Doom Days", availability: "available" },
  );
  const typedMatchCount = dbModule.db.prepare(`
    SELECT COUNT(*) AS count
    FROM ProviderEditionMatches
    WHERE provider_edition_item_id = ?
  `).get(row.id) as { count: number };
  assert.equal(typedMatchCount.count, 0);
});

test("release-group-only provider evidence does not leak a guessed MusicBrainz edition onto native facts", () => {
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
        releaseMbid: null,
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
    SELECT id, title, availability
    FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'release' AND provider_id = ?
  `).get(album.provider_id) as {
    id: number;
    title: string;
    availability: string;
  };
  const typedMatchCount = dbModule.db.prepare(`
    SELECT COUNT(*) AS count
    FROM ProviderEditionMatches
    WHERE provider_edition_item_id = ?
  `).get(row.id) as { count: number };
  assert.equal(row.title, "Give Me The Future + Dreams Of The Past");
  assert.equal(row.availability, "available");
  assert.equal(typedMatchCount.count, 0);
});

test("public remote catalog caches unmatched video offers without inventing recordings", async () => {
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

  const canonicalArtist = dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
    RETURNING id
  `).get(artistMbid, "Video Artist") as { id: number };
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid, monitored, last_scanned) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)")
    .run("artist-local", "Video Artist", artistMbid, 1);
  const providerArtist = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES (?, 'artist', ?, ?)
    RETURNING id
  `).get( "fake-video-provider", providerArtistId, "Video Artist" ) as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderArtistMatches (
      provider_artist_item_id, artist_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'accepted', 'manual', 1, 'test', 1)
  `).run(providerArtist.id, canonicalArtist.id);

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
    SELECT
      item.provider,
      item.provider_id,
      item.entity_type,
      item.title
    FROM ProviderItems item
    WHERE item.provider = ? AND item.entity_type = 'video' AND item.provider_id = ?
  `).get("fake-video-provider", "fake-video-1") as {
    provider: string;
    provider_id: string;
    entity_type: string;
    title: string;
  } | undefined;

  assert.equal(videoFetches, 1);
  assert.ok(row);
  assert.equal(row.title, "Fresh Path Video");
  assert.equal(
    (dbModule.db.prepare(`
      SELECT COUNT(*) AS count
      FROM ProviderItems item
      JOIN ProviderVideoMatches video_match
        ON video_match.provider_video_item_id = item.id
       AND video_match.match_state = 'accepted'
      WHERE item.provider = ? AND item.entity_type = 'video' AND item.provider_id = ?
    `).get("fake-video-provider", "fake-video-1") as { count: number }).count,
    0,
  );
  assert.equal(
    (dbModule.db.prepare(`
      SELECT COUNT(*) AS count
      FROM Recordings
      WHERE artist_mbid = ? AND is_video = 1
    `).get(artistMbid) as { count: number }).count,
    0,
  );
});



