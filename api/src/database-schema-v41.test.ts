import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createDomainSchemaV41 } from "./database/schema/domain-v41.js";

function withSchema(run: (db: Database.Database) => void): void {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-schema-v41-"));
  const file = path.join(folder, "discogenius.test.db");
  const db = new Database(file);
  try {
    db.pragma("foreign_keys = ON");
    createDomainSchemaV41(db);
    run(db);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
}

test("schema 41 separates canonical, provider, match, curation, and acquisition authorities", () => {
  withSchema((db) => {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map(({ name }) => name),
    );

    for (const name of [
      "ArtistMetadata",
      "Albums",
      "AlbumEditions",
      "Tracks",
      "Recordings",
      "ProviderItems",
      "ProviderEditionMembers",
      "ProviderItemCredits",
      "ProviderItemAudioVariants",
      "ProviderArtistMatches",
      "ProviderEditionMatches",
      "ProviderTrackMatches",
      "ProviderVideoMatches",
      "Libraries",
      "LibraryArtists",
      "LibraryReleaseGroups",
      "LibraryReleases",
      "LibraryReleaseScopes",
      "AcquisitionPlans",
      "AcquisitionPlanSources",
      "AcquisitionPlanTracks",
      "TrackFiles",
    ]) {
      assert.equal(tables.has(name), true, `${name} should exist`);
    }

    for (const retired of [
      "ProviderItemMatches",
      "ReleaseGroupSlots",
      "ReleaseGroupSlotTargets",
      "ReleaseGroupSlotSources",
      "ReleaseGroupSlotTrackAssignments",
    ]) {
      assert.equal(tables.has(retired), false, `${retired} should not exist`);
    }
  });
});

test("schema 41 relation tables use integer authorities without MBID shadows", () => {
  withSchema((db) => {
    const forbidden = /(_mbid|provider_album_id)$/i;
    for (const table of [
      "AlbumEditions",
      "Tracks",
      "ReleaseGroupArtistCredits",
      "ProviderEditionMembers",
      "ProviderArtistMatches",
      "ProviderEditionMatches",
      "ProviderTrackMatches",
      "LibraryReleaseGroups",
      "LibraryReleases",
      "AcquisitionPlanTracks",
      "TrackFiles",
    ]) {
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
      assert.deepEqual(columns.filter((name) => forbidden.test(name)), [], `${table} has a duplicate external join authority`);
    }
  });
});

test("schema 41 provider items contain provider-native facts only", () => {
  withSchema((db) => {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(ProviderItems)").all() as Array<{ name: string }>).map(({ name }) => name),
    );
    for (const required of ["id", "provider", "entity_type", "provider_id", "upc", "isrc", "availability", "checked_at"]) {
      assert.equal(columns.has(required), true, `ProviderItems.${required} should exist`);
    }
    for (const forbidden of [
      "artist_mbid",
      "release_group_mbid",
      "release_mbid",
      "track_mbid",
      "recording_mbid",
      "artist_metadata_id",
      "album_id",
      "album_edition_id",
      "track_id",
      "recording_id",
      "match_status",
      "match_confidence",
      "match_method",
      "match_evidence",
      "library_slot",
      "selected",
    ]) {
      assert.equal(columns.has(forbidden), false, `ProviderItems.${forbidden} should not exist`);
    }
  });
});

test("schema 41 validates provider membership, credits, and track recording identity", () => {
  withSchema((db) => {
    db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-mbid', 'Artist')").run();
    db.prepare("INSERT INTO Albums (id, mbid, artist_metadata_id, title) VALUES (1, 'group-mbid', 1, 'Release Group')").run();
    db.prepare("INSERT INTO AlbumEditions (id, mbid, release_group_id, title) VALUES (1, 'release-mbid', 1, 'Release')").run();
    db.prepare("INSERT INTO Recordings (id, mbid, title) VALUES (1, 'recording-a', 'A'), (2, 'recording-b', 'B')").run();
    db.prepare(`
      INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title)
      VALUES (1, 'track-a', 1, 1, 1, 1, 'A')
    `).run();
    db.prepare(`
      INSERT INTO ProviderItems (id, provider, entity_type, provider_id)
      VALUES
        (1, 'tidal', 'release', 'release-1'),
        (2, 'tidal', 'track', 'track-1'),
        (3, 'tidal', 'artist', 'artist-1')
    `).run();

    db.prepare(`
      INSERT INTO ProviderEditionMembers (id, provider_edition_item_id, member_item_id, position)
      VALUES (1, 1, 2, 1)
    `).run();
    db.prepare(`
      INSERT INTO ProviderItemCredits (item_id, artist_item_id, ordinal, credited_name, normalized_role)
      VALUES (1, 3, 0, 'Artist', 'primary')
    `).run();
    db.prepare(`
      INSERT INTO ProviderEditionMatches (
        id, provider_edition_item_id, edition_id, relation, match_state, decision_source,
        confidence, method, matcher_version
      ) VALUES (1, 1, 1, 'exact', 'accepted', 'automatic', 1, 'external_id', 1)
    `).run();
    db.prepare(`
      INSERT INTO ProviderTrackMatches (
        id, provider_edition_member_id, provider_edition_match_id, track_id, recording_id,
        match_state, decision_source, confidence, method, matcher_version
      ) VALUES (1, 1, 1, 1, 1, 'accepted', 'automatic', 1, 'external_id', 1)
    `).run();

    assert.throws(
      () => db.prepare(`
        INSERT INTO ProviderEditionMembers (provider_edition_item_id, member_item_id, position)
        VALUES (2, 3, 2)
      `).run(),
      /parent must be a release/,
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO ProviderTrackMatches (
          provider_edition_member_id, provider_edition_match_id, track_id, recording_id,
          match_state, decision_source, confidence, method, matcher_version
        ) VALUES (1, 1, 1, 2, 'accepted', 'automatic', 1, 'external_id', 1)
      `).run(),
      /recording disagrees/,
    );
  });
});
