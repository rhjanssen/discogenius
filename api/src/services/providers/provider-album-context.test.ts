import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { seedSelectedAcquisitionPlan } from "../../test-support/acquisition-plan-fixture.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-provider-album-context-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let scopeModule: typeof import("./provider-item-artist-scope.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  scopeModule = await import("./provider-item-artist-scope.js");
});

beforeEach(() => {
  const { db } = dbModule;
  // Release the deferred plan reference before the plan rows go.
  db.prepare("UPDATE LibraryEditions SET preferred_plan_key = NULL").run();
  for (const table of [
    "AcquisitionPlanTracks", "AcquisitionPlanSources", "AcquisitionPlans",
    "LibraryEditions", "LibraryAlbums", "ProviderTrackMatches",
    "ProviderEditionMatches", "ProviderEditionMembers", "ProviderItemAudioVariants",
    "ProviderItems", "Tracks", "Recordings", "AlbumEditions", "Albums", "ArtistMetadata",
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  // Libraries/profiles are seeded per test with fixed names.
  db.prepare("DELETE FROM Libraries WHERE name LIKE 'lib-%'").run();
  db.prepare("DELETE FROM quality_profiles WHERE name LIKE 'qp-%'").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * One provider track that two libraries plan from DIFFERENT provider releases:
 * the stereo library acquires it from the standard album, the spatial library
 * from the deluxe edition. Both plans are current.
 */
function seedTwoPlansDisagreeing(): {
  providerTrackItemId: number;
  stereo: { libraryId: number; libraryEditionId: number; planId: number; canonicalTrackId: number; canonicalReleaseId: number };
  spatial: { libraryId: number; libraryEditionId: number; planId: number; canonicalTrackId: number; canonicalReleaseId: number };
} {
  const { db } = dbModule;
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES ('artist-mbid', 'Bastille')").run();
  const artist = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number };
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, artist_metadata_id, title, primary_type)
    VALUES ('rg-1', 'artist-mbid', ?, 'Bad Blood', 'Album')
  `).run(artist.id);
  const releaseGroup = db.prepare("SELECT id FROM Albums WHERE mbid = 'rg-1'").get() as { id: number };
  db.prepare("INSERT INTO Recordings (mbid, artist_mbid, title, length_ms) VALUES ('rec-1', 'artist-mbid', 'Pompeii', 214000)").run();
  const recording = db.prepare("SELECT id FROM Recordings WHERE mbid = 'rec-1'").get() as { id: number };

  // One provider track item, reachable from two provider releases.
  const providerTrack = db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
    VALUES ('tidal', 'track', 'tidal-track-1', 'Pompeii') RETURNING id
  `).get() as { id: number };

  const build = (
    key: string,
    releaseMbid: string,
    providerEditionId: string,
    spatial: boolean,
  ) => {
    db.prepare(`
      INSERT INTO AlbumEditions (mbid, release_group_mbid, release_group_id, artist_mbid, artist_metadata_id, title, track_count)
      VALUES (?, 'rg-1', ?, 'artist-mbid', ?, 'Bad Blood', 1)
    `).run(releaseMbid, releaseGroup.id, artist.id);
    const release = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = ?").get(releaseMbid) as { id: number };
    const track = db.prepare(`
      INSERT INTO Tracks (mbid, release_mbid, album_edition_id, recording_mbid, recording_id, medium_position, position, title, length_ms)
      VALUES (?, ?, ?, 'rec-1', ?, 1, 1, 'Pompeii', 214000) RETURNING id
    `).get(`trk-${key}`, releaseMbid, release.id, recording.id) as { id: number };

    db.prepare(`
      INSERT INTO quality_profiles (name, allowed_source_formats, preference_order, cutoff, fallback_policy, output_format, transcode_policy)
      VALUES (?, ?, '[]', 'LOSSLESS', 'none', 'source', 'never')
    `).run(`qp-${key}`, spatial ? '["spatial"]' : '["lossless"]');
    const qualityProfile = db.prepare("SELECT id FROM quality_profiles WHERE name = ?").get(`qp-${key}`) as { id: number };
    const metadataProfile = db.prepare("SELECT id FROM MetadataProfiles ORDER BY id LIMIT 1").get() as { id: number };
    db.prepare(`
      INSERT INTO Libraries (name, root_path, metadata_profile_id, quality_profile_id)
      VALUES (?, ?, ?, ?)
    `).run(`lib-${key}`, path.join(tempDir, key), metadataProfile.id, qualityProfile.id);
    const library = db.prepare("SELECT id FROM Libraries WHERE name = ?").get(`lib-${key}`) as { id: number };
    db.prepare(`
      INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'auto', 0, 'test', 1)
    `).run(library.id, releaseGroup.id);
    const libraryRelease = db.prepare(`
      INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, reason, curation_version)
      VALUES (?, ?, 'auto', 'test', 1) RETURNING id
    `).get(library.id, release.id) as { id: number };

    // A DISTINCT provider release per library, both containing the same track.
    const providerRelease = db.prepare(`
      INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
      VALUES ('tidal', 'release', ?, 'Bad Blood') RETURNING id
    `).get(providerEditionId) as { id: number };
    const member = db.prepare(`
      INSERT INTO ProviderEditionMembers (provider_edition_item_id, member_item_id, medium_position, position)
      VALUES (?, ?, 1, 1) RETURNING id
    `).get(providerRelease.id, providerTrack.id) as { id: number };
    const releaseMatch = db.prepare(`
      INSERT INTO ProviderEditionMatches (
        provider_edition_item_id, edition_id, relation, match_state, decision_source,
        confidence, method, matcher_version
      ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 1, 'test', 1) RETURNING id
    `).get(providerRelease.id, release.id) as { id: number };
    const trackMatch = db.prepare(`
      INSERT INTO ProviderTrackMatches (
        provider_track_item_id, provider_edition_member_id, provider_edition_match_id,
        track_id, recording_id,
        match_state, decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, ?, ?, ?, 'accepted', 'automatic', 1, 'test', 1) RETURNING id
    `).get(providerTrack.id, member.id, releaseMatch.id, track.id, recording.id) as { id: number };
    const variant = db.prepare(`
      INSERT INTO ProviderItemAudioVariants (provider_item_id, variant_key, quality_class, availability)
      VALUES (?, ?, ?, 'available') RETURNING id
    `).get(providerTrack.id, `v-${key}`, spatial ? "spatial" : "lossless") as { id: number };

    const plan = seedSelectedAcquisitionPlan(db, { libraryEditionId: libraryRelease.id, provider: 'tidal' }) as { id: number };
    const source = db.prepare(`
      INSERT INTO AcquisitionPlanSources (plan_id, provider_edition_match_id, role, sort_order)
      VALUES (?, ?, 'primary', 0) RETURNING id
    `).get(plan.id, releaseMatch.id) as { id: number };
    db.prepare(`
      INSERT INTO AcquisitionPlanTracks (
        plan_id, track_id, source_id, provider_track_match_id, provider_audio_variant_id
      ) VALUES (?, ?, ?, ?, ?)
    `).run(plan.id, track.id, source.id, trackMatch.id, variant.id);

    return {
      libraryId: library.id,
      libraryEditionId: libraryRelease.id,
      planId: plan.id,
      canonicalTrackId: track.id,
      canonicalReleaseId: release.id,
    };
  };

  return {
    providerTrackItemId: providerTrack.id,
    stereo: build("stereo", "rel-standard", "tidal-album-standard", false),
    spatial: build("spatial", "rel-deluxe", "tidal-album-deluxe", true),
  };
}

function resolve(sql: string, params: Record<string, unknown>, itemId: number): string | null {
  const row = dbModule.db.prepare(`
    SELECT ${sql} AS album_id
    FROM ProviderItems pi
    WHERE pi.id = @itemId
  `).get({ ...params, itemId }) as { album_id: string | null };
  return row.album_id;
}

test("disagreeing current plans yield no release context without an explicit scope", () => {
  const seeded = seedTwoPlansDisagreeing();
  const sql = scopeModule.providerSelectedPlanAlbumIdSql();
  assert.equal(
    resolve(sql, {}, seeded.providerTrackItemId),
    null,
    "two libraries planning different provider releases must not produce a winner",
  );
});

test("an explicit plan, library release, library or canonical scope selects that plan's release", () => {
  const seeded = seedTwoPlansDisagreeing();

  assert.equal(
    resolve(scopeModule.providerSelectedPlanAlbumIdSql({ planId: true }), { planId: seeded.stereo.planId }, seeded.providerTrackItemId),
    "tidal-album-standard",
  );
  assert.equal(
    resolve(scopeModule.providerSelectedPlanAlbumIdSql({ planId: true }), { planId: seeded.spatial.planId }, seeded.providerTrackItemId),
    "tidal-album-deluxe",
  );
  assert.equal(
    resolve(
      scopeModule.providerSelectedPlanAlbumIdSql({ libraryEditionId: true }),
      { libraryEditionId: seeded.spatial.libraryEditionId },
      seeded.providerTrackItemId,
    ),
    "tidal-album-deluxe",
  );
  assert.equal(
    resolve(
      scopeModule.providerSelectedPlanAlbumIdSql({ libraryId: true }),
      { libraryId: seeded.stereo.libraryId },
      seeded.providerTrackItemId,
    ),
    "tidal-album-standard",
  );
  assert.equal(
    resolve(
      scopeModule.providerSelectedPlanAlbumIdSql({ canonicalTrackId: true }),
      { canonicalTrackId: seeded.spatial.canonicalTrackId },
      seeded.providerTrackItemId,
    ),
    "tidal-album-deluxe",
  );
  assert.equal(
    resolve(
      scopeModule.providerSelectedPlanAlbumIdSql({ canonicalReleaseId: true }),
      { canonicalReleaseId: seeded.stereo.canonicalReleaseId },
      seeded.providerTrackItemId,
    ),
    "tidal-album-standard",
  );
});

test("agreeing current plans still resolve without explicit context", () => {
  const seeded = seedTwoPlansDisagreeing();
  const { db } = dbModule;
  // Repoint the spatial plan at the SAME provider release as the stereo plan.
  const standardMatch = db.prepare(`
    SELECT release_match.id
    FROM ProviderEditionMatches release_match
    JOIN ProviderItems release_item ON release_item.id = release_match.provider_edition_item_id
    WHERE release_item.provider_id = 'tidal-album-standard'
  `).get() as { id: number };
  db.prepare("UPDATE AcquisitionPlanSources SET provider_edition_match_id = ? WHERE plan_id = ?")
    .run(standardMatch.id, seeded.spatial.planId);

  assert.equal(
    resolve(scopeModule.providerSelectedPlanAlbumIdSql(), {}, seeded.providerTrackItemId),
    "tidal-album-standard",
    "when every current plan agrees the shared release is safe to report",
  );
});

test("context-free resolution falls back to a unique membership, never to a guess", () => {
  const { db } = dbModule;
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES ('artist-mbid', 'Bastille')").run();
  const providerTrack = db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
    VALUES ('tidal', 'track', 'lone-track', 'Pompeii') RETURNING id
  `).get() as { id: number };
  const providerRelease = db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
    VALUES ('tidal', 'release', 'only-album', 'Bad Blood') RETURNING id
  `).get() as { id: number };
  db.prepare(`
    INSERT INTO ProviderEditionMembers (provider_edition_item_id, member_item_id, medium_position, position)
    VALUES (?, ?, 1, 1)
  `).run(providerRelease.id, providerTrack.id);

  // Single membership, no plans at all -> the membership is the context.
  assert.equal(
    resolve(scopeModule.PROVIDER_RESOLVED_ALBUM_ID_SQL, {}, providerTrack.id),
    "only-album",
  );

  // A second membership makes it ambiguous again.
  const second = db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
    VALUES ('tidal', 'release', 'other-album', 'Bad Blood (Deluxe)') RETURNING id
  `).get() as { id: number };
  db.prepare(`
    INSERT INTO ProviderEditionMembers (provider_edition_item_id, member_item_id, medium_position, position)
    VALUES (?, ?, 1, 2)
  `).run(second.id, providerTrack.id);

  assert.equal(
    resolve(scopeModule.PROVIDER_RESOLVED_ALBUM_ID_SQL, {}, providerTrack.id),
    null,
  );
});
