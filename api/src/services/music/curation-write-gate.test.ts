import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
  seedLibraryArtistMonitoring,
} from "../../test-support/active-schema-fixture.js";
import { PROVIDER_TRACK_MATCHER_VERSION } from "./provider-track-matcher.js";

const { tempDir } = prepareActiveSchemaEnv("curation-write-gate");
const { db, dbModule } = await openActiveSchemaDb();
after(() => closeActiveSchemaDb(dbModule, tempDir));
const { CurationService } = await import("./curation-service.js");

const ARTIST_MBID = "bastille-gate";
const EDITIONS = [101, 102, 103, 104];

function seedArtistWithTidalEditions(): void {
  db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, ?, 'Bastille')").run(ARTIST_MBID);
  for (const editionId of EDITIONS) {
    const albumId = editionId - 100;
    db.prepare(`
      INSERT INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title, primary_type)
      VALUES (?, ?, 1, ?, ?, 'Album')
    `).run(albumId, `group-${albumId}`, ARTIST_MBID, `Album ${albumId}`);
    db.prepare(`
      INSERT INTO AlbumEditions (id, mbid, release_group_id, release_group_mbid, artist_mbid, title, status, media_count)
      VALUES (?, ?, ?, ?, ?, ?, 'Official', 1)
    `).run(editionId, `edition-${editionId}`, albumId, `group-${albumId}`, ARTIST_MBID, `Album ${albumId}`);
    db.prepare("INSERT INTO Recordings (id, mbid, title) VALUES (?, ?, ?)")
      .run(editionId, `recording-${editionId}`, `Song ${albumId}`);
    db.prepare(`
      INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, recording_mbid, release_mbid, medium_position, position, title)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)
    `).run(editionId, `track-${editionId}`, editionId, editionId, `recording-${editionId}`, `edition-${editionId}`, `Song ${albumId}`);

    db.prepare(`
      INSERT INTO ProviderItems (id, provider, entity_type, provider_id, availability)
      VALUES (?, 'tidal', 'release', ?, 'available')
    `).run(10_000 + editionId, `release-${editionId}`);
    db.prepare(`
      INSERT INTO ProviderEditionMatches (
        id, provider_edition_item_id, edition_id, relation, match_state, decision_source, confidence,
        method, matcher_version, matched_track_count, source_track_count, target_track_count,
        source_coverage, target_coverage
      ) VALUES (?, ?, ?, 'exact', 'accepted', 'automatic', 1, 'fixture', 1, 1, 1, 1, 1, 1)
    `).run(20_000 + editionId, 10_000 + editionId, editionId);
    db.prepare(`
      INSERT INTO ProviderItems (id, provider, entity_type, provider_id, availability)
      VALUES (?, 'tidal', 'track', ?, 'available')
    `).run(30_000 + editionId, `track-${editionId}`);
    db.prepare(`
      INSERT INTO ProviderEditionMembers (id, provider_edition_item_id, member_item_id, medium_position, position)
      VALUES (?, ?, ?, 1, 1)
    `).run(40_000 + editionId, 10_000 + editionId, 30_000 + editionId);
    db.prepare(`
      INSERT INTO ProviderItemAudioVariants (id, provider_item_id, variant_key, quality_class, availability)
      VALUES (?, ?, 'lossless', 'lossless', 'available')
    `).run(60_000 + editionId, 30_000 + editionId);
    db.prepare(`
      INSERT INTO ProviderTrackMatches (
        id, provider_track_item_id, provider_edition_member_id, provider_edition_match_id, track_id,
        recording_id, match_state, decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', 'automatic', 1, 'fixture', ${PROVIDER_TRACK_MATCHER_VERSION})
    `).run(50_000 + editionId, 30_000 + editionId, 40_000 + editionId, 20_000 + editionId, editionId, editionId);
  }
  seedLibraryArtistMonitoring(db, ARTIST_MBID);
}

function monitoredEditionCount(): number {
  return (db.prepare(`
    SELECT COUNT(*) AS count FROM LibraryEditions WHERE edition_id IN (${EDITIONS.join(",")})
  `).get() as { count: number }).count;
}

test("curating an artist lets other writers in before its decision lands", async () => {
  seedArtistWithTidalEditions();

  const curating = CurationService.processAll(ARTIST_MBID);
  // A user action or a worker write arriving while a large catalogue curates.
  const monitoredWhenOtherWriterRan = dbModule.withSqliteWriteGate(
    () => monitoredEditionCount(),
    "test:other-writer",
  );

  await curating;
  assert.equal(
    await monitoredWhenOtherWriterRan,
    0,
    "the other writer waited for the whole curation instead of the next edition's plan",
  );
  assert.ok(monitoredEditionCount() > 0, "curation still selected the artist's editions");
});
