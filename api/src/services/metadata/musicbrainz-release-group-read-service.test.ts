import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { seedSelectedAcquisitionPlan } from "../../test-support/acquisition-plan-fixture.js";

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
  dbModule.db.prepare("DELETE FROM AcquisitionPlanTracks").run();
  dbModule.db.prepare("DELETE FROM AcquisitionPlanSources").run();
  // Release the deferred plan reference before its rows go.
  dbModule.db.prepare("UPDATE LibraryEditions SET preferred_plan_key = NULL").run();
  dbModule.db.prepare("DELETE FROM AcquisitionPlans").run();
  dbModule.db.prepare("DELETE FROM LibraryEditions").run();
  dbModule.db.prepare("DELETE FROM LibraryAlbums").run();
  dbModule.db.prepare("DELETE FROM Libraries").run();
  dbModule.db.prepare("DELETE FROM ProviderTrackMatches").run();
  dbModule.db.prepare("DELETE FROM ProviderEditionMatches").run();
  dbModule.db.prepare("DELETE FROM ProviderEditionMembers").run();
  dbModule.db.prepare("DELETE FROM ProviderItemAudioVariants").run();
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM Tracks").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM AlbumEditions").run();
  dbModule.db.prepare("DELETE FROM ArtistReleaseGroups").run();
  dbModule.db.prepare("DELETE FROM Albums").run();
  dbModule.db.prepare("DELETE FROM Artists").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
});

function hydrateCanonicalForeignKeys(releaseGroupMbid: string): void {
  const { db } = dbModule;
  db.prepare(`
    UPDATE Albums
    SET artist_metadata_id = (
      SELECT id FROM ArtistMetadata WHERE mbid = Albums.artist_mbid
    )
    WHERE mbid = ?
  `).run(releaseGroupMbid);
  db.prepare(`
    UPDATE AlbumEditions
    SET
      release_group_id = (
        SELECT id FROM Albums WHERE mbid = AlbumEditions.release_group_mbid
      ),
      artist_metadata_id = (
        SELECT id FROM ArtistMetadata WHERE mbid = AlbumEditions.artist_mbid
      )
    WHERE release_group_mbid = ?
  `).run(releaseGroupMbid);
  db.prepare(`
    UPDATE Tracks
    SET
      album_edition_id = (
        SELECT id FROM AlbumEditions WHERE mbid = Tracks.release_mbid
      ),
      recording_id = (
        SELECT id FROM Recordings WHERE mbid = Tracks.recording_mbid
      )
    WHERE release_mbid IN (
      SELECT mbid FROM AlbumEditions WHERE release_group_mbid = ?
    )
  `).run(releaseGroupMbid);
}

function selectLibraryRelease(
  releaseGroupMbid: string,
  releaseMbid: string,
  libraryClass: "stereo" | "spatial" = "stereo",
): number {
  const { db } = dbModule;
  db.prepare(`
    INSERT OR IGNORE INTO MetadataProfiles (name, release_type_policy)
    VALUES ('Read Service Test', '{}')
  `).run();
  if (libraryClass === "spatial") {
    db.prepare(`
      INSERT OR IGNORE INTO quality_profiles (
        name, cutoff, items, allowed_source_formats, preference_order
      ) VALUES ('Read Service Spatial', 'DOLBY_ATMOS', '["DOLBY_ATMOS"]', '["spatial"]', '["spatial"]')
    `).run();
  }
  const metadataProfile = db.prepare(`
    SELECT id FROM MetadataProfiles WHERE name = 'Read Service Test'
  `).get() as { id: number };
  const qualityProfile = db.prepare(`
    SELECT id
    FROM quality_profiles
    WHERE ${libraryClass === "spatial"
      ? "name = 'Read Service Spatial'"
      : "COALESCE(allowed_source_formats, '[]') NOT LIKE '%spatial%'"}
    ORDER BY id
    LIMIT 1
  `).get() as { id: number };
  const libraryName = `Read ${libraryClass} ${releaseGroupMbid}`;
  db.prepare(`
    INSERT OR IGNORE INTO Libraries (
      name, root_path, metadata_profile_id, quality_profile_id
    ) VALUES (?, ?, ?, ?)
  `).run(
    libraryName,
    path.join(tempDir, "libraries", libraryClass, releaseGroupMbid),
    metadataProfile.id,
    qualityProfile.id,
  );
  const library = db.prepare("SELECT id FROM Libraries WHERE name = ?")
    .get(libraryName) as { id: number };
  const releaseGroup = db.prepare("SELECT id FROM Albums WHERE mbid = ?")
    .get(releaseGroupMbid) as { id: number };
  const release = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = ?")
    .get(releaseMbid) as { id: number };
  db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'auto', 0, 'test', 1)
  `).run(library.id, releaseGroup.id);
  return (db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, reason, curation_version
    ) VALUES (?, ?, 'auto', 'test', 1)
    RETURNING id
  `).get(library.id, release.id) as { id: number }).id;
}

function insertAcceptedReleaseMatch(
  releaseMbid: string,
  provider: string,
  providerId: string,
  title: string,
  providerUrl: string | null = null,
): { providerItemId: number; releaseMatchId: number } {
  const { db } = dbModule;
  const providerItem = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, provider_url
    ) VALUES (?, 'release', ?, ?, ?)
    RETURNING id
  `).get(provider, providerId, title, providerUrl) as { id: number };
  const release = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = ?")
    .get(releaseMbid) as { id: number };
  const releaseMatch = db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 1, 'test', 1)
    RETURNING id
  `).get(providerItem.id, release.id) as { id: number };
  return {
    providerItemId: providerItem.id,
    releaseMatchId: releaseMatch.id,
  };
}

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
    INSERT INTO AlbumEditions (
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
  hydrateCanonicalForeignKeys(releaseGroupMbid);
  insertAcceptedReleaseMatch(
    standardReleaseMbid,
    "tidal",
    "tidal-standard",
    "Give Me The Future",
  );
  insertAcceptedReleaseMatch(
    deluxeReleaseMbid,
    "tidal",
    "tidal-deluxe",
    "Give Me The Future (Deluxe Edition)",
  );
  insertAcceptedReleaseMatch(
    expandedReleaseMbid,
    "tidal",
    "tidal-expanded",
    "Give Me The Future + Dreams Of The Past",
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
    INSERT INTO AlbumEditions (
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
  hydrateCanonicalForeignKeys(releaseGroupMbid);
  selectLibraryRelease(releaseGroupMbid, stereoReleaseMbid);

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
    INSERT INTO AlbumEditions (
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
  hydrateCanonicalForeignKeys(albumReleaseGroupMbid);
  hydrateCanonicalForeignKeys(singleReleaseGroupMbid);
  selectLibraryRelease(albumReleaseGroupMbid, albumReleaseMbid);
  selectLibraryRelease(singleReleaseGroupMbid, singleReleaseMbid);

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

test("exact acquisition-plan track wins without positional or ISRC rematching", async () => {
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
    INSERT INTO AlbumEditions (
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
  hydrateCanonicalForeignKeys(releaseGroupMbid);
  const libraryEditionId = selectLibraryRelease(releaseGroupMbid, releaseMbid);
  const releaseMatch = insertAcceptedReleaseMatch(
    releaseMbid,
    "apple-music",
    "1422677780",
    "Amy",
    "https://music.apple.com/album/1422677780",
  );
  const providerTrack = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, isrc, duration_ms, provider_url
    ) VALUES ('apple-music', 'track', '1422677787', 'Tears Dry On Their Own', ?, 186, 'https://music.apple.com/song/1422677787')
    RETURNING id
  `).get(isrc) as { id: number };
  const distractorTrack = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, isrc, duration_ms
    ) VALUES ('apple-music', 'track', '1440827414', 'Tears Dry on Their Own', ?, 187)
    RETURNING id
  `).get(isrc) as { id: number };
  const member = dbModule.db.prepare(`
    INSERT INTO ProviderEditionMembers (
      provider_edition_item_id, member_item_id, medium_position, position
    ) VALUES (?, ?, 1, 7)
    RETURNING id
  `).get(releaseMatch.providerItemId, providerTrack.id) as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderEditionMembers (
      provider_edition_item_id, member_item_id, medium_position, position
    ) VALUES (?, ?, 1, 10)
  `).run(releaseMatch.providerItemId, distractorTrack.id);
  const canonicalTrack = dbModule.db.prepare(`
    SELECT id, recording_id FROM Tracks WHERE mbid = ?
  `).get(trackMbid) as { id: number; recording_id: number };
  const trackMatch = dbModule.db.prepare(`
    INSERT INTO ProviderTrackMatches (
      provider_track_item_id, provider_edition_member_id, provider_edition_match_id, track_id,
      recording_id, match_state, decision_source, confidence, method,
      matcher_version
    ) VALUES (?, ?, ?, ?, ?, 'accepted', 'automatic', 1, 'test', 1)
    RETURNING id
  `).get(
    providerTrack.id,
    member.id,
    releaseMatch.releaseMatchId,
    canonicalTrack.id,
    canonicalTrack.recording_id,
  ) as { id: number };
  const variant = dbModule.db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label,
      availability
    ) VALUES (?, 'hires', 'hires-lossless', 'HIRES_LOSSLESS', 'available')
    RETURNING id
  `).get(providerTrack.id) as { id: number };
  const plan = seedSelectedAcquisitionPlan(dbModule.db, { libraryEditionId: libraryEditionId, provider: 'apple-music', downloadMode: 'tracks' }) as { id: number };
  const source = dbModule.db.prepare(`
    INSERT INTO AcquisitionPlanSources (
      plan_id, provider_edition_match_id, role, sort_order
    ) VALUES (?, ?, 'primary', 0)
    RETURNING id
  `).get(plan.id, releaseMatch.releaseMatchId) as { id: number };
  dbModule.db.prepare(`
    INSERT INTO AcquisitionPlanTracks (
      plan_id, track_id, source_id, provider_track_match_id,
      provider_audio_variant_id
    ) VALUES (?, ?, ?, ?, ?)
  `).run(plan.id, canonicalTrack.id, source.id, trackMatch.id, variant.id);

  const tracks = await readServiceModule.MusicBrainzReleaseGroupReadService.getTracks(releaseGroupMbid);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].quality, "HIRES_LOSSLESS");
  assert.equal(tracks[0].preview_provider_track_id, "1422677787");
  assert.deepEqual(tracks[0].remoteOffers, [{
    slot: "stereo",
    provider: "apple-music",
    providerAlbumId: "1422677780",
    providerUrl: "https://music.apple.com/album/1422677780",
    quality: "HIRES_LOSSLESS",
    matchStatus: "verified",
    selectedReleaseMbid: releaseMbid,
    providerTrackId: "1422677787",
    providerTrackUrl: "https://music.apple.com/song/1422677787",
  }]);
});

