import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-mb-release-group-read-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let readServiceModule: typeof import("./musicbrainz-release-group-read-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  readServiceModule = await import("./musicbrainz-release-group-read-service.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM TrackFiles").run();
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM ReleaseGroupSlots").run();
  dbModule.db.prepare("DELETE FROM Tracks").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM AlbumReleases").run();
  dbModule.db.prepare("DELETE FROM ArtistReleaseGroups").run();
  dbModule.db.prepare("DELETE FROM Albums").run();
  dbModule.db.prepare("DELETE FROM Artists").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("album versions expose provider offers for all compatible MusicBrainz releases", async () => {
  const artistMbid = "artist-mbid-bastille";
  const releaseGroupMbid = "release-group-gmtf";
  const standardReleaseMbid = "release-gmtf-standard";
  const deluxeReleaseMbid = "release-gmtf-deluxe";
  const expandedReleaseMbid = "release-gmtf-expanded";

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run(artistMbid, "Bastille");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run(artistMbid, "Bastille", artistMbid);
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    releaseGroupMbid,
    artistMbid,
    "Give Me the Future",
    "Album",
    "2022-02-04",
  );
  const insertRelease = dbModule.db.prepare(`
    INSERT INTO AlbumReleases (
      mbid, release_group_mbid, artist_mbid, title, status, country, date, media_count, track_count, disambiguation
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertRelease.run(
    standardReleaseMbid,
    releaseGroupMbid,
    artistMbid,
    "Give Me the Future",
    "Official",
    JSON.stringify(["XW"]),
    "2022-02-04",
    1,
    13,
    "explicit",
  );
  insertRelease.run(
    deluxeReleaseMbid,
    releaseGroupMbid,
    artistMbid,
    "Give Me the Future",
    "Official",
    JSON.stringify(["XW"]),
    "2022-02-07",
    2,
    17,
    "deluxe edition - explicit",
  );
  insertRelease.run(
    expandedReleaseMbid,
    releaseGroupMbid,
    artistMbid,
    "Give Me the Future + Dreams of the Past",
    "Official",
    JSON.stringify(["XW"]),
    "2022-08-26",
    3,
    27,
    "explicit",
  );
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, quality, release_date,
      artist_mbid, release_group_mbid, release_mbid, library_slot,
      match_status, match_confidence, match_method, match_evidence
    ) VALUES
      ('tidal', 'album', ?, ?, 'HIRES_LOSSLESS', '2022-02-04', ?, ?, NULL, 'stereo', 'verified', 1, 'musicbrainz-release-group-title-year-type-track-count', ?),
      ('tidal', 'album', ?, ?, 'HIRES_LOSSLESS', '2022-02-07', ?, ?, NULL, 'stereo', 'probable', 1, 'musicbrainz-release-group-title-year-type-track-count', ?),
      ('tidal', 'album', ?, ?, 'HIRES_LOSSLESS', '2022-08-26', ?, ?, NULL, 'stereo', 'verified', 1, 'musicbrainz-release-group-title-year-type-track-count', ?)
  `).run(
    "tidal-standard",
    "Give Me The Future",
    artistMbid,
    releaseGroupMbid,
    JSON.stringify({ availableReleaseMbids: [standardReleaseMbid] }),
    "tidal-deluxe",
    "Give Me The Future (Deluxe Edition)",
    artistMbid,
    releaseGroupMbid,
    JSON.stringify({ availableReleaseMbids: [deluxeReleaseMbid] }),
    "tidal-expanded",
    "Give Me The Future + Dreams Of The Past",
    artistMbid,
    releaseGroupMbid,
    JSON.stringify({ availableReleaseMbids: [expandedReleaseMbid] }),
  );

  const versions = await readServiceModule.MusicBrainzReleaseGroupReadService.getVersions(releaseGroupMbid);
  const providersByRelease = new Map(versions.map((version) => [version.id, version.stereo_provider_id]));

  assert.equal(providersByRelease.get(standardReleaseMbid), "tidal-standard");
  assert.equal(providersByRelease.get(deluxeReleaseMbid), "tidal-deluxe");
  assert.equal(providersByRelease.get(expandedReleaseMbid), "tidal-expanded");
});

test("album tracks attach library files by recording MBID when track MBIDs differ across releases", async () => {
  const artistMbid = "artist-mbid-frank";
  const releaseGroupMbid = "release-group-frank";
  const stereoReleaseMbid = "release-frank-deluxe";
  const spatialReleaseMbid = "release-frank-atmos";
  const stereoTrackMbid = "track-frank-stereo-rehab";
  const spatialTrackMbid = "track-frank-spatial-rehab";
  const recordingMbid = "recording-frank-rehab";

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run(artistMbid, "Amy Winehouse");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run(artistMbid, "Amy Winehouse", artistMbid);
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(releaseGroupMbid, artistMbid, "Frank", "Album", "2006-10-20");

  const insertRelease = dbModule.db.prepare(`
    INSERT INTO AlbumReleases (
      mbid, release_group_mbid, artist_mbid, title, status, date, media_count, track_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertRelease.run(
    stereoReleaseMbid,
    releaseGroupMbid,
    artistMbid,
    "Frank (Deluxe Edition)",
    "Official",
    "2008-05-12",
    2,
    31,
  );
  insertRelease.run(
    spatialReleaseMbid,
    releaseGroupMbid,
    artistMbid,
    "Frank (Apple Digital Master)",
    "Official",
    "2021-10-29",
    1,
    16,
  );

  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_release_mbid
    ) VALUES (?, ?, ?, ?, ?)
  `).run(artistMbid, releaseGroupMbid, "stereo", 1, stereoReleaseMbid);

  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title, length_ms)
    VALUES (?, ?, ?)
  `).run(recordingMbid, "Rehab", 214000);

  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(stereoTrackMbid, stereoReleaseMbid, recordingMbid, 1, 1, "1", "Rehab", 214000);

  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid, library_slot, file_path, relative_path,
      library_root, filename, extension, file_type, quality
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artistMbid,
    artistMbid,
    releaseGroupMbid,
    spatialReleaseMbid,
    spatialTrackMbid,
    recordingMbid,
    "spatial",
    "/library/spatial/Amy Winehouse/Rehab.m4a",
    "Amy Winehouse/Rehab.m4a",
    "/library/spatial",
    "Rehab.m4a",
    ".m4a",
    "track",
    "DOLBY_ATMOS",
  );

  const tracks = await readServiceModule.MusicBrainzReleaseGroupReadService.getTracks(releaseGroupMbid);

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].musicbrainz_track_id, stereoTrackMbid);
  assert.equal(tracks[0].musicbrainz_recording_id, recordingMbid);
  assert.equal(tracks[0].files.length, 1);
  assert.equal(tracks[0].files[0]?.library_slot, "spatial");
  assert.equal(tracks[0].files[0]?.canonical_track_mbid, spatialTrackMbid);
  assert.equal(tracks[0].files[0]?.canonical_recording_mbid, recordingMbid);
  assert.equal(tracks[0].downloaded, true);
});

test("single release group does not inherit album files by shared recording MBID", async () => {
  const artistMbid = "artist-mbid-amy";
  const albumReleaseGroupMbid = "release-group-back-to-black";
  const singleReleaseGroupMbid = "release-group-rehab-single";
  const albumReleaseMbid = "release-back-to-black";
  const singleReleaseMbid = "release-rehab-single";
  const albumTrackMbid = "track-btb-rehab";
  const singleTrackMbid = "track-rehab-single";
  const recordingMbid = "recording-rehab-shared";

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run(artistMbid, "Amy Winehouse");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run(artistMbid, "Amy Winehouse", artistMbid);

  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(albumReleaseGroupMbid, artistMbid, "Back to Black", "Album", "2006-10-27");

  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(singleReleaseGroupMbid, artistMbid, "Rehab", "Single", "2006-10-23");

  const insertRelease = dbModule.db.prepare(`
    INSERT INTO AlbumReleases (
      mbid, release_group_mbid, artist_mbid, title, status, date, media_count, track_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertRelease.run(
    albumReleaseMbid,
    albumReleaseGroupMbid,
    artistMbid,
    "Back to Black",
    "Official",
    "2006-10-27",
    1,
    11,
  );
  insertRelease.run(
    singleReleaseMbid,
    singleReleaseGroupMbid,
    artistMbid,
    "Rehab",
    "Official",
    "2006-10-23",
    1,
    1,
  );

  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_release_mbid
    ) VALUES (?, ?, ?, ?, ?)
  `).run(artistMbid, albumReleaseGroupMbid, "stereo", 1, albumReleaseMbid);

  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_release_mbid
    ) VALUES (?, ?, ?, ?, ?)
  `).run(artistMbid, singleReleaseGroupMbid, "stereo", 1, singleReleaseMbid);

  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title, length_ms)
    VALUES (?, ?, ?)
  `).run(recordingMbid, "Rehab", 214000);

  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(albumTrackMbid, albumReleaseMbid, recordingMbid, 1, 1, "1", "Rehab", 214000);

  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(singleTrackMbid, singleReleaseMbid, recordingMbid, 1, 1, "1", "Rehab", 214000);

  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid, library_slot, file_path, relative_path,
      library_root, filename, extension, file_type, quality
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artistMbid,
    artistMbid,
    albumReleaseGroupMbid,
    albumReleaseMbid,
    albumTrackMbid,
    recordingMbid,
    "stereo",
    "/library/stereo/Amy Winehouse/Back to Black/Rehab.flac",
    "Amy Winehouse/Back to Black/Rehab.flac",
    "/library/stereo",
    "Rehab.flac",
    ".flac",
    "track",
    "LOSSLESS",
  );

  const albumTracks = await readServiceModule.MusicBrainzReleaseGroupReadService.getTracks(albumReleaseGroupMbid);
  assert.equal(albumTracks.length, 1);
  assert.equal(albumTracks[0].downloaded, true);
  assert.equal(albumTracks[0].files.length, 1);

  const singleTracks = await readServiceModule.MusicBrainzReleaseGroupReadService.getTracks(singleReleaseGroupMbid);
  assert.equal(singleTracks.length, 1);
  assert.equal(singleTracks[0].musicbrainz_track_id, singleTrackMbid);
  assert.equal(singleTracks[0].musicbrainz_recording_id, recordingMbid);
  assert.equal(singleTracks[0].files.length, 0);
  assert.notEqual(singleTracks[0].downloaded, true);
  assert.notEqual(singleTracks[0].is_downloaded, true);
});

test("hybrid trackSources tip wins over same-ISRC LOSSLESS rematch on primary album", async () => {
  const providersModule = await import("../providers/index.js");
  const artistMbid = "artist-mbid-amy-ost";
  const releaseGroupMbid = "rg-amy-ost";
  const releaseMbid = "release-amy-ost";
  const trackMbid = "track-tears-ost";
  const recordingMbid = "recording-tears";
  const isrc = "GBUM70603494";

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run(artistMbid, "Amy Winehouse");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run(artistMbid, "Amy Winehouse", artistMbid);
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(releaseGroupMbid, artistMbid, "Amy", "Album", "2015-10-30");
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (
      mbid, release_group_mbid, artist_mbid, title, status, date, media_count, track_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(releaseMbid, releaseGroupMbid, artistMbid, "Amy", "Official", "2015-10-30", 1, 1);
  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title, length_ms, isrcs)
    VALUES (?, ?, ?, ?)
  `).run(recordingMbid, "Tears Dry on Their Own", 187000, JSON.stringify([isrc]));
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(trackMbid, releaseMbid, recordingMbid, 1, 10, "10", "Tears Dry on Their Own", 187000);

  const evidence = {
    matchKind: "composite",
    providerAlbumIds: ["1440827079", "1422677780"],
    coverage: {
      coveredTracks: 1,
      targetTracks: 1,
      complete: true,
      qualityTrackCounts: { LOSSLESS: 0, HIRES_LOSSLESS: 1 },
    },
    trackSources: [{
      canonicalTrackMbid: trackMbid,
      canonicalRecordingMbid: recordingMbid,
      title: "Tears Dry on Their Own",
      trackNum: 10,
      volumeNum: 1,
      providerTrackId: "1422677787",
      providerAlbumId: "1422677780",
      quality: "HIRES_LOSSLESS",
      matchScore: 1,
    }],
  };
  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored,
      selected_provider, selected_provider_id, selected_release_mbid,
      quality, match_status, match_method, match_evidence
    ) VALUES (?, ?, 'stereo', 1, ?, ?, ?, ?, 'verified', ?, ?)
  `).run(
    artistMbid,
    releaseGroupMbid,
    "apple-music",
    "1440827079;1422677780",
    releaseMbid,
    "LOSSLESS",
    "quality_optimized_composite_track_coverage",
    JSON.stringify(evidence),
  );

  const artist = { providerId: "apple-artist", name: "Amy Winehouse" };
  providersModule.streamingProviderManager.registerStreamingProvider({
    id: "apple-music",
    name: "Apple Music",
    capabilities: {},
    search: async () => ({ artists: [], albums: [], tracks: [], videos: [] }),
    getArtist: async () => artist,
    getArtistAlbums: async () => [],
    getAlbum: async () => ({ providerId: "1440827079", title: "Amy", artist, trackCount: 1, volumeCount: 1 }),
    getTrack: async (id: string | number) => ({
      providerId: String(id),
      title: "Tears Dry on Their Own",
      artist,
      duration: 187,
      trackNumber: 10,
      volumeNumber: 1,
    }),
    getAlbumTracks: async (id: string | number) => {
      if (String(id) === "1440827079") {
        return [{
          providerId: "1440827414",
          title: "Tears Dry on Their Own",
          artist,
          isrc,
          duration: 187,
          trackNumber: 10,
          volumeNumber: 1,
          quality: "LOSSLESS",
        }];
      }
      return [{
        providerId: "1422677787",
        title: "Tears Dry On Their Own",
        artist,
        isrc,
        duration: 186,
        trackNumber: 7,
        volumeNumber: 1,
        quality: "HIRES_LOSSLESS",
      }];
    },
    getStreamUrl: async () => null,
  } as any);

  const tracks = await readServiceModule.MusicBrainzReleaseGroupReadService.getTracks(releaseGroupMbid);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].quality, "HIRES_LOSSLESS");
  assert.equal(tracks[0].preview_provider_track_id, "1422677787");
  assert.deepEqual(tracks[0].remoteOffers, [{
    slot: "stereo",
    provider: "apple-music",
    providerAlbumId: "1422677780",
    quality: "HIRES_LOSSLESS",
    matchStatus: "verified",
    selectedReleaseMbid: releaseMbid,
    providerTrackId: "1422677787",
  }]);
});

