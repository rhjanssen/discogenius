import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createDomainSchemaV41 } from "../../database/schema/domain-v41.js";
import { ProviderReleaseIngestionService } from "./provider-release-ingestion-service.js";

test("normalized provider ingestion preserves membership reuse, credits, and ambiguous repeated titles", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-provider-release-ingestion-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createDomainSchemaV41(db);
    db.exec(`
      INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-a', 'Artist A');
      INSERT INTO Albums (id, mbid, artist_metadata_id, title)
        VALUES (1, 'group-a', 1, 'Release Group A'), (2, 'group-b', 1, 'Release Group B');
      INSERT INTO AlbumReleases (id, mbid, release_group_id, title)
        VALUES (1, 'release-a', 1, 'Release A'), (2, 'release-b', 2, 'Release B');
      INSERT INTO Recordings (id, mbid, title, length_ms, isrcs)
        VALUES
          (1, 'recording-exact', 'Opening', 180000, '["USAAA2600001"]'),
          (2, 'recording-original', 'Theme', 200000, NULL),
          (3, 'recording-instrumental', 'Theme', 200000, NULL);
      INSERT INTO Tracks (
        id, mbid, album_release_id, recording_id, medium_position, position, title, length_ms
      ) VALUES
        (1, 'track-exact', 1, 1, 1, 1, 'Opening', 180000),
        (2, 'track-original', 1, 2, 1, 2, 'Theme', 200000),
        (3, 'track-instrumental', 1, 3, 2, 2, 'Theme', 200000),
        (4, 'track-reused', 2, 1, 1, 1, 'Opening', 180000);
    `);
    const service = new ProviderReleaseIngestionService(db);
    const first = service.ingest({
      canonicalReleaseId: 1,
      matcherVersion: 1,
      release: {
        provider: "tidal",
        entityType: "release",
        providerId: "provider-release-a",
        title: "Release A",
        availability: "available",
      },
      releaseCredits: [
        {
          providerId: "artist-primary",
          name: "Artist A",
          ordinal: 0,
          normalizedRole: "primary",
          providerRole: "MAIN",
        },
        {
          providerId: "artist-featured",
          name: "Featured Artist",
          ordinal: 1,
          joinPhrase: " feat. ",
          normalizedRole: "featured",
          providerRole: "FEATURED",
        },
      ],
      members: [
        {
          item: {
            provider: "tidal",
            entityType: "track",
            providerId: "shared-track",
            title: "Opening",
            isrc: "US-AAA-26-00001",
            durationMs: 180000,
            availability: "available",
          },
          mediumPosition: 1,
          position: 1,
          audioVariants: [{
            variantKey: "lossless",
            qualityClass: "lossless",
            availability: "available",
          }],
        },
        {
          item: {
            provider: "tidal",
            entityType: "track",
            providerId: "ambiguous-theme",
            title: "Theme",
            durationMs: 200000,
            availability: "available",
          },
          mediumPosition: 1,
          position: 2,
          audioVariants: [{
            variantKey: "lossless",
            qualityClass: "lossless",
            availability: "available",
          }],
        },
      ],
    });
    assert.equal(first.acceptedTrackCount, 1);
    assert.equal(first.ambiguousTrackCount, 1);
    assert.ok(first.releaseMatchId);
    assert.deepEqual(
      db.prepare(`
        SELECT match_state, track_id, recording_id, method
        FROM ProviderTrackMatches
        ORDER BY match_state, recording_id
      `).all(),
      [
        {
          match_state: "accepted",
          track_id: 1,
          recording_id: 1,
          method: "external_id",
        },
        {
          match_state: "ambiguous",
          track_id: null,
          recording_id: 2,
          method: "title_duration_ambiguous",
        },
      ],
      "Repeated titles on different discs must not be assigned by position",
    );
    assert.deepEqual(
      db.prepare(`
        SELECT credit.ordinal, credit.credited_name, credit.join_phrase,
               credit.normalized_role, credit.provider_role, artist.provider_id
        FROM ProviderItemCredits credit
        JOIN ProviderItems artist ON artist.id = credit.artist_item_id
        WHERE credit.item_id = ?
        ORDER BY credit.ordinal
      `).all(first.providerReleaseItemId),
      [
        {
          ordinal: 0,
          credited_name: "Artist A",
          join_phrase: "",
          normalized_role: "primary",
          provider_role: "MAIN",
          provider_id: "artist-primary",
        },
        {
          ordinal: 1,
          credited_name: "Featured Artist",
          join_phrase: " feat. ",
          normalized_role: "featured",
          provider_role: "FEATURED",
          provider_id: "artist-featured",
        },
      ],
    );

    service.ingest({
      canonicalReleaseId: 2,
      matcherVersion: 1,
      release: {
        provider: "tidal",
        entityType: "release",
        providerId: "provider-release-b",
        title: "Release B",
        availability: "available",
      },
      members: [{
        item: {
          provider: "tidal",
          entityType: "track",
          providerId: "shared-track",
          title: "Opening",
          isrc: "USAAA2600001",
          durationMs: 180000,
          availability: "available",
        },
        mediumPosition: 1,
        position: 1,
        audioVariants: [{
          variantKey: "lossless",
          qualityClass: "lossless",
          availability: "available",
        }],
      }],
    });
    assert.equal(
      (db.prepare(`
        SELECT COUNT(*) AS count
        FROM ProviderItems
        WHERE provider = 'tidal' AND entity_type = 'track' AND provider_id = 'shared-track'
      `).get() as { count: number }).count,
      1,
    );
    assert.deepEqual(
      db.prepare(`
        SELECT release.provider_id AS release_id, member.position
        FROM ProviderEditionMembers member
        JOIN ProviderItems release ON release.id = member.provider_edition_item_id
        JOIN ProviderItems track ON track.id = member.member_item_id
        WHERE track.provider_id = 'shared-track'
        ORDER BY release.provider_id
      `).all(),
      [
        { release_id: "provider-release-a", position: 1 },
        { release_id: "provider-release-b", position: 1 },
      ],
      "One provider track identity must retain distinct membership occurrences",
    );
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
