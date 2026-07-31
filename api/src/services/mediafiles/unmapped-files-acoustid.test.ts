import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-unmapped-acoustid-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let database: typeof import("../../database.js");
let serviceModule: typeof import("./unmapped-files.js");

before(async () => {
  database = await import("../../database.js");
  database.initDatabase();
  serviceModule = await import("./unmapped-files.js");
});

after(() => {
  database.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("unmapped AcoustID identification returns every canonical Track occurrence without choosing an Edition", async () => {
  const filePath = path.join(tempDir, "unknown.flac");
  fs.writeFileSync(filePath, "test placeholder");

  const artist = database.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES ('artist-mbid', 'Bastille')
    RETURNING id
  `).get() as { id: number };
  const album = database.db.prepare(`
    INSERT INTO Albums (mbid, artist_metadata_id, artist_mbid, title, primary_type)
    VALUES ('album-mbid', ?, 'artist-mbid', 'Canonical Album', 'album')
    RETURNING id
  `).get(artist.id) as { id: number };
  const recording = database.db.prepare(`
    INSERT INTO Recordings (
      mbid, artist_metadata_id, artist_mbid, title, is_video
    ) VALUES ('recording-mbid', ?, 'artist-mbid', 'Canonical Song', 0)
    RETURNING id
  `).get(artist.id) as { id: number };

  for (const suffix of ["one", "two"]) {
    const edition = database.db.prepare(`
      INSERT INTO AlbumEditions (
        mbid, release_group_id, release_group_mbid, artist_metadata_id,
        artist_mbid, title, date
      ) VALUES (?, ?, 'album-mbid', ?, 'artist-mbid', ?, ?)
      RETURNING id
    `).get(
      `edition-${suffix}`,
      album.id,
      artist.id,
      `Edition ${suffix}`,
      suffix === "one" ? "2020-01-01" : "2021-01-01",
    ) as { id: number };
    database.db.prepare(`
      INSERT INTO Tracks (
        mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
        title, medium_position, position
      ) VALUES (?, ?, ?, ?, 'recording-mbid', 'Canonical Song', 1, 1)
    `).run(`track-${suffix}`, edition.id, `edition-${suffix}`, recording.id);
  }

  const file = {
    id: 7,
    file_path: filePath,
    relative_path: "unknown.flac",
    library_root: "music",
    filename: "unknown.flac",
    extension: "flac",
    file_size: 16,
    duration: 180,
    bitrate: null,
    sample_rate: null,
    bit_depth: null,
    channels: null,
    codec: null,
    detected_artist: null,
    detected_album: null,
    detected_track: null,
    audio_quality: null,
    reason: "unmatched",
    ignored: false,
  };
  const repository = { findById: (id: number) => id === file.id ? file : undefined };
  const service = new serviceModule.UnmappedFilesService(
    repository as any,
    {} as any,
    async () => ({
      status: "matched",
      fingerprint: "fingerprint",
      duration: 180,
      cached: false,
      recordingIds: ["recording-mbid"],
      candidates: [],
      rejected: [],
    }),
    async () => null,
  );

  const result = await service.identifyFileByAcoustId(file.id);
  assert.equal(result.identification.status, "matched");
  assert.deepEqual(
    result.canonicalOccurrences.map((occurrence) => occurrence.releaseMbid),
    ["edition-one", "edition-two"],
  );
  assert.deepEqual(
    result.canonicalOccurrences.map((occurrence) => occurrence.trackMbid),
    ["track-one", "track-two"],
  );
});

test("unknown video suggestions come from canonical Recordings without consulting a provider", async () => {
  const artist = database.db.prepare(`
    SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'
  `).get() as { id: number };
  database.db.prepare(`
    INSERT INTO Recordings (
      mbid, artist_metadata_id, artist_mbid, title, artist_credit,
      length_ms, is_video
    ) VALUES (
      'video-recording-mbid', ?, 'artist-mbid', 'Pompeii',
      'Bastille', 220000, 1
    )
  `).run(artist.id);

  const videoFile = {
    id: 8,
    file_path: path.join(tempDir, "Pompeii.mp4"),
    relative_path: "Bastille/Pompeii.mp4",
    library_root: "videos",
    filename: "Pompeii.mp4",
    extension: "mp4",
    file_size: 100,
    duration: 220,
    bitrate: null,
    sample_rate: null,
    bit_depth: null,
    channels: null,
    codec: "h264",
    detected_artist: "Bastille",
    detected_album: null,
    detected_track: "Pompeii",
    audio_quality: null,
    reason: "unmatched",
    ignored: false,
  };
  const providerImport = {
    findMatchesForGroup: async () => {
      throw new Error("streaming provider must not identify manual imports");
    },
  };
  const service = new serviceModule.UnmappedFilesService(
    {} as any,
    providerImport as any,
  );
  const match = await service.findBestAlbumCandidate([videoFile] as any);

  assert.equal(match?.itemType, "video");
  assert.equal(match?.item?.mbid, "video-recording-mbid");
  assert.equal(match?.item?.title, "Pompeii");
  assert.equal(match?.matchType, "exact");
  assert.equal(match?.autoImportReady, false);
  assert.match(match?.rejections?.[0] || "", /destination Library and canonical MusicBrainz/);
});
