import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createDomainSchemaV41 } from "../../database/schema/domain-v41.js";
import { ProviderReleaseIngestionService } from "../providers/provider-release-ingestion-service.js";
import { LibraryReleaseSelectionService } from "./library-release-selection-service.js";

test("manual library release selection persists a locked choice and normalized acquisition plan", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-library-selection-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createDomainSchemaV41(db);
    db.exec(`
      INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-bastille', 'Bastille');
      INSERT INTO Albums (id, mbid, artist_metadata_id, title)
      VALUES (1, 'group-doom-days', 1, 'Doom Days');
      INSERT INTO AlbumEditions (
        id, mbid, release_group_id, title, status, country, date, media_count, track_count
      ) VALUES (1, 'release-doom-days', 1, 'Doom Days', 'Official', 'GB', '2019-06-14', 1, 2);
      INSERT INTO Recordings (id, mbid, title, length_ms, isrcs)
      VALUES
        (1, 'recording-quarter-past-midnight', 'Quarter Past Midnight', 199000, '["GBUM71801770"]'),
        (2, 'recording-bad-decisions', 'Bad Decisions', 190000, '["GBUM71901234"]');
      INSERT INTO Tracks (
        id, mbid, album_edition_id, recording_id, medium_position, position, title, length_ms
      ) VALUES
        (1, 'track-quarter-past-midnight', 1, 1, 1, 1, 'Quarter Past Midnight', 199000),
        (2, 'track-bad-decisions', 1, 2, 1, 2, 'Bad Decisions', 190000);
      INSERT INTO MetadataProfiles (
        id, name, release_type_policy, explicit_policy, require_provider_availability, redundancy_enabled
      ) VALUES (1, 'Default', '{}', 'allow', 1, 0);
      INSERT INTO quality_profiles (
        id, name, allowed_source_formats, preference_order, cutoff,
        continue_upgrades, fallback_policy, output_format, transcode_policy
      ) VALUES (
        1, 'High Quality', '["lossless"]', '["lossless"]', 'lossless',
        0, 'best_allowed', '{"codec":"flac"}', 'preserve'
      );
      INSERT INTO Libraries (
        id, name, root_path, metadata_profile_id, quality_profile_id, enabled
      ) VALUES (1, 'Stereo', '/music/stereo', 1, 1, 1);
    `);

    new ProviderReleaseIngestionService(db).ingest({
      release: {
        provider: "tidal",
        entityType: "release",
        providerId: "tidal-doom-days",
        title: "Doom Days",
        availability: "available",
      },
      canonicalReleaseId: 1,
      matcherVersion: 1,
      releaseAudioVariants: [{
        variantKey: "lossless",
        qualityClass: "lossless",
        codec: "flac",
        availability: "available",
      }],
      members: [{
        item: {
          provider: "tidal",
          entityType: "track",
          providerId: "tidal-quarter-past-midnight",
          title: "Quarter Past Midnight",
          isrc: "GBUM71801770",
          durationMs: 199000,
          availability: "available",
        },
        mediumPosition: 1,
        position: 1,
      }, {
        item: {
          provider: "tidal",
          entityType: "track",
          providerId: "tidal-bad-decisions",
          title: "Bad Decisions",
          isrc: "GBUM71901234",
          durationMs: 190000,
          availability: "available",
        },
        mediumPosition: 1,
        position: 2,
      }],
    });

    const service = new LibraryReleaseSelectionService(db);
    const before = service.getAvailability("group-doom-days");
    assert.equal(before.libraries.length, 1);
    assert.deepEqual(before.libraries[0].selections, []);
    assert.equal(before.releases[0].offers[0].relation, "exact");
    assert.deepEqual(
      before.releases[0].offers[0].variants.map((variant) => variant.qualityClass),
      ["lossless"],
    );

    const after = service.selectRelease({
      releaseGroupMbid: "group-doom-days",
      libraryId: 1,
      releaseId: 1,
    });
    assert.deepEqual(after.libraries[0].selections.map((selection) => ({
      releaseId: selection.releaseId,
      selectionMode: selection.selectionMode,
      locked: selection.locked,
      composition: selection.plan?.composition,
      downloadMode: selection.plan?.downloadMode,
    })), [{
      releaseId: 1,
      selectionMode: "manual",
      locked: true,
      composition: "single_source",
      downloadMode: "album",
    }]);
    assert.deepEqual(db.prepare(`
      SELECT selection_mode, locked, monitored
      FROM LibraryAlbums
      WHERE library_id = 1 AND release_group_id = 1
    `).get(), { selection_mode: "manual", locked: 1, monitored: 1 });
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
