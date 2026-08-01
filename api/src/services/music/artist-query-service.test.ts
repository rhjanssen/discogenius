import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { selectVideoInVideoLibraries } from "../../test-support/active-schema-fixture.js";
import { seedSelectedAcquisitionPlan } from "../../test-support/acquisition-plan-fixture.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-artist-query-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let artistQueryModule: typeof import("./artist-query-service.js");
let mediaCoverServiceModule: typeof import("../metadata/media-cover-service.js");
let servarrMetadataModule: typeof import("../metadata/servarr-metadata.js");
let artistStatisticsModule: typeof import("./artist-statistics-service.js");
let artistTopTrackModule: typeof import("./artist-top-track-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  artistQueryModule = await import("./artist-query-service.js");
  mediaCoverServiceModule = await import("../metadata/media-cover-service.js");
  servarrMetadataModule = await import("../metadata/servarr-metadata.js");
  artistStatisticsModule = await import("./artist-statistics-service.js");
  artistTopTrackModule = await import("./artist-top-track-service.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM AcquisitionPlanTracks").run();
  db.prepare("DELETE FROM AcquisitionPlanSources").run();
  // Release the deferred plan reference before its rows go.
  db.prepare("UPDATE LibraryEditions SET preferred_plan_key = NULL").run();
  db.prepare("DELETE FROM AcquisitionPlans").run();
  db.prepare("DELETE FROM LibraryEditions").run();
  db.prepare("DELETE FROM LibraryAlbums").run();
  db.prepare("DELETE FROM ProviderTrackMatches").run();
  db.prepare("DELETE FROM ProviderVideoMatches").run();
  db.prepare("DELETE FROM ProviderEditionMatches").run();
  db.prepare("DELETE FROM ProviderEditionMembers").run();
  db.prepare("DELETE FROM ProviderItemAudioVariants").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumEditions").run();
  db.prepare("DELETE FROM ArtistReleaseGroups").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM Artists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedCanonicalArtistPage() {
  const { db } = dbModule;
  const artistMetadata = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name, popularity)
    VALUES ('artist-mbid-1', 'Canonical Artist', 77)
    RETURNING id
  `).get() as { id: number };

  db.prepare(`
    INSERT INTO Artists (id, mbid, name, monitored, last_scanned, bio_text, artist_types)
    VALUES ('artist-1', 'artist-mbid-1', 'Canonical Artist', 1, CURRENT_TIMESTAMP, 'Canonical biography', '["Person"]')
  `).run();

  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date, images)
    VALUES (
      'release-group-mbid-1', 'artist-mbid-1', 'Canonical Album', 'Album', '2024-01-01',
      '[{"coverType":"Cover","url":"https://images.lidarr.audio/cache/https://coverartarchive.org/release/release-mbid-1/seed.jpg"}]'
    )
  `).run();

  db.prepare(`
    INSERT INTO AlbumEditions (
      id, foreign_release_id, mbid, release_group_mbid, artist_mbid,
      title, status, country, date, media_count, track_count
    )
    VALUES (
      201, 'release-mbid-1', 'release-mbid-1', 'release-group-mbid-1', 'artist-mbid-1',
      'Canonical Album', 'Official', 'XW', '2024-01-01', 1, 1
    )
  `).run();

  const releaseGroup = db.prepare(`
    SELECT id FROM Albums WHERE mbid = 'release-group-mbid-1'
  `).get() as { id: number };
  const library = db.prepare(`
    SELECT id FROM Libraries WHERE name = 'Stereo'
  `).get() as { id: number };
  db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'manual', 1, 'test', 1)
  `).run(library.id, releaseGroup.id);
  db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, reason, curation_version
    ) VALUES (?, 201, 'manual', 'test', 1)
  `).run(library.id);

  db.prepare(`
    INSERT INTO Recordings (
      id, foreign_recording_id, mbid, artist_metadata_id, artist_mbid,
      title, length_ms, is_video, metadata_status
    )
    VALUES (
      301, 'recording-mbid-1', 'recording-mbid-1', ?, 'artist-mbid-1',
      'Canonical Track', 180000, 0, 'musicbrainz'
    )
  `).run(artistMetadata.id);

  db.prepare(`
    INSERT INTO Tracks (
      id, foreign_track_id, foreign_recording_id, mbid, release_mbid, recording_mbid,
      medium_position, position, number, title, length_ms
    )
    VALUES (
      401, 'track-mbid-1', 'recording-mbid-1', 'track-mbid-1', 'release-mbid-1', 'recording-mbid-1',
      1, 1, '1', 'Canonical Track', 180000
    )
  `).run();

  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, cover_id, duration_ms
    ) VALUES ('tidal', 'track', 'provider-track-1', 'Canonical Track', '13bb32e2-e326-4ee5-be74-f3320ad3379c', 180)
  `).run();

  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, cover_id, provider_url
    ) VALUES ('tidal', 'release', 'provider-album-1', 'Canonical Album', '13bb32e2-e326-4ee5-be74-f3320ad3379c', 'https://soundcloud.com/example/sets/canonical-album')
  `).run();

  const providerTrack = db.prepare(`
    SELECT id FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'track' AND provider_id = 'provider-track-1'
  `).get() as { id: number };
  const providerRelease = db.prepare(`
    SELECT id FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'release' AND provider_id = 'provider-album-1'
  `).get() as { id: number };
  const releaseMember = db.prepare(`
    INSERT INTO ProviderEditionMembers (
      provider_edition_item_id, member_item_id, medium_position, position
    ) VALUES (?, ?, 1, 1)
    RETURNING id
  `).get(providerRelease.id, providerTrack.id) as { id: number };
  const releaseMatch = db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version
    ) VALUES (?, 201, 'exact', 'accepted', 'automatic', 1, 'test', 1)
    RETURNING id
  `).get(providerRelease.id) as { id: number };
  const trackMatch = db.prepare(`
    INSERT INTO ProviderTrackMatches (
      provider_track_item_id, provider_edition_member_id, provider_edition_match_id, track_id,
      recording_id, match_state, decision_source, confidence, method,
      matcher_version
    ) VALUES (?, ?, ?, 401, 301, 'accepted', 'automatic', 1, 'test', 1)
    RETURNING id
  `).get(providerTrack.id, releaseMember.id, releaseMatch.id) as { id: number };
  const variant = db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label,
      availability
    ) VALUES (?, 'lossless', 'lossless', 'LOSSLESS', 'available')
    RETURNING id
  `).get(providerTrack.id) as { id: number };
  const libraryRelease = db.prepare(`
    SELECT id FROM LibraryEditions WHERE library_id = ? AND edition_id = 201
  `).get(library.id) as { id: number };
  const plan = seedSelectedAcquisitionPlan(db, { libraryEditionId: libraryRelease.id, provider: 'tidal' }) as { id: number };
  const source = db.prepare(`
    INSERT INTO AcquisitionPlanSources (
      plan_id, provider_edition_match_id, role, sort_order
    ) VALUES (?, ?, 'primary', 0)
    RETURNING id
  `).get(plan.id, releaseMatch.id) as { id: number };
  db.prepare(`
    INSERT INTO AcquisitionPlanTracks (
      plan_id, track_id, source_id, provider_track_match_id,
      provider_audio_variant_id, source_quality_snapshot
    ) VALUES (?, 401, ?, ?, ?, '{"quality":"LOSSLESS"}')
  `).run(plan.id, source.id, trackMatch.id, variant.id);

  db.prepare(`
    INSERT INTO Recordings (
      id, foreign_recording_id, mbid, artist_metadata_id, artist_mbid, title, length_ms, is_video, metadata_status, release_date, cover_image_id
    ) VALUES (501, 'video-recording-mbid-1', 'video-recording-mbid-1', ?, 'artist-mbid-1', 'Canonical Video', 210000, 1, 'musicbrainz', '2024-02-01', 'video-cover')
  `).run(artistMetadata.id);
  selectVideoInVideoLibraries(db, 501);

  const providerVideo = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, duration_ms, release_date, cover_id, provider_url
    ) VALUES ('tidal', 'video', 'provider-video-1', 'Canonical Video', 210, '2024-02-01', 'video-offer-cover', 'https://tidal.com/browse/video/provider-video-1')
    RETURNING id
  `).get() as { id: number };
  db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, 501, 'accepted', 'automatic', 1, 'test', 1)
  `).run(providerVideo.id);


return { artistId: "artist-1" };
}

test("artist page uses canonical release groups, tracks, and video recordings", async () => {
  const { artistId } = seedCanonicalArtistPage();

  const page = await artistQueryModule.ArtistQueryService.getArtistPage(artistId);
  assert.ok(page);

  const modules = (page?.rows || []).flatMap((row: any) => row.modules || []);
  const albums = modules.find((module: any) => module.title === "Albums")?.items || [];
  const topTracks = modules.find((module: any) => module.title === "Top Tracks")?.items || [];
  const videos = modules.find((module: any) => module.title === "Videos")?.items || [];

  assert.equal(page?.album_count, 1);
  assert.equal(page?.monitored_album_count, 1);
  assert.equal(page?.needs_scan, false);

  assert.equal(albums.length, 1);
  assert.equal(albums[0].id, "release-group-mbid-1");
  assert.equal(albums[0].title, "Canonical Album");
  assert.equal(albums[0].source, "musicbrainz");
  assert.equal(albums[0].monitored_lock, true);
  assert.equal(albums[0].selected_provider_id, "provider-album-1");
  assert.equal(albums[0].stereo_provider_url, "https://soundcloud.com/example/sets/canonical-album");
  assert.match(albums[0].cover_art_url, /^\/media-cover\/Albums\/release-group-mbid-1\/cover\.jpg\?source=canonical&rev=[a-f0-9]{16}$/);
  assert.equal(albums[0].stereo_provider_url, "https://soundcloud.com/example/sets/canonical-album");
  assert.equal(albums[0].provider_cover_id, "13bb32e2-e326-4ee5-be74-f3320ad3379c");
  assert.equal(albums.some((album: any) => album.title === "Stale provider Album"), false);

  assert.equal(topTracks.length, 1);
  assert.equal(topTracks[0].id, "track-mbid-1");
  assert.equal(topTracks[0].album?.id, "release-group-mbid-1");
  assert.equal(topTracks[0].album?.title, "Canonical Album");
  assert.equal(topTracks[0].is_monitored, true);
  assert.equal(topTracks[0].monitored_lock, true);

  assert.equal(videos.length, 1);
  assert.equal(videos[0].id, "501");
  assert.equal(videos[0].title, "Canonical Video");
  assert.equal(videos[0].provider, "tidal");
  assert.equal(String(videos[0].provider_id), "provider-video-1");
  assert.equal(videos[0].is_monitored, true);
  assert.equal(videos.some((video: any) => video.title === "Stale provider Video"), false);
});

test("artist page sections can be loaded independently", async () => {
  const { artistId } = seedCanonicalArtistPage();
  const identity = await artistQueryModule.ArtistQueryService.getArtistPage(artistId, {
    includeReleaseGroups: false,
    includeTracks: false,
    includeVideos: false,
    includeStatistics: false,
  });
  const summary = await artistQueryModule.ArtistQueryService.getArtistPage(artistId, {
    includeReleaseGroups: true,
    includeTracks: false,
    includeVideos: false,
  });
  const tracks = await artistQueryModule.ArtistQueryService.getArtistPage(artistId, {
    includeReleaseGroups: false,
    includeTracks: true,
    includeVideos: false,
  });
  const videos = await artistQueryModule.ArtistQueryService.getArtistPage(artistId, {
    includeReleaseGroups: false,
    includeTracks: false,
    includeVideos: true,
  });

  const moduleTypes = (page: any) => (page.rows || [])
    .flatMap((row: any) => row.modules || [])
    .map((module: any) => module.type);
  assert.equal(identity.artist.name, "Canonical Artist");
  assert.deepEqual(moduleTypes(identity), []);
  assert.deepEqual(moduleTypes(summary), ["ALBUM"]);
  assert.deepEqual(moduleTypes(tracks), ["TRACK_LIST"]);
  assert.deepEqual(moduleTypes(videos), ["VIDEO_LIST"]);
});

test("artist page top tracks ignore unselected alternate editions", async () => {
  const { artistId } = seedCanonicalArtistPage();
  const { db } = dbModule;
  const artistMetadata = db.prepare(`
    SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid-1'
  `).get() as { id: number };

  db.prepare(`
    INSERT INTO AlbumEditions (
      id, foreign_release_id, mbid, release_group_mbid, artist_mbid,
      title, status, country, date, media_count, track_count
    )
    VALUES (
      202, 'release-mbid-atmos', 'release-mbid-atmos', 'release-group-mbid-1', 'artist-mbid-1',
      'Canonical Album', 'Official', 'XW', '2024-01-01', 1, 1
    )
  `).run();

  db.prepare(`
    INSERT INTO Recordings (
      id, foreign_recording_id, mbid, artist_metadata_id, artist_mbid,
      title, length_ms, is_video, metadata_status
    )
    VALUES (
      302, 'recording-mbid-atmos', 'recording-mbid-atmos', ?, 'artist-mbid-1',
      'Canonical Track', 180000, 0, 'musicbrainz'
    )
  `).run(artistMetadata.id);

  db.prepare(`
    INSERT INTO Tracks (
      id, foreign_track_id, foreign_recording_id, mbid, release_mbid, recording_mbid,
      medium_position, position, number, title, length_ms
    )
    VALUES (
      402, 'track-mbid-atmos', 'recording-mbid-atmos', 'track-mbid-atmos', 'release-mbid-atmos', 'recording-mbid-atmos',
      1, 1, '1', 'Canonical Track', 180000
    )
  `).run();

  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, cover_id, duration_ms
    ) VALUES ('tidal', 'track', 'provider-track-atmos', 'Canonical Track', '13bb32e2-e326-4ee5-be74-f3320ad3379c', 180)
  `).run();

  const page = await artistQueryModule.ArtistQueryService.getArtistPage(artistId);
  const modules = (page?.rows || []).flatMap((row: any) => row.modules || []);
  const topTracks = modules.find((module: any) => module.title === "Top Tracks")?.items || [];

  assert.equal(topTracks.length, 1);
  assert.equal(topTracks[0].title, "Canonical Track");
  assert.equal(topTracks[0].preview_provider_track_id, "provider-track-1");
  assert.deepEqual(topTracks[0].qualityTags, ["LOSSLESS"]);
});

test("artist page top tracks resolve provider previews through typed plan matches", async () => {
  const { artistId } = seedCanonicalArtistPage();

  // Provider items never carry a direct canonical track/recording id anymore;
  // the preview resolves purely through the typed plan matches seeded above.
  const page = await artistQueryModule.ArtistQueryService.getArtistPage(artistId, {
    includeReleaseGroups: false,
    includeTracks: true,
    includeVideos: false,
  });
  const modules = (page?.rows || []).flatMap((row: any) => row.modules || []);
  const topTracks = modules.find((module: any) => module.title === "Top Tracks")?.items || [];

  assert.equal(topTracks.length, 1);
  assert.equal(topTracks[0].preview_provider, "tidal");
  assert.equal(topTracks[0].preview_provider_track_id, "provider-track-1");
});

test("artist page top tracks prefer the selected plan provider over a newer alternate offer", async () => {
  const { artistId } = seedCanonicalArtistPage();
  const { db } = dbModule;

  // The tidal offer's release membership is already seeded; only the backdated
  // updated_at matters here (the newer apple alternate must not win the preview).
  db.prepare(`
    UPDATE ProviderItems
    SET updated_at = '2020-01-01T00:00:00.000Z'
    WHERE provider = 'tidal' AND provider_id = 'provider-track-1'
  `).run();
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, updated_at
    ) VALUES ('apple-music', 'track', 'apple-track-newer', 'Canonical Track', '2026-01-01T00:00:00.000Z')
  `).run();

  const page = await artistQueryModule.ArtistQueryService.getArtistPage(artistId, {
    includeReleaseGroups: false,
    includeTracks: true,
    includeVideos: false,
  });
  const topTracks = (page?.rows || [])
    .flatMap((row: any) => row.modules || [])
    .find((module: any) => module.title === "Top Tracks")?.items || [];

  assert.equal(topTracks.length, 1);
  assert.equal(topTracks[0].preview_provider, "tidal");
  assert.equal(topTracks[0].preview_provider_track_id, "provider-track-1");
});

test("artist top tracks prefer the default provider popularity and fall back to another provider", async () => {
  const { artistId } = seedCanonicalArtistPage();
  const { db } = dbModule;

  db.prepare("UPDATE Recordings SET popularity = 99 WHERE id = 301").run();
  db.prepare("UPDATE ProviderItems SET popularity = 5 WHERE provider = 'tidal' AND provider_id = 'provider-track-1'").run();
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, popularity
    ) VALUES ('apple-music', 'track', 'apple-track-1', 'Canonical Track', 90)
  `).run();
  db.prepare(`
    INSERT INTO Recordings (
      id, foreign_recording_id, mbid, artist_mbid, title, length_ms, popularity, is_video, metadata_status
    ) VALUES (302, 'recording-mbid-2', 'recording-mbid-2', 'artist-mbid-1', 'Provider Favorite', 190000, 10, 0, 'musicbrainz')
  `).run();
  db.prepare(`
    INSERT INTO Tracks (
      id, foreign_track_id, foreign_recording_id, mbid, release_mbid, recording_mbid,
      medium_position, position, number, title, length_ms
    ) VALUES (402, 'track-mbid-2', 'recording-mbid-2', 'track-mbid-2', 'release-mbid-1', 'recording-mbid-2', 1, 2, '2', 'Provider Favorite', 190000)
  `).run();
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, popularity
    ) VALUES ('tidal', 'track', 'provider-track-2', 'Provider Favorite', 80)
  `).run();

  // Provider popularity is only visible through an accepted typed track match.
  // Link the extra tidal offer to Provider Favorite (recording 302) via the
  // existing tidal release, and give the apple offer its own accepted chain to
  // Canonical Track (recording 301) so the cross-provider fallback can resolve.
  const linkProviderTrack = (
    providerTrackProviderId: string,
    provider: string,
    releaseProviderId: string,
    editionId: number,
    canonicalTrackId: number,
    canonicalRecordingId: number,
    position: number,
  ) => {
    const providerTrack = db.prepare(
      "SELECT id FROM ProviderItems WHERE provider = ? AND entity_type = 'track' AND provider_id = ?",
    ).get(provider, providerTrackProviderId) as { id: number };
    let providerRelease = db.prepare(
      "SELECT id FROM ProviderItems WHERE provider = ? AND entity_type = 'release' AND provider_id = ?",
    ).get(provider, releaseProviderId) as { id: number } | undefined;
    if (!providerRelease) {
      providerRelease = db.prepare(`
        INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
        VALUES (?, 'release', ?, 'Canonical Album') RETURNING id
      `).get(provider, releaseProviderId) as { id: number };
    }
    let releaseMatch = db.prepare(
      "SELECT id FROM ProviderEditionMatches WHERE provider_edition_item_id = ? AND edition_id = ?",
    ).get(providerRelease.id, editionId) as { id: number } | undefined;
    if (!releaseMatch) {
      releaseMatch = db.prepare(`
        INSERT INTO ProviderEditionMatches (
          provider_edition_item_id, edition_id, relation, match_state,
          decision_source, confidence, method, matcher_version
        ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 1, 'test', 1) RETURNING id
      `).get(providerRelease.id, editionId) as { id: number };
    }
    const member = db.prepare(`
      INSERT INTO ProviderEditionMembers (
        provider_edition_item_id, member_item_id, medium_position, position
      ) VALUES (?, ?, 1, ?) RETURNING id
    `).get(providerRelease.id, providerTrack.id, position) as { id: number };
    db.prepare(`
      INSERT INTO ProviderTrackMatches (
        provider_track_item_id, provider_edition_member_id, provider_edition_match_id, track_id,
        recording_id, match_state, decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, ?, ?, ?, 'accepted', 'automatic', 1, 'test', 1)
    `).run(providerTrack.id, member.id, releaseMatch.id, canonicalTrackId, canonicalRecordingId);
  };
  linkProviderTrack("provider-track-2", "tidal", "provider-album-1", 201, 402, 302, 2);
  linkProviderTrack("apple-track-1", "apple-music", "apple-album-1", 201, 401, 301, 1);

  const loadTopTracks = async () => {
    const page = await artistQueryModule.ArtistQueryService.getArtistPage(artistId, {
      includeReleaseGroups: false,
      includeTracks: true,
      includeVideos: false,
    });
    return (page?.rows || [])
      .flatMap((row: any) => row.modules || [])
      .find((module: any) => module.title === "Top Tracks")?.items || [];
  };

  const defaultProviderTracks = await loadTopTracks();
  assert.equal(defaultProviderTracks[0].title, "Provider Favorite");
  assert.equal(defaultProviderTracks[0].popularity, 80);
  assert.equal(defaultProviderTracks.find((track: any) => track.title === "Canonical Track")?.popularity, 5);

  db.prepare("UPDATE ProviderItems SET popularity = NULL WHERE provider = 'tidal' AND provider_id = 'provider-track-1'").run();
  artistTopTrackModule.ArtistTopTrackService.rebuildForArtist(artistId, "artist-mbid-1");
  const fallbackProviderTracks = await loadTopTracks();
  assert.equal(fallbackProviderTracks[0].title, "Canonical Track");
  assert.equal(fallbackProviderTracks[0].popularity, 90);
});

test("artist top-track projection returns the indexed top 100 recordings", async () => {
  const { artistId } = seedCanonicalArtistPage();
  const { db } = dbModule;
  const artistMetadata = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid-1'")
    .get() as { id: number };

  db.transaction(() => {
    const insertRecording = db.prepare(`
      INSERT INTO Recordings (
        foreign_recording_id, mbid, artist_metadata_id, artist_mbid,
        title, length_ms, popularity, is_video, metadata_status
      ) VALUES (?, ?, ?, 'artist-mbid-1', ?, 180000, ?, 0, 'musicbrainz')
    `);
    const insertTrack = db.prepare(`
      INSERT INTO Tracks (
        foreign_track_id, foreign_recording_id, mbid, release_mbid, recording_mbid,
        medium_position, position, number, title, length_ms
      ) VALUES (?, ?, ?, 'release-mbid-1', ?, 1, ?, ?, ?, 180000)
    `);

    for (let index = 1; index <= 120; index += 1) {
      const recordingMbid = `ranked-recording-${index}`;
      const trackMbid = `ranked-track-${index}`;
      const title = `Ranked Track ${index}`;
      insertRecording.run(recordingMbid, recordingMbid, artistMetadata.id, title, index);
      insertTrack.run(trackMbid, recordingMbid, trackMbid, recordingMbid, index + 1, String(index + 1), title);
    }
  })();

  const page = await artistQueryModule.ArtistQueryService.getArtistPage(artistId, {
    includeReleaseGroups: false,
    includeTracks: true,
    includeVideos: false,
  });
  const topTracks = (page?.rows || [])
    .flatMap((row: any) => row.modules || [])
    .find((module: any) => module.title === "Top Tracks")?.items || [];

  assert.equal(topTracks.length, 100);
  assert.equal(topTracks[0].title, "Ranked Track 120");
  assert.equal(topTracks[99].title, "Ranked Track 21");
  const projectionState = db.prepare(
    "SELECT row_count FROM ArtistTopTrackProjectionState WHERE artist_metadata_id = ?",
  ).get(artistMetadata.id) as { row_count: number } | undefined;
  assert.equal(
    projectionState?.row_count,
    100,
  );
});

test("artist list and album helper count canonical release groups and tracks", () => {
  const { artistId } = seedCanonicalArtistPage();

  // Credited-release rows are often written before the canonical Albums row is
  // assigned, so their integer FK may legitimately be null. They must still
  // collapse onto the same canonical release group instead of doubling stats.
  dbModule.db.prepare(`
    INSERT INTO ArtistReleaseGroups (
      artist_metadata_id, artist_mbid, release_group_id, release_group_mbid, relationship
    ) VALUES (
      (SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid-1'),
      'artist-mbid-1', NULL, 'release-group-mbid-1', 'primary'
    )
  `).run();

  // Statistics are precomputed off the request path (command workers refresh
  // them on scan); the list reads the cached ArtistStatistics table rather than
  // recomputing synchronously, so refresh once here to populate it.
  artistStatisticsModule.ArtistStatisticsService.refresh();

  const list = artistQueryModule.ArtistQueryService.listArtists({
    limit: 10,
    offset: 0,
    includeDownloadStats: false,
  });

  const artist = list.items.find((item: any) => item.id === artistId) as any;
  assert.ok(artist);
  assert.equal(artist?.album_count, 1);
  assert.equal(artist?.monitored_album_count, 1);
  assert.equal(artist?.track_count, 1);
  assert.equal(artist?.monitored_track_count, 1);

  const albums = artistQueryModule.ArtistQueryService.getArtistAlbums(artistId);
  assert.equal(albums.length, 1);
  assert.equal(albums[0].id, "release-group-mbid-1");
  assert.equal(albums[0].title, "Canonical Album");
  assert.equal(albums[0].source, "musicbrainz");
  assert.match(albums[0].cover_art_url, /^\/media-cover\/Albums\/release-group-mbid-1\/cover\.jpg\?source=canonical&rev=[a-f0-9]{16}$/);
  assert.equal(albums.some((album: any) => album.title === "Stale provider Album"), false);
});

test("artist list excludes unhydrated mbid-named shells until they gain library presence", () => {
  seedCanonicalArtistPage();

  const shellMbid = "0a1b2c3d-1111-2222-3333-444455556666";
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, library_origin, monitored)
    VALUES (?, ?, ?, 'musicbrainz-credit', 0)
  `).run(shellMbid, shellMbid, shellMbid);

  const list = artistQueryModule.ArtistQueryService.listArtists({
    limit: 50,
    offset: 0,
    includeDownloadStats: false,
    includeCounts: false,
  });
  assert.equal(list.items.some((item: any) => item.id === shellMbid), false);

  // Monitoring the shell makes it a managed artist again, so it must reappear
  // even while the display name is still the MBID placeholder.
  dbModule.db.prepare("UPDATE Artists SET monitored = 1 WHERE id = ?").run(shellMbid);
  const monitoredList = artistQueryModule.ArtistQueryService.listArtists({
    limit: 50,
    offset: 0,
    includeDownloadStats: false,
    includeCounts: false,
  });
  assert.equal(monitoredList.items.some((item: any) => item.id === shellMbid), true);
});

test("artist page album cards prefer cached Servarr Metadata Server artwork over provider fallback", async () => {
  const { artistId } = seedCanonicalArtistPage();
  const { db } = dbModule;
  const servarrMetadataUrl = "https://images.lidarr.audio/cache/https://coverartarchive.org/release/release-mbid-1/cover.jpg";

  db.prepare(`UPDATE Albums SET images = ? WHERE mbid = ?`)
    .run(
      JSON.stringify([{ coverType: "Cover", url: servarrMetadataUrl, source: "Servarr Metadata Server" }]),
      "release-group-mbid-1",
    );

  const page = await artistQueryModule.ArtistQueryService.getArtistPage(artistId);
  const albums = (page?.rows || [])
    .flatMap((row: any) => row.modules || [])
    .find((module: any) => module.title === "Albums")?.items || [];

  assert.equal(albums.length, 1);
  assert.match(albums[0].cover_art_url, /^\/media-cover\/Albums\/release-group-mbid-1\/cover\.jpg\?source=canonical&rev=[a-f0-9]{16}$/);
  assert.equal(albums[0].provider_cover_id, "13bb32e2-e326-4ee5-be74-f3320ad3379c");
});

test("artist page album cards resolve Servarr Metadata Server artwork before provider fallback on first load", async () => {
  const { artistId } = seedCanonicalArtistPage();
  const { db } = dbModule;
  const servarrMetadataUrl = "https://images.lidarr.audio/cache/https://coverartarchive.org/release/release-mbid-1/first-load.jpg";

  db.prepare(`UPDATE Albums SET images = ? WHERE mbid = ?`)
    .run(
      JSON.stringify([{ coverType: "Cover", url: servarrMetadataUrl, width: 1200, height: 1200 }]),
      "release-group-mbid-1",
    );

  const page = await artistQueryModule.ArtistQueryService.getArtistPage(artistId);
  const albums = (page?.rows || [])
    .flatMap((row: any) => row.modules || [])
    .find((module: any) => module.title === "Albums")?.items || [];

  assert.equal(albums.length, 1);
  assert.match(albums[0].cover_art_url, /^\/media-cover\/Albums\/release-group-mbid-1\/cover\.jpg\?source=canonical&rev=[a-f0-9]{16}$/);
  assert.equal(albums[0].provider_cover_id, "13bb32e2-e326-4ee5-be74-f3320ad3379c");
});

test("artist page uses provider fallback without hydrating missing release-group artwork", async () => {
  const { artistId } = seedCanonicalArtistPage();
  const { db } = dbModule;
  const originalSync = servarrMetadataModule.servarrMetadata.syncReleaseGroup;
  let syncCalled = false;
  const providerFallbackUrl = "https://resources.tidal.com/images/13bb32e2/e326/4ee5/be74/f3320ad3379c/750x750.jpg";

  db.prepare(`UPDATE Albums SET images = ? WHERE mbid = ?`)
    .run(
      JSON.stringify([{
        coverType: "Cover",
        url: providerFallbackUrl,
        source: "provider-fallback",
      }]),
      "release-group-mbid-1",
    );

  servarrMetadataModule.servarrMetadata.syncReleaseGroup = (async () => {
    syncCalled = true;
  }) as typeof servarrMetadataModule.servarrMetadata.syncReleaseGroup;

  try {
    const page = await artistQueryModule.ArtistQueryService.getArtistPage(artistId);
    const albums = (page?.rows || [])
      .flatMap((row: any) => row.modules || [])
      .find((module: any) => module.title === "Albums")?.items || [];

    assert.equal(albums.length, 1);
    assert.match(albums[0].cover_art_url, /^\/media-cover\/Albums\/release-group-mbid-1\/cover\.jpg\?source=canonical&rev=[a-f0-9]{16}$/);
    // provider_cover_id is the provider-native identifier (the plugin builds the
    // fetchable URL); core never renders it directly. The provider-fallback URL
    // stored in Albums.images surfaces only through the cached cover_art_url above.
    assert.equal(albums[0].provider_cover_id, "13bb32e2-e326-4ee5-be74-f3320ad3379c");
    assert.equal(syncCalled, false);
  } finally {
    servarrMetadataModule.servarrMetadata.syncReleaseGroup = originalSync;
  }
});

test("artist page uses selected provider artwork for blank release-group artwork without read-time hydration", async () => {
  const { artistId } = seedCanonicalArtistPage();
  const { db } = dbModule;
  const originalSync = servarrMetadataModule.servarrMetadata.syncReleaseGroup;
  let syncCalled = false;

  db.prepare(`UPDATE Albums SET images = NULL WHERE mbid = ?`)
    .run("release-group-mbid-1");

  servarrMetadataModule.servarrMetadata.syncReleaseGroup = (async () => {
    syncCalled = true;
  }) as typeof servarrMetadataModule.servarrMetadata.syncReleaseGroup;

  try {
    const page = await artistQueryModule.ArtistQueryService.getArtistPage(artistId);
    const albums = (page?.rows || [])
      .flatMap((row: any) => row.modules || [])
      .find((module: any) => module.title === "Albums")?.items || [];

    assert.equal(albums.length, 1);
    // Local media-cover URL is always emitted for the album MBID (bytes fill
    // lazily). Blank Albums.images must not trigger read-time Servarr hydration.
    assert.match(
      albums[0].cover_art_url,
      /^\/media-cover\/Albums\/release-group-mbid-1\/cover\.jpg\?source=canonical&rev=[a-f0-9]{16}$/,
    );
    assert.equal(albums[0].provider_cover_id, "13bb32e2-e326-4ee5-be74-f3320ad3379c");
    assert.equal(syncCalled, false);
  } finally {
    servarrMetadataModule.servarrMetadata.syncReleaseGroup = originalSync;
  }
});

test("artist activity tracks canonical queued work and ignores provider catalog refs", () => {
  const { artistId } = seedCanonicalArtistPage();
  const { db } = dbModule;

  db.prepare(`
    INSERT INTO commands (name, ref_id, payload, status)
    VALUES
      ('DownloadAlbum', 'release-group-mbid-1', '{"releaseGroupMbid":"release-group-mbid-1"}', 'queued'),
      ('DownloadTrack', '401', '{"canonicalTrackId":"401","canonicalTrackMbid":"track-mbid-1"}', 'queued'),
      ('DownloadVideo', '501', '{"canonicalRecordingId":"501"}', 'started'),
      ('DownloadAlbum', 'stale-provider-album', '{"providerId":"stale-provider-album"}', 'queued'),
      ('DownloadVideo', 'stale-provider-video', '{"providerId":"stale-provider-video"}', 'queued')
  `).run();

  const activity = artistQueryModule.ArtistQueryService.getArtistActivity(artistId);

  assert.equal(activity.downloading, true);
  assert.equal(activity.totalActive, 3);
  assert.deepEqual(
    activity.jobs.map((job) => job.type).sort(),
    ["DownloadAlbum", "DownloadTrack", "DownloadVideo"],
  );
});


