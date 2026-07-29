import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-tidal-provider-canonical-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../../database.js");
let tidalProviderModule: typeof import("./tidal-provider.js");

before(async () => {
  dbModule = await import("../../../database.js");
  dbModule.initDatabase();
  tidalProviderModule = await import("./tidal-provider.js");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedMatchedRelease(input: {
  suffix: string;
  providerReleaseId: string;
  title: string;
  trackTitles: string[];
}): void {
  const { db } = dbModule;
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, 'Canonical Artist')
    RETURNING id
  `).get(`artist-${input.suffix}`) as { id: number };
  const releaseGroup = db.prepare(`
    INSERT INTO Albums (mbid, artist_metadata_id, artist_mbid, title)
    VALUES (?, ?, ?, ?)
    RETURNING id
  `).get(
    `group-${input.suffix}`,
    artist.id,
    `artist-${input.suffix}`,
    input.title,
  ) as { id: number };
  const release = db.prepare(`
    INSERT INTO AlbumReleases (
      mbid, release_group_id, release_group_mbid, artist_metadata_id,
      artist_mbid, title, media_count, track_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    `release-${input.suffix}`,
    releaseGroup.id,
    `group-${input.suffix}`,
    artist.id,
    `artist-${input.suffix}`,
    input.title,
    input.trackTitles.length,
    input.trackTitles.length,
  ) as { id: number };

  input.trackTitles.forEach((title, index) => {
    const recording = db.prepare(`
      INSERT INTO Recordings (
        mbid, artist_metadata_id, artist_mbid, title, is_video
      ) VALUES (?, ?, ?, ?, 0)
      RETURNING id
    `).get(
      `recording-${input.suffix}-${index + 1}`,
      artist.id,
      `artist-${input.suffix}`,
      title,
    ) as { id: number };
    db.prepare(`
      INSERT INTO Tracks (
        mbid, album_release_id, release_mbid, recording_id, recording_mbid,
        title, medium_position, position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      `track-${input.suffix}-${index + 1}`,
      release.id,
      `release-${input.suffix}`,
      recording.id,
      `recording-${input.suffix}-${index + 1}`,
      title,
      index + 1,
    );
  });

  const providerRelease = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'release', ?, ?)
    RETURNING id
  `).get(input.providerReleaseId, input.title) as { id: number };
  db.prepare(`
    INSERT INTO ProviderReleaseMatches (
      provider_release_item_id, release_id, relation, match_state,
      decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 1, 'test', 1)
  `).run(providerRelease.id, release.id);
}

test("TIDAL album progress uses accepted release matches and preserves request order", () => {
  seedMatchedRelease({
    suffix: "first",
    providerReleaseId: "provider-album-1",
    title: "First Album",
    trackTitles: ["Track One", "Track Two"],
  });
  seedMatchedRelease({
    suffix: "second",
    providerReleaseId: "provider-album-2",
    title: "Second Album",
    trackTitles: ["Track Three"],
  });

  const rows = tidalProviderModule.getTidalAlbumDownloadTrackInfo([
    "provider-album-2",
    "provider-album-1",
  ]);

  assert.deepEqual(rows, [
    {
      title: "Track Three",
      version: null,
      track_num: 1,
      volume_num: 1,
      artist_name: "Canonical Artist",
    },
    {
      title: "Track One",
      version: null,
      track_num: 1,
      volume_num: 1,
      artist_name: "Canonical Artist",
    },
    {
      title: "Track Two",
      version: null,
      track_num: 1,
      volume_num: 2,
      artist_name: "Canonical Artist",
    },
  ]);

  const retired = dbModule.db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('ProviderAlbums', 'ProviderMedia')
  `).all();
  assert.deepEqual(retired, []);
});
