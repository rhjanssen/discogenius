import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { AlbumRefreshLevel } from "./scan-types.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-refresh-album-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let refreshServiceModule: typeof import("./refresh-album-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  refreshServiceModule = await import("./refresh-album-service.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM Tracks").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM AlbumEditions").run();
  dbModule.db.prepare("DELETE FROM Albums").run();
  dbModule.db.prepare("DELETE FROM Artists").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("artist album upsert stores allowed provider supplements on catalog album and release rows", async () => {
  const artistMbid = "7808accb-6395-4b25-858c-678bbb73896b";
  const releaseGroupMbid = "11111111-1111-4111-8111-111111111111";
  const releaseMbid = "22222222-2222-4222-8222-222222222222";

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run(artistMbid, "Bastille");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)").run(artistMbid, "Bastille", artistMbid);
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, ?)").run(releaseGroupMbid, artistMbid, "Canonical Album", "album");
  dbModule.db.prepare("INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, status) VALUES (?, ?, ?, ?, ?)").run(releaseMbid, releaseGroupMbid, artistMbid, "Canonical Album", "Official");

  await refreshServiceModule.RefreshAlbumService.upsertArtistAlbum(
    {
      provider_id: "provider-album-supplements",
      artist_id: "provider-artist",
      artist_name: "Bastille",
      title: "Canonical Album",
      version: null,
      release_date: "2024-02-03",
      type: "ALBUM",
      explicit: false,
      quality: "LOSSLESS",
      cover: "provider-cover-id",
      vibrant_color: "#112233",
      video_cover: "provider-video-cover-id",
      num_tracks: 1,
      num_volumes: 1,
      num_videos: 1,
      duration: 180,
      popularity: 47,
      copyright: "(P) 2024 Example",
      upc: "123456789012",
      _mb_artist_mbid: artistMbid,
      _mb_release_group_match: {
        providerId: "provider-album-supplements",
        status: "verified",
        confidence: 1,
        method: "test",
        releaseMbid,
        releaseGroup: {
          mbid: releaseGroupMbid,
          title: "Canonical Album",
          primaryType: "Album",
          releases: [{ mbid: releaseMbid, title: "Canonical Album" }],
        },
        evidence: {
          providerTitle: "Canonical Album",
          matchedReleaseMbid: releaseMbid,
        },
      },
    },
    artistMbid,
    new Map(),
    { resolveMusicBrainz: false },
  );

  const album = dbModule.db.prepare(`
    SELECT cover_image_id, vibrant_color, video_cover, popularity
    FROM Albums
    WHERE mbid = ?
  `).get(releaseGroupMbid) as {
    cover_image_id: string | null;
    vibrant_color: string | null;
    video_cover: string | null;
    popularity: number | null;
  };
  assert.equal(album.cover_image_id, "provider-cover-id");
  assert.equal(album.vibrant_color, "#112233");
  assert.equal(album.video_cover, "provider-video-cover-id");
  assert.equal(album.popularity, 47);

  const release = dbModule.db.prepare("SELECT barcode, copyright FROM AlbumEditions WHERE mbid = ?").get(releaseMbid) as {
    barcode: string | null;
    copyright: string | null;
  };
  assert.equal(release.barcode, null);
  assert.equal(release.copyright, "(P) 2024 Example");

  const item = dbModule.db.prepare("SELECT upc FROM ProviderItems WHERE provider = 'tidal' AND entity_type = 'release' AND provider_id = ?")
    .get("provider-album-supplements") as { upc: string | null };
  assert.equal(item.upc, "123456789012");
  
  const albumRow = dbModule.db.prepare("SELECT video_cover FROM Albums WHERE mbid = ?").get(releaseGroupMbid) as { video_cover: string | null };
  assert.equal(albumRow.video_cover, "provider-video-cover-id");
});

test("providerAlbumToAlbumMetadataRow keeps animated videoCover for catalog supplements", () => {
  const mapped = refreshServiceModule.providerAlbumToAlbumMetadataRow({
    providerId: "1440904699",
    title: "Motion Art Album",
    artist: { providerId: "1", name: "Artist" },
    cover: "still-cover-id",
    videoCover: "https://example.test/editorial-motion.m3u8",
    trackCount: 10,
  });

  assert.equal(mapped.cover, "still-cover-id");
  assert.equal(mapped.video_cover, "https://example.test/editorial-motion.m3u8");
  assert.equal(mapped.videoCover, "https://example.test/editorial-motion.m3u8");
});

test("providerAlbumToAlbumMetadataRow preserves tri-state explicitness and qualityTags", () => {
  const dummyArtist = { providerId: "artist-1", name: "Test Artist" };

  const nullExplicit = refreshServiceModule.providerAlbumToAlbumMetadataRow({
    providerId: "1", title: "Null Explicit Album", artist: dummyArtist, explicit: null,
  });
  assert.equal(nullExplicit.explicit, null);

  const undefinedExplicitNoRaw = refreshServiceModule.providerAlbumToAlbumMetadataRow({
    providerId: "2", title: "Undefined Explicit Album", artist: dummyArtist,
  });
  assert.equal(undefinedExplicitNoRaw.explicit, null);

  const undefinedExplicitWithRawFalse = refreshServiceModule.providerAlbumToAlbumMetadataRow({
    providerId: "3", title: "Raw Clean Album", artist: dummyArtist, raw: { provider_id: "3", explicit: false },
  });
  assert.equal(undefinedExplicitWithRawFalse.explicit, false);

  const falseExplicit = refreshServiceModule.providerAlbumToAlbumMetadataRow({
    providerId: "4", title: "Clean Album", artist: dummyArtist, explicit: false,
  });
  assert.equal(falseExplicit.explicit, false);

  const trueExplicit = refreshServiceModule.providerAlbumToAlbumMetadataRow({
    providerId: "5", title: "Explicit Album", artist: dummyArtist, explicit: true,
  });
  assert.equal(trueExplicit.explicit, true);

  const appleQualityTags = refreshServiceModule.providerAlbumToAlbumMetadataRow({
    providerId: "6", title: "Apple Album", artist: dummyArtist, qualityTags: ["LOSSLESS", "DOLBY_ATMOS"],
  });
  assert.deepEqual(appleQualityTags.qualityTags, ["LOSSLESS", "DOLBY_ATMOS"]);
});

test("album track scan stores provider track offers linked to the selected canonical release tracks", async () => {
  const { streamingProviderManager } = await import("../providers/index.js");
  const artistMbid = "7808accb-6395-4b25-858c-678bbb73896b";
  const releaseGroupMbid = "11111111-1111-4111-8111-111111111111";
  const releaseMbid = "22222222-2222-4222-8222-222222222222";
  const recordingMbid = "33333333-3333-4333-8333-333333333333";
  const trackMbid = "44444444-4444-4444-8444-444444444444";

  streamingProviderManager.registerStreamingProvider({
    id: "fake",
    name: "Fake provider",
    capabilities: {
      catalogSearch: true,
      artistCatalog: true,
      followedArtists: false,
      audioPreviews: false,
      audioDownloads: true,
      lossyStereo: true,
      losslessStereo: true,
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
    async search() { return { artists: [], albums: [], tracks: [], videos: [] }; },
    async getArtist() { throw new Error("not used"); },
    async getArtistAlbums() { return []; },
    async getAlbum() { throw new Error("not used"); },
    async getTrack() { throw new Error("not used"); },
    async getAlbumTracks() {
      return [{
        providerId: "provider-track-1",
        title: "Track One",
        duration: 180,
        trackNumber: 1,
        volumeNumber: 1,
        isrc: "USABC240001",
        copyright: "(P) 2024 Track",
        replayGain: -8.4,
        peak: 0.97,
        popularity: 56,
        quality: "LOSSLESS",
        url: "https://example.test/tracks/provider-track-1",
        artist: { providerId: "fake-artist", name: "Bastille" },
        // Raw provider payloads can use their own field casing. The normalized
        // provider DTO above remains authoritative for loudness supplements.
        raw: {
          provider_id: "provider-track-1",
          title: "Track One",
          duration: 180,
          track_number: 1,
          volume_number: 1,
          isrc: "USABC240001",
          copyright: "(P) 2024 Track",
          popularity: 56,
          quality: "LOSSLESS",
          artist_id: "fake-artist",
          artist_name: "Bastille",
        },
      } as any];
    },
    async getAuthStatus() {
      return {
        connected: true,
        tokenExpired: false,
        refreshTokenExpired: false,
        hoursUntilExpiry: 24,
        canAccessShell: true,
        canAccessLocalLibrary: true,
        remoteCatalogAvailable: true,
        canAuthenticate: false,
      };
    },
  });

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run(artistMbid, "Bastille");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid, monitored) VALUES (?, ?, ?, 1)").run(artistMbid, "Bastille", artistMbid);
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, ?)").run(releaseGroupMbid, artistMbid, "Canonical Album", "album");
  dbModule.db.prepare("INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, status, media) VALUES (?, ?, ?, ?, ?, ?)").run(
    releaseMbid,
    releaseGroupMbid,
    artistMbid,
    "Canonical Album",
    "Official",
    JSON.stringify([{ Position: 1, Format: "Digital Media", TrackCount: 1 }]),
  );
  dbModule.db.prepare("INSERT INTO Recordings (mbid, artist_mbid, title) VALUES (?, ?, ?)").run(recordingMbid, artistMbid, "Track One");
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title)
    VALUES (?, ?, ?, 1, 1, '1', ?)
  `).run(trackMbid, releaseMbid, recordingMbid, "Track One");
  const providerEditionItemId = (dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, provider_type, availability
    ) VALUES ('fake', 'release', ?, ?, 'ALBUM', 'available')
    RETURNING id
  `).get("provider-album-1", "Provider Album") as { id: number }).id;
  const canonicalReleaseId = (dbModule.db.prepare(`
    SELECT id FROM AlbumEditions WHERE mbid = ?
  `).get(releaseMbid) as { id: number }).id;
  dbModule.db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'exact', 'accepted', 'manual', 1, 'test', 1)
  `).run(providerEditionItemId, canonicalReleaseId);

  await refreshServiceModule.RefreshAlbumService.refreshTracks("provider-album-1", {
    provider: "fake",
    resolveMusicBrainz: false,
  });

  const offer = dbModule.db.prepare(`
    SELECT provider, entity_type, provider_id, isrc, copyright,
           replay_gain, peak, provider_url
    FROM ProviderItems
    WHERE provider = 'fake' AND entity_type = 'track' AND provider_id = 'provider-track-1'
  `).get() as any;

  assert.equal(offer.isrc, "USABC240001");
  assert.equal(offer.copyright, "(P) 2024 Track");
  // replay_gain/peak are provider-only facts and live on the ProviderItems
  // track offer, not the canonical MusicBrainz Recording.
  assert.equal(offer.replay_gain, -8.4);
  assert.equal(offer.peak, 0.97);
  assert.equal(offer.provider_url, "https://example.test/tracks/provider-track-1");

  const recording = dbModule.db.prepare("SELECT copyright, popularity, isrcs FROM Recordings WHERE mbid = ?")
    .get(recordingMbid) as { copyright: string | null; popularity: number | null; isrcs: string | null };
  assert.equal(recording.copyright, "(P) 2024 Track");
  assert.equal(recording.popularity, 56);
  assert.equal(recording.isrcs, null);

  assert.deepEqual(
    dbModule.db.prepare(`
      SELECT
        release_item.provider_id AS provider_release_id,
        release_match.relation,
        release_match.match_state,
        track_item.provider_id AS provider_track_id,
        track_match.track_id,
        track_match.recording_id
      FROM ProviderEditionMatches release_match
      JOIN ProviderItems release_item
        ON release_item.id = release_match.provider_edition_item_id
      JOIN ProviderTrackMatches track_match
        ON track_match.provider_edition_match_id = release_match.id
       AND track_match.match_state = 'accepted'
      JOIN ProviderEditionMembers member
        ON member.id = track_match.provider_edition_member_id
      JOIN ProviderItems track_item ON track_item.id = member.member_item_id
      WHERE release_item.provider = 'fake'
        AND release_item.entity_type = 'release'
        AND release_item.provider_id = 'provider-album-1'
    `).get(),
    {
      provider_release_id: "provider-album-1",
      relation: "exact",
      match_state: "accepted",
      provider_track_id: "provider-track-1",
      track_id: (dbModule.db.prepare("SELECT id FROM Tracks WHERE mbid = ?").get(trackMbid) as { id: number }).id,
      recording_id: (dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = ?").get(recordingMbid) as { id: number }).id,
    },
    "Live refresh must materialize normalized membership and typed match edges",
  );
});

test("SoundCloud playlist tracks map to canonical identity by title and duration, not playlist order", async () => {
  const artistMbid = "7808accb-6395-4b25-858c-678bbb73896b";
  const releaseGroupMbid = "71111111-1111-4111-8111-111111111111";
  const releaseMbid = "72222222-2222-4222-8222-222222222222";
  const firstRecordingMbid = "73333333-3333-4333-8333-333333333333";
  const secondRecordingMbid = "74444444-4444-4444-8444-444444444444";
  const firstTrackMbid = "75555555-5555-4555-8555-555555555555";
  const secondTrackMbid = "76666666-6666-4666-8666-666666666666";

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run(artistMbid, "Bastille");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)").run(artistMbid, "Bastille", artistMbid);
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, 'album')")
    .run(releaseGroupMbid, artistMbid, "Other People's Heartache");
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, status)
    VALUES (?, ?, ?, ?, 'Official')
  `).run(releaseMbid, releaseGroupMbid, artistMbid, "Other People's Heartache");
  dbModule.db.prepare("INSERT INTO Recordings (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run(firstRecordingMbid, artistMbid, "First Song");
  dbModule.db.prepare("INSERT INTO Recordings (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run(secondRecordingMbid, artistMbid, "Second Song");
  dbModule.db.prepare(`
    INSERT INTO Tracks (
      mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
  `).run(firstTrackMbid, releaseMbid, firstRecordingMbid, 1, "1", "First Song", 180000);
  dbModule.db.prepare(`
    INSERT INTO Tracks (
      mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
  `).run(secondTrackMbid, releaseMbid, secondRecordingMbid, 2, "2", "Second Song", 200000);
  await refreshServiceModule.RefreshAlbumService.storeProviderTrackOffers(
    "soundcloud",
    "sc-playlist",
    [
      {
        provider_id: "sc-second",
        title: "Second Song",
        duration: 200,
        track_number: 1,
        volume_number: 1,
        url: "https://soundcloud.com/example/second-song",
      },
      {
        provider_id: "sc-first",
        title: "First Song",
        duration: 180,
        track_number: 2,
        volume_number: 1,
        url: "https://soundcloud.com/example/first-song",
      },
    ],
    null,
    releaseMbid,
  );

  const offers = dbModule.db.prepare(`
    SELECT
      item.provider_id,
      track.mbid AS track_mbid,
      recording.mbid AS recording_mbid,
      track_match.match_state,
      track_match.method AS match_method,
      item.availability
    FROM ProviderItems release_item
    JOIN ProviderEditionMatches release_match
      ON release_match.provider_edition_item_id = release_item.id
    JOIN ProviderEditionMembers member
      ON member.provider_edition_item_id = release_item.id
    JOIN ProviderItems item ON item.id = member.member_item_id
    LEFT JOIN ProviderTrackMatches track_match
      ON track_match.provider_edition_match_id = release_match.id
     AND track_match.provider_edition_member_id = member.id
    LEFT JOIN Tracks track ON track.id = track_match.track_id
    LEFT JOIN Recordings recording ON recording.id = track_match.recording_id
    WHERE release_item.provider = 'soundcloud'
      AND release_item.entity_type = 'release'
      AND release_item.provider_id = 'sc-playlist'
    ORDER BY item.provider_id
  `).all() as Array<Record<string, string | null>>;
  assert.deepEqual(offers, [
    {
      provider_id: "sc-first",
      track_mbid: firstTrackMbid,
      recording_mbid: firstRecordingMbid,
      match_state: "accepted",
      match_method: "title_duration",
      availability: "available",
    },
    {
      provider_id: "sc-second",
      track_mbid: secondTrackMbid,
      recording_mbid: secondRecordingMbid,
      match_state: "accepted",
      match_method: "title_duration",
      availability: "available",
    },
  ]);
});

test("SoundCloud storeProviderTrackOffers drops DRM tracks so they never become plan sources", async () => {
  const artistMbid = "7808accb-6395-4b25-858c-678bbb73896b";
  const releaseGroupMbid = "91111111-1111-4111-8111-111111111119";
  const releaseMbid = "92222222-2222-4222-8222-222222222229";
  const progressiveRecordingMbid = "93333333-3333-4333-8333-333333333339";
  const drmRecordingMbid = "94444444-4444-4444-8444-444444444449";
  const progressiveTrackMbid = "95555555-5555-4555-8555-555555555559";
  const drmTrackMbid = "96666666-6666-4666-8666-666666666669";

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run(artistMbid, "Bastille");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)").run(artistMbid, "Bastille", artistMbid);
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, 'album')")
    .run(releaseGroupMbid, artistMbid, "DRM Filter EP");
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, status)
    VALUES (?, ?, ?, ?, 'Official')
  `).run(releaseMbid, releaseGroupMbid, artistMbid, "DRM Filter EP");
  dbModule.db.prepare("INSERT INTO Recordings (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run(progressiveRecordingMbid, artistMbid, "Progressive Fan Cut");
  dbModule.db.prepare("INSERT INTO Recordings (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run(drmRecordingMbid, artistMbid, "Official DRM Cut");
  dbModule.db.prepare(`
    INSERT INTO Tracks (
      mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
  `).run(progressiveTrackMbid, releaseMbid, progressiveRecordingMbid, 1, "1", "Progressive Fan Cut", 180000);
  dbModule.db.prepare(`
    INSERT INTO Tracks (
      mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
  `).run(drmTrackMbid, releaseMbid, drmRecordingMbid, 2, "2", "Official DRM Cut", 200000);

  await refreshServiceModule.RefreshAlbumService.storeProviderTrackOffers(
    "soundcloud",
    "sc-mixed-drm",
    [
      {
        provider_id: "sc-progressive",
        title: "Progressive Fan Cut",
        duration: 180,
        track_number: 1,
        volume_number: 1,
        policy: "ALLOW",
        media: {
          transcodings: [{
            url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:1/progressive",
            snipped: false,
            format: { protocol: "progressive", mime_type: "audio/mpeg" },
          }],
        },
      },
      {
        provider_id: "sc-drm",
        title: "Official DRM Cut",
        duration: 200,
        track_number: 2,
        volume_number: 1,
        policy: "ALLOW",
        media: {
          transcodings: [{
            url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:2/enc",
            snipped: false,
            format: { protocol: "ctr-encrypted-hls", mime_type: "audio/mp4" },
          }],
        },
      },
    ],
    null,
    releaseMbid,
  );

  const members = dbModule.db.prepare(`
    SELECT item.provider_id, track_match.match_state, track.mbid AS track_mbid
    FROM ProviderItems release_item
    JOIN ProviderEditionMembers member
      ON member.provider_edition_item_id = release_item.id
    JOIN ProviderItems item ON item.id = member.member_item_id
    LEFT JOIN ProviderTrackMatches track_match
      ON track_match.provider_edition_member_id = member.id
     AND track_match.match_state = 'accepted'
    LEFT JOIN Tracks track ON track.id = track_match.track_id
    WHERE release_item.provider = 'soundcloud'
      AND release_item.provider_id = 'sc-mixed-drm'
    ORDER BY item.provider_id
  `).all() as Array<{ provider_id: string; match_state: string | null; track_mbid: string | null }>;

  assert.deepEqual(members.map((row) => row.provider_id), ["sc-progressive"]);
  assert.equal(members[0]?.match_state, "accepted");
  assert.equal(members[0]?.track_mbid, progressiveTrackMbid);
  assert.ok(!members.some((row) => row.provider_id === "sc-drm"));
});

test("same-release provider superset maps exact-duration version tracks and clears stale positional links", async () => {
  const artistMbid = "7808accb-6395-4b25-858c-678bbb73896b";
  const releaseGroupMbid = "81111111-1111-4111-8111-111111111111";
  const releaseMbid = "82222222-2222-4222-8222-222222222222";
  const versions = [
    ["Dave Winnel remix", 245],
    ["Jack Wins remix", 278],
    ["Deluxe mix", 304],
  ] as const;

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run(artistMbid, "Lost Frequencies");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)").run(artistMbid, "Lost Frequencies", artistMbid);
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, 'album')")
    .run(releaseGroupMbid, artistMbid, "Reality");
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, status)
    VALUES (?, ?, ?, 'Reality (Remixes)', 'Official')
  `).run(releaseMbid, releaseGroupMbid, artistMbid);

  const insertRecording = dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title)
    VALUES (?, ?, ?)
  `);
  const insertTrack = dbModule.db.prepare(`
    INSERT INTO Tracks (
      mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
  `);
  const canonical = versions.map(([version, duration], index) => {
    const recordingMbid = `83333333-3333-4333-8333-33333333333${index}`;
    const trackMbid = `84444444-4444-4444-8444-44444444444${index}`;
    const title = `Reality (${version})`;
    insertRecording.run(recordingMbid, artistMbid, title);
    insertTrack.run(trackMbid, releaseMbid, recordingMbid, index + 1, String(index + 1), title, duration * 1000);
    return { recordingMbid, trackMbid };
  });

  await refreshServiceModule.RefreshAlbumService.storeProviderTrackOffers(
    "tidal",
    "52412070",
    [
      { provider_id: "tidal-reality-1", title: "Reality", duration: 180, track_number: 1, volume_number: 1 },
      { provider_id: "tidal-reality-2", title: "Reality", duration: 200, track_number: 2, volume_number: 1 },
      { provider_id: "tidal-reality-3", title: "Reality", duration: 220, track_number: 3, volume_number: 1 },
      ...versions.map(([, duration], index) => ({
        provider_id: `tidal-reality-${index + 4}`,
        title: `Reality (${versions[index][0]})`,
        duration,
        track_number: index + 4,
        volume_number: 1,
      })),
    ],
    null,
    releaseMbid,
  );

  const offers = dbModule.db.prepare(`
    SELECT
      item.provider_id,
      track.mbid AS track_mbid,
      recording.mbid AS recording_mbid,
      track_match.match_state,
      track_match.method AS match_method,
      item.availability
    FROM ProviderItems release_item
    JOIN ProviderEditionMembers member
      ON member.provider_edition_item_id = release_item.id
    JOIN ProviderItems item ON item.id = member.member_item_id
    LEFT JOIN ProviderEditionMatches release_match
      ON release_match.provider_edition_item_id = release_item.id
     AND release_match.match_state = 'accepted'
    LEFT JOIN ProviderTrackMatches track_match
      ON track_match.provider_edition_match_id = release_match.id
     AND track_match.provider_edition_member_id = member.id
    LEFT JOIN Tracks track ON track.id = track_match.track_id
    LEFT JOIN Recordings recording ON recording.id = track_match.recording_id
    WHERE release_item.provider = 'tidal'
      AND release_item.entity_type = 'release'
      AND release_item.provider_id = '52412070'
    ORDER BY item.provider_id
  `).all() as Array<Record<string, string | null>>;

  assert.deepEqual(offers.slice(0, 3), [
    {
      provider_id: "tidal-reality-1",
      track_mbid: null,
      recording_mbid: null,
      match_state: null,
      match_method: null,
      availability: "available",
    },
    {
      provider_id: "tidal-reality-2",
      track_mbid: null,
      recording_mbid: null,
      match_state: null,
      match_method: null,
      availability: "available",
    },
    {
      provider_id: "tidal-reality-3",
      track_mbid: null,
      recording_mbid: null,
      match_state: null,
      match_method: null,
      availability: "available",
    },
  ]);
  assert.deepEqual(
    offers.slice(3).map((offer) => ({
      provider_id: offer.provider_id,
      track_mbid: offer.track_mbid,
      match_state: offer.match_state,
      match_method: offer.match_method,
    })),
    canonical.map((identity, index) => ({
      provider_id: `tidal-reality-${index + 4}`,
      track_mbid: identity.trackMbid,
      match_state: "accepted",
      match_method: "title_duration",
    })),
  );
});

test("album refresh level does not borrow tracks from a colliding provider ID", () => {
  const artistMbid = "7808accb-6395-4b25-858c-678bbb73896b";
  const releaseGroupMbid = "55555555-5555-4555-8555-555555555555";
  const releaseMbid = "66666666-6666-4666-8666-666666666666";

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run(artistMbid, "Bastille");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)").run(artistMbid, "Bastille", artistMbid);
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, review_text)
    VALUES (?, ?, 'Canonical Album', 'album', '')
  `).run(releaseGroupMbid, artistMbid);
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, status)
    VALUES (?, ?, ?, 'Canonical Album', 'Official')
  `).run(releaseMbid, releaseGroupMbid, artistMbid);
  const tidalReleaseId = (dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, availability
    ) VALUES ('tidal', 'release', '42', 'Tidal Album', 'available')
    RETURNING id
  `).get() as { id: number }).id;
  const appleReleaseId = (dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, availability
    ) VALUES ('apple-music', 'release', '42', 'Apple Album', 'available')
    RETURNING id
  `).get() as { id: number }).id;
  const tidalTrackId = (dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, availability
    ) VALUES ('tidal', 'track', 'tidal-track', 'Tidal Track', 'available')
    RETURNING id
  `).get() as { id: number }).id;
  dbModule.db.prepare(`
    INSERT INTO ProviderEditionMembers (
      provider_edition_item_id, member_item_id, medium_position, position
    ) VALUES (?, ?, 1, 1)
  `).run(tidalReleaseId, tidalTrackId);
  const canonicalReleaseId = (dbModule.db.prepare(`
    SELECT id FROM AlbumEditions WHERE mbid = ?
  `).get(releaseMbid) as { id: number }).id;
  dbModule.db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES
      (?, ?, 'exact', 'accepted', 'manual', 1, 'test', 1),
      (?, ?, 'exact', 'accepted', 'manual', 1, 'test', 1)
  `).run(
    tidalReleaseId,
    canonicalReleaseId,
    appleReleaseId,
    canonicalReleaseId,
  );

  assert.equal(
    refreshServiceModule.RefreshAlbumService.getRefreshLevel("42", "tidal"),
    AlbumRefreshLevel.METADATA,
  );
  assert.equal(
    refreshServiceModule.RefreshAlbumService.getRefreshLevel("42", "apple-music"),
    AlbumRefreshLevel.OFFER,
  );
});



// Regression: explicit was hardcoded false here, and the hardcode also overrode
// the raw payload spread above it. Every provider track therefore stored
// explicit=0, so acquisition plans computed explicitContent="clean" even for an
// explicit release and prefer-explicit had nothing to act on.
test("provider track rows carry through explicitness", () => {
  const { providerTrackToTrackMetadataRow } = refreshServiceModule;
  const base = {
    providerId: "1",
    title: "Track",
    artist: { providerId: "a", name: "Artist" },
    album: { providerId: "b", title: "Album", artist: { providerId: "a", name: "Artist" } },
    duration: 100,
    trackNumber: 1,
  };

  assert.equal(providerTrackToTrackMetadataRow({ ...base, explicit: true } as never).explicit, true);
  assert.equal(providerTrackToTrackMetadataRow({ ...base, explicit: false } as never).explicit, false);
  // Unknown stays unknown rather than silently becoming clean.
  assert.equal(providerTrackToTrackMetadataRow(base as never).explicit, null);
  // A provider that only exposes it on the raw payload still works.
  assert.equal(
    providerTrackToTrackMetadataRow({ ...base, raw: { explicit: true } } as never).explicit,
    true,
  );
});

// Apple songs advertise dolby-atmos on qualityTags; without passthrough,
// storeProviderTrackOffers only saw quality="LOSSLESS" and never wrote spatial
// ProviderItemAudioVariants — so Spatial library plans never offered Apple Atmos.
test("provider track rows carry through qualityTags for audio variants", () => {
  const { providerTrackToTrackMetadataRow } = refreshServiceModule;
  const base = {
    providerId: "1590841387",
    title: "Distorted Light Beam",
    artist: { providerId: "a", name: "Bastille" },
    album: { providerId: "1590841197", title: "Give Me The Future", artist: { providerId: "a", name: "Bastille" } },
    duration: 180,
    trackNumber: 1,
    quality: "LOSSLESS",
    qualityTags: ["dolby-atmos", "lossless", "lossy-stereo"],
  };

  const row = providerTrackToTrackMetadataRow(base as never);
  assert.deepEqual(row.qualityTags, ["dolby-atmos", "lossless", "lossy-stereo"]);
  assert.equal(row.quality, "LOSSLESS");
});
