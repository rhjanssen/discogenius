import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { MusicBrainzRelease } from "./musicbrainz.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-mb-release-catalog-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.mb-release-catalog.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let catalogModule: typeof import("./musicbrainz-release-catalog.js");

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  catalogModule = await import("./musicbrainz-release-catalog.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM provider_release_matches").run();
  db.prepare("DELETE FROM musicbrainz_release_tracks").run();
  db.prepare("DELETE FROM musicbrainz_releases").run();
  db.prepare("DELETE FROM media_artists").run();
  db.prepare("DELETE FROM album_artists").run();
  db.prepare("DELETE FROM library_files").run();
  db.prepare("DELETE FROM media").run();
  db.prepare("DELETE FROM albums").run();
  db.prepare("DELETE FROM artists").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function release(seed: Partial<MusicBrainzRelease> & { id: string; title: string }): MusicBrainzRelease {
  return {
    id: seed.id,
    title: seed.title,
    barcode: seed.barcode ?? "012345678901",
    date: seed.date ?? "2024-01-01",
    country: seed.country ?? "XW",
    status: seed.status ?? "Official",
    releaseGroupId: seed.releaseGroupId ?? "mb-release-group-1",
    disambiguation: seed.disambiguation ?? null,
    labels: seed.labels ?? ["Label"],
    media: seed.media ?? [{ position: 1, format: "Digital Media", title: null }],
    tracks: seed.tracks ?? [],
    trackCount: seed.trackCount ?? seed.tracks?.length ?? 0,
    durationSeconds: seed.durationSeconds ?? null,
    artistCredits: seed.artistCredits ?? [{ id: "mb-artist-1", name: "Artist One" }],
  };
}

function seedLocalAlbum() {
  dbModule.db.prepare(`
    INSERT INTO artists (id, name, monitor)
    VALUES (?, ?, ?)
  `).run(1, "Artist One", 1);

  dbModule.db.prepare(`
    INSERT INTO albums (
      id, artist_id, title, version, release_date, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, upc, monitor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(10, 1, "Album", "Deluxe Edition", "2024-01-01", "ALBUM", 1, "LOSSLESS", 2, 1, 0, 360, "012345678901", 0);

  dbModule.db.prepare(`
    INSERT INTO media (
      id, artist_id, album_id, title, release_date, type, explicit, quality,
      track_number, volume_number, duration, isrc, monitor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(100, 1, 10, "Song One", "2024-01-01", "Track", 1, "LOSSLESS", 1, 1, 180, "USABC2400001", 0);

  dbModule.db.prepare(`
    INSERT INTO media (
      id, artist_id, album_id, title, release_date, type, explicit, quality,
      track_number, volume_number, duration, isrc, monitor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(101, 1, 10, "Song Two", "2024-01-01", "Track", 1, "LOSSLESS", 2, 1, 180, null, 0);
}

test("enrichAlbumWithMusicBrainzRelease matches cached exact releases by UPC and updates recording IDs", async () => {
  seedLocalAlbum();

  catalogModule.upsertMusicBrainzReleaseSnapshot(release({
    id: "mb-release-wrong",
    title: "Different Album",
    trackCount: 12,
  }), dbModule.db);
  catalogModule.upsertMusicBrainzReleaseSnapshot(release({
    id: "mb-release-deluxe",
    title: "Album",
    disambiguation: "Deluxe Edition",
    tracks: [
      {
        id: "mb-track-1",
        recordingId: "mb-recording-1",
        title: "Song One",
        mediumNumber: 1,
        trackNumber: "1",
        absoluteTrackNumber: 1,
        durationSeconds: 180,
        isrcs: ["USABC2400001"],
      },
      {
        id: "mb-track-2",
        recordingId: "mb-recording-2",
        title: "Song Two",
        mediumNumber: 1,
        trackNumber: "2",
        absoluteTrackNumber: 2,
        durationSeconds: 180,
        isrcs: [],
      },
    ],
  }), dbModule.db);

  const result = await catalogModule.enrichAlbumWithMusicBrainzRelease(10, { database: dbModule.db });

  assert.equal(result.matched, true);
  assert.equal(result.releaseId, "mb-release-deluxe");
  assert.equal(result.updatedTracks, 2);

  const album = dbModule.db.prepare(`
    SELECT mbid, mb_release_group_id
    FROM albums
    WHERE id = 10
  `).get() as { mbid: string | null; mb_release_group_id: string | null };
  assert.equal(album.mbid, "mb-release-deluxe");
  assert.equal(album.mb_release_group_id, "mb-release-group-1");

  const tracks = dbModule.db.prepare(`
    SELECT id, mbid
    FROM media
    WHERE album_id = 10
    ORDER BY id
  `).all() as Array<{ id: number; mbid: string | null }>;
  assert.deepEqual(tracks, [
    { id: 100, mbid: "mb-recording-1" },
    { id: 101, mbid: "mb-recording-2" },
  ]);

  const providerMatch = dbModule.db.prepare(`
    SELECT provider, provider_album_id, musicbrainz_release_mbid, match_method
    FROM provider_release_matches
  `).get() as any;
  assert.deepEqual(providerMatch, {
    provider: "tidal",
    provider_album_id: "10",
    musicbrainz_release_mbid: "mb-release-deluxe",
    match_method: "barcode",
  });
});
