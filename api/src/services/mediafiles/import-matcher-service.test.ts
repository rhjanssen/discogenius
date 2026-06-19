import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LocalGroup } from "./import-types.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-import-matcher-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.import-matcher.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let importMatcherModule: typeof import("./import-matcher-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  importMatcherModule = await import("./import-matcher-service.js");
});

beforeEach(() => {
  for (const table of [
    "TrackFiles", "ProviderItems", "ReleaseGroupSlots", "Tracks", "Recordings",
    "AlbumReleases", "Albums", "ArtistMetadata", "Artists",
  ]) {
    dbModule.db.prepare(`DELETE FROM ${table}`).run();
  }
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedCanonicalFingerprintMatch() {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid");
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid,
      release_mbid, title, quality, library_slot, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "album",
    "provider-album",
    "artist-mbid",
    "release-group-mbid",
    "release-mbid",
    "Canonical Album",
    "LOSSLESS",
    "stereo",
    "2026-01-01T00:00:00.000Z",
  );
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid,
      release_mbid, track_mbid, recording_mbid, title, quality, library_slot,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "track",
    "provider-track",
    "artist-mbid",
    "release-group-mbid",
    "release-mbid",
    "track-mbid",
    "recording-mbid",
    "Canonical Track",
    "LOSSLESS",
    "stereo",
    "2026-01-01T00:00:00.000Z",
  );
  dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, album_id, media_id, canonical_artist_mbid, canonical_release_group_mbid,
      canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
      provider, library_slot,
      file_path, relative_path, library_root, filename, extension, file_type,
      quality, fingerprint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-local",
    null,
    null,
    "artist-mbid",
    "release-group-mbid",
    "release-mbid",
    "track-mbid",
    "recording-mbid",
    "tidal",
    "stereo",
    "C:/Music/Canonical Artist/Canonical Track.flac",
    "Canonical Artist/Canonical Track.flac",
    "C:/Music",
    "Canonical Track.flac",
    "flac",
    "track",
    "LOSSLESS",
    "fingerprint-match",
  );
}

function makeGroup(): LocalGroup {
  return {
    id: "group-1",
    path: "C:/Import/Canonical Artist/Canonical Album",
    rootPath: "C:/Import",
    libraryRoot: "music",
    sidecars: [],
    commonTags: {
      artist: "Canonical Artist",
      album: "Canonical Album",
    },
    status: "pending",
    files: [
      {
        path: "C:/Import/Canonical Artist/Canonical Album/Canonical Track.flac",
        name: "Canonical Track.flac",
        size: 100,
        extension: ".flac",
        fingerprint: "fingerprint-match",
        metadata: {
          common: {
            artist: "Canonical Artist",
            album: "Canonical Album",
            title: "Canonical Track",
          },
          format: {
            duration: 180,
          },
          native: {},
          quality: {
            warnings: [],
          },
        } as any,
      },
    ],
  };
}

test("fingerprint candidates use canonical ProviderItems without legacy provider rows", async () => {
  seedCanonicalFingerprintMatch();
  const matcher = new importMatcherModule.ImportMatcherService();
  (matcher as any).getProviderAlbum = async (albumId: string) => ({
    id: albumId,
    provider_id: albumId,
    title: "Canonical Album",
    artist: { name: "Canonical Artist" },
  });

  const evidence = await (matcher as any).getFingerprintCandidates(makeGroup(), "music");

  assert.equal(evidence.candidates.length, 1);
  assert.equal(evidence.candidates[0].provider_id, "provider-album");
  assert.deepEqual(Array.from(evidence.strongCandidateIds), ["provider-album"]);
  assert.equal(dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderMedia'").get(), undefined);
  assert.equal(dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderAlbums'").get(), undefined);
});
