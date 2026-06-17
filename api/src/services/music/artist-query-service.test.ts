import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-artist-query-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let artistQueryModule: typeof import("./artist-query-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  artistQueryModule = await import("./artist-query-service.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM ProviderMediaArtists").run();
  db.prepare("DELETE FROM ProviderAlbumArtists").run();
  db.prepare("DELETE FROM ProviderMedia").run();
  db.prepare("DELETE FROM ProviderAlbums").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumReleases").run();
  db.prepare("DELETE FROM ReleaseGroupSlots").run();
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
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES ('release-group-mbid-1', 'artist-mbid-1', 'Canonical Album', 'Album', '2024-01-01')
  `).run();

  db.prepare(`
    INSERT INTO AlbumReleases (
      id, foreign_release_id, mbid, release_group_mbid, artist_mbid,
      title, status, country, date, media_count, track_count
    )
    VALUES (
      201, 'release-mbid-1', 'release-mbid-1', 'release-group-mbid-1', 'artist-mbid-1',
      'Canonical Album', 'Official', 'XW', '2024-01-01', 1, 1
    )
  `).run();

  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored,
      selected_provider, selected_provider_id, selected_release_mbid, quality, monitored_lock, provider_data
    )
    VALUES (
      'artist-mbid-1', 'release-group-mbid-1', 'stereo', 1,
      'tidal', 'provider-album-1', 'release-mbid-1', 'LOSSLESS', 1, '{"cover":"13bb32e2-e326-4ee5-be74-f3320ad3379c"}'
    )
  `).run();

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
      provider, entity_type, provider_id, artist_mbid, release_group_mbid,
      release_mbid, track_mbid, recording_mbid, title, quality, asset_id,
      duration, library_slot, album_release_id, track_id, recording_id,
      match_status, match_confidence
    )
    VALUES (
      'tidal', 'track', 'provider-track-1', 'artist-mbid-1', 'release-group-mbid-1',
      'release-mbid-1', 'track-mbid-1', 'recording-mbid-1', 'Canonical Track', 'LOSSLESS', '13bb32e2-e326-4ee5-be74-f3320ad3379c',
      180, 'stereo', 201, 401, 301, 'verified', 0.99
    )
  `).run();

  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid,
      release_mbid, title, quality, asset_id, library_slot, album_release_id,
      match_status, match_confidence, data
    )
    VALUES (
      'tidal', 'album', 'provider-album-1', 'artist-mbid-1', 'release-group-mbid-1',
      'release-mbid-1', 'Canonical Album', 'LOSSLESS', '13bb32e2-e326-4ee5-be74-f3320ad3379c', 'stereo', 201,
      'verified', 0.99, '{"cover":"13bb32e2-e326-4ee5-be74-f3320ad3379c","trackCount":1,"volumeCount":1}'
    )
  `).run();

  db.prepare(`
    INSERT INTO Recordings (
      id, foreign_recording_id, mbid, artist_metadata_id, artist_mbid,
      title, length_ms, is_video, metadata_status, release_date, cover_image_id, monitored
    )
    VALUES (
      501, 'provider-video-1', NULL, ?, 'artist-mbid-1',
      'Canonical Video', 210000, 1, 'provider_only', '2024-02-01', 'video-cover', 1
    )
  `).run(artistMetadata.id);

  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, recording_id,
      title, quality, duration, release_date, asset_id, provider_url,
      match_status, match_confidence
    )
    VALUES (
      'tidal', 'video', 'provider-video-1', 'artist-mbid-1', 501,
      'Canonical Video', 'FHD', 210, '2024-02-01', 'video-offer-cover',
      'https://tidal.com/browse/video/provider-video-1', 'verified', 0.99
    )
  `).run();

  db.prepare(`
    INSERT INTO ProviderAlbums (
      id, artist_id, title, type, explicit, quality, num_tracks, num_volumes,
      num_videos, duration, monitored, mb_release_group_id
    )
    VALUES ('stale-provider-album', 'artist-1', 'Stale provider Album', 'ALBUM', 0, 'LOSSLESS', 1, 1,
      0, 180, 1, NULL)
  `).run();

  db.prepare(`
    INSERT INTO ProviderAlbumArtists (album_id, artist_id, type, group_type)
    VALUES ('stale-provider-album', 'artist-mbid-1', 'MAIN', 'ALBUMS')
  `).run();

  db.prepare(`
    INSERT INTO ProviderMedia (
      id, album_id, artist_id, title, type, explicit, quality, duration, monitored
    )
    VALUES ('stale-provider-video', NULL, 'artist-1', 'Stale provider Video', 'Music Video', 0, 'FHD', 210, 1)
  `).run();

  return { artistId: "artist-1" };
}

test("artist page uses canonical release groups, tracks, and video recordings", async () => {
  const { artistId } = seedCanonicalArtistPage();

  const page = await artistQueryModule.ArtistQueryService.getArtistPageDb(artistId);
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
  assert.match(albums[0].cover_art_url, /^\/MediaCoverProxy\//);
  assert.equal(albums[0].provider_cover_id, "https://resources.tidal.com/images/13bb32e2/e326/4ee5/be74/f3320ad3379c/750x750.jpg");
  assert.equal(albums.some((album: any) => album.title === "Stale provider Album"), false);

  assert.equal(topTracks.length, 1);
  assert.equal(topTracks[0].id, "track-mbid-1");
  assert.equal(topTracks[0].album?.id, "release-group-mbid-1");
  assert.equal(topTracks[0].album?.title, "Canonical Album");

  assert.equal(videos.length, 1);
  assert.equal(videos[0].id, "501");
  assert.equal(videos[0].title, "Canonical Video");
  assert.equal(videos[0].is_monitored, true);
  assert.equal(videos.some((video: any) => video.title === "Stale provider Video"), false);
});

test("artist list and album helper count canonical release groups and tracks", () => {
  const { artistId } = seedCanonicalArtistPage();

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
  assert.match(albums[0].cover_art_url, /^\/MediaCoverProxy\//);
  assert.equal(albums.some((album: any) => album.title === "Stale provider Album"), false);
});

test("artist activity tracks canonical queued work and ignores provider catalog refs", () => {
  const { artistId } = seedCanonicalArtistPage();
  const { db } = dbModule;

  db.prepare(`
    INSERT INTO job_queue (type, ref_id, payload, status)
    VALUES
      ('DownloadAlbum', 'release-group-mbid-1', '{"releaseGroupMbid":"release-group-mbid-1"}', 'pending'),
      ('DownloadTrack', '401', '{"canonicalTrackId":"401","canonicalTrackMbid":"track-mbid-1"}', 'pending'),
      ('DownloadVideo', '501', '{"canonicalRecordingId":"501"}', 'processing'),
      ('DownloadAlbum', 'stale-provider-album', '{"providerId":"stale-provider-album"}', 'pending'),
      ('DownloadVideo', 'stale-provider-video', '{"providerId":"stale-provider-video"}', 'pending')
  `).run();

  const activity = artistQueryModule.ArtistQueryService.getArtistActivity(artistId);

  assert.equal(activity.downloading, true);
  assert.equal(activity.totalActive, 3);
  assert.deepEqual(
    activity.jobs.map((job) => job.type).sort(),
    ["DownloadAlbum", "DownloadTrack", "DownloadVideo"],
  );
});
