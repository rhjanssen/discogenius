import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createDomainSchemaV41 } from "../../database/schema/domain-v41.js";
import { ProviderReleaseIngestionService } from "./provider-release-ingestion-service.js";

function withDb(run: (db: Database.Database) => void): void {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-provider-release-ingestion-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createDomainSchemaV41(db);
    run(db);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
}

function trackMember(over: {
  providerId: string;
  title: string;
  mediumPosition: number;
  position: number;
  durationMs: number;
  isrc?: string;
  version?: string | null;
  contextualTitle?: string | null;
  contextualDurationMs?: number | null;
}) {
  return {
    item: {
      provider: "tidal",
      entityType: "track" as const,
      providerId: over.providerId,
      title: over.title,
      version: over.version ?? null,
      isrc: over.isrc,
      durationMs: over.durationMs,
      availability: "available" as const,
    },
    mediumPosition: over.mediumPosition,
    position: over.position,
    contextualTitle: over.contextualTitle ?? null,
    contextualDurationMs: over.contextualDurationMs ?? null,
  };
}

// The provider edition member — not the provider item — carries this release's
// structure. Ingestion used to feed the matcher nulls for medium/position, so a
// track whose only distinguishing evidence was its slot could not be matched.
// Bastille's "Give Me the Future + Dreams of the Past" is the real case: TIDAL
// flattens the disc-2 reprise to the plain base title, and the disc-1 original
// carries that exact title for real.
test("provider edition member structure decides the Bastille reprise", () => {
  withDb((db) => {
    db.exec(`
      INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-bastille', 'Bastille');
      INSERT INTO Albums (id, mbid, artist_metadata_id, title)
        VALUES (1, 'group-gmtf', 1, 'Give Me the Future + Dreams of the Past');
      INSERT INTO AlbumEditions (id, mbid, release_group_id, title)
        VALUES (1, '18d7cf25-d2fa-448a-ae11-72aa6b474a42', 1, 'Give Me the Future + Dreams of the Past');
      INSERT INTO Recordings (id, mbid, title, length_ms) VALUES
        (1, 'rec-dlb',          'Distorted Light Beam',           177000),
        (2, 'rec-thelma',       'Thelma + Louise',                138000),
        (3, 'rec-family-ties',  'Family Ties',                    167000),
        (4, 'rec-dlb-reprise',  'Distorted Light Beam (reprise)',  204000),
        (5, 'rec-revolution',   'Revolution',                     183000);
      INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title, length_ms) VALUES
        (1, 't-dlb',         1, 1, 1, 1, 'Distorted Light Beam',           177000),
        (2, 't-thelma',      1, 2, 1, 2, 'Thelma + Louise',                138000),
        (3, 't-family',      1, 3, 2, 3, 'Family Ties',                    167000),
        (4, 't-dlb-reprise', 1, 4, 2, 4, 'Distorted Light Beam (reprise)', 204000),
        (5, 't-revolution',  1, 5, 2, 5, 'Revolution',                     183000);
    `);

    const result = new ProviderReleaseIngestionService(db).ingest({
      canonicalReleaseId: 1,
      matcherVersion: 1,
      release: {
        provider: "tidal",
        entityType: "release",
        providerId: "243860257",
        title: "Give Me The Future + Dreams Of The Past",
        availability: "available",
      },
      members: [
        trackMember({ providerId: "p-dlb", title: "Distorted Light Beam", mediumPosition: 1, position: 1, durationMs: 177000 }),
        trackMember({ providerId: "p-thelma", title: "Thelma + Louise", mediumPosition: 1, position: 2, durationMs: 138000 }),
        trackMember({ providerId: "p-family", title: "Family Ties", mediumPosition: 2, position: 3, durationMs: 167000 }),
        // TIDAL shows this as the plain base title; only the slot and runtime
        // distinguish it from the disc-1 original.
        trackMember({ providerId: "p-dlb-reprise", title: "Distorted Light Beam", mediumPosition: 2, position: 4, durationMs: 204000 }),
        trackMember({ providerId: "p-revolution", title: "Revolution", mediumPosition: 2, position: 5, durationMs: 183000 }),
      ],
    });

    assert.equal(result.acceptedTrackCount, 5, "every canonical track must be assigned once");
    assert.equal(result.ambiguousTrackCount, 0);

    const assignments = db.prepare(`
      SELECT t.title AS canonical_title, pi.provider_id AS provider_track, ptm.match_state, ptm.method
      FROM ProviderTrackMatches ptm
      JOIN Tracks t ON t.id = ptm.track_id
      JOIN ProviderEditionMembers mem ON mem.id = ptm.provider_edition_member_id
      JOIN ProviderItems pi ON pi.id = mem.member_item_id
      ORDER BY t.medium_position, t.position
    `).all() as Array<{ canonical_title: string; provider_track: string; match_state: string; method: string }>;

    assert.deepEqual(
      assignments.map((row) => [row.canonical_title, row.provider_track]),
      [
        ["Distorted Light Beam", "p-dlb"],
        ["Thelma + Louise", "p-thelma"],
        ["Family Ties", "p-family"],
        ["Distorted Light Beam (reprise)", "p-dlb-reprise"],
        ["Revolution", "p-revolution"],
      ],
      "The disc-2 reprise must take the disc-2 provider track, not consume the disc-1 original",
    );
    assert.ok(
      assignments.every((row) => row.match_state === "accepted"),
      "no canonical track may be left ambiguous when the slot proves the match",
    );

    const relation = db.prepare(
      "SELECT relation, matched_track_count, target_track_count FROM ProviderEditionMatches",
    ).get() as { relation: string; matched_track_count: number; target_track_count: number };
    assert.equal(relation.relation, "exact");
    assert.equal(relation.matched_track_count, 5);
    assert.equal(relation.target_track_count, 5);
  });
});

// Restoring structure must not let a track combined in from elsewhere claim a
// variant title. A one-sided qualifier is only credible at the SAME slot; live
// cuts routinely share the studio runtime, so duration alone proves nothing.
// This is the Amy Winehouse "Rehab (live at Kalkscheune, Berlin)" shape.
test("structure does not let a cross-slot studio track cover a live variant", () => {
  withDb((db) => {
    db.exec(`
      INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-amy', 'Amy Winehouse');
      INSERT INTO Albums (id, mbid, artist_metadata_id, title) VALUES (1, 'group-btb', 1, 'Back to Black');
      INSERT INTO AlbumEditions (id, mbid, release_group_id, title) VALUES (1, 'release-btb-de', 1, 'Back to Black (German edition)');
      INSERT INTO Recordings (id, mbid, title, length_ms) VALUES
        (1, 'rec-rehab-live', 'Rehab (live at Kalkscheune, Berlin)', 213000);
      -- The live session is its own medium; the provider has no Kalkscheune cut.
      INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title, length_ms) VALUES
        (1, 't-rehab-live', 1, 1, 3, 1, 'Rehab (live at Kalkscheune, Berlin)', 213000);
    `);

    const result = new ProviderReleaseIngestionService(db).ingest({
      canonicalReleaseId: 1,
      matcherVersion: 1,
      release: {
        provider: "tidal",
        entityType: "release",
        providerId: "back-to-black-standard",
        title: "Back to Black",
        availability: "available",
      },
      members: [
        // The studio cut on medium 1, sharing the live runtime exactly.
        trackMember({ providerId: "p-rehab-studio", title: "Rehab", mediumPosition: 1, position: 1, durationMs: 213000 }),
      ],
    });

    assert.equal(
      result.acceptedTrackCount,
      0,
      "a studio cut on another medium must not cover the live recording on runtime alone",
    );
  });
});

// A release can retitle or re-edit a track relative to the standalone item.
test("contextual member title and duration outrank the standalone item facts", () => {
  withDb((db) => {
    db.exec(`
      INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-a', 'Artist A');
      INSERT INTO Albums (id, mbid, artist_metadata_id, title) VALUES (1, 'group-a', 1, 'Group A');
      INSERT INTO AlbumEditions (id, mbid, release_group_id, title) VALUES (1, 'release-a', 1, 'Release A');
      INSERT INTO Recordings (id, mbid, title, length_ms) VALUES (1, 'rec-edit', 'Nightcall (radio edit)', 190000);
      INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title, length_ms) VALUES
        (1, 't-edit', 1, 1, 1, 4, 'Nightcall (radio edit)', 190000);
    `);

    const result = new ProviderReleaseIngestionService(db).ingest({
      canonicalReleaseId: 1,
      matcherVersion: 1,
      release: {
        provider: "tidal",
        entityType: "release",
        providerId: "release-with-edit",
        title: "Release A",
        availability: "available",
      },
      members: [trackMember({
        providerId: "p-nightcall",
        // The standalone item is the 300s album cut...
        title: "Nightcall",
        durationMs: 300000,
        // ...but on this release it is the 190s radio edit.
        contextualTitle: "Nightcall (radio edit)",
        contextualDurationMs: 190000,
        mediumPosition: 1,
        position: 4,
      })],
    });

    assert.equal(result.acceptedTrackCount, 1);
    const match = db.prepare(
      "SELECT track_id, duration_delta_ms FROM ProviderTrackMatches WHERE match_state = 'accepted'",
    ).get() as { track_id: number; duration_delta_ms: number };
    assert.equal(match.track_id, 1);
    assert.equal(match.duration_delta_ms, 0, "duration delta must use the contextual runtime");
  });
});

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
      INSERT INTO AlbumEditions (id, mbid, release_group_id, title)
        VALUES (1, 'release-a', 1, 'Release A'), (2, 'release-b', 2, 'Release B');
      INSERT INTO Recordings (id, mbid, title, length_ms, isrcs)
        VALUES
          (1, 'recording-exact', 'Opening', 180000, '["USAAA2600001"]'),
          (2, 'recording-original', 'Theme', 200000, NULL),
          (3, 'recording-instrumental', 'Theme', 200000, NULL);
      INSERT INTO Tracks (
        id, mbid, album_edition_id, recording_id, medium_position, position, title, length_ms
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
      `).all(first.providerEditionItemId),
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
        SELECT release.provider_id AS edition_id, member.position
        FROM ProviderEditionMembers member
        JOIN ProviderItems release ON release.id = member.provider_edition_item_id
        JOIN ProviderItems track ON track.id = member.member_item_id
        WHERE track.provider_id = 'shared-track'
        ORDER BY release.provider_id
      `).all(),
      [
        { edition_id: "provider-release-a", position: 1 },
        { edition_id: "provider-release-b", position: 1 },
      ],
      "One provider track identity must retain distinct membership occurrences",
    );
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
