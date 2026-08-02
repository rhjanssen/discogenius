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

// Acquisition plans reference the individual track matches they deliver. With
// no ON DELETE clause on that reference, a planned release used to make its own
// matches undeletable, so re-matching died on a foreign-key error and matching
// was frozen for every release that had ever been planned.
test("re-matching a planned release replaces its matches instead of failing", () => {
  withDb((db) => {
    db.exec(`
      INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-a', 'Artist A');
      INSERT INTO Albums (id, mbid, artist_metadata_id, title) VALUES (1, 'group-a', 1, 'Group A');
      INSERT INTO AlbumEditions (id, mbid, release_group_id, title) VALUES (1, 'release-a', 1, 'Release A');
      INSERT INTO Recordings (id, mbid, title, length_ms) VALUES (1, 'rec-a', 'Alpha', 200000);
      INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title, length_ms)
        VALUES (1, 't-a', 1, 1, 1, 1, 'Alpha', 200000);
      INSERT INTO MetadataProfiles (id, name, release_type_policy) VALUES (1, 'Standard', '{}');
      INSERT INTO quality_profiles (
        id, name, allowed_source_formats, preference_order, cutoff,
        fallback_policy, output_format, transcode_policy
      ) VALUES (1, 'Lossless', '[]', '[]', 'lossless', 'none', 'source', 'never');
      INSERT INTO Libraries (id, name, root_path, metadata_profile_id, quality_profile_id)
        VALUES (1, 'Stereo', '/library/stereo', 1, 1);
    `);

    const service = new ProviderReleaseIngestionService(db);
    const ingestOnce = () => service.ingest({
      canonicalReleaseId: 1,
      matcherVersion: 1,
      release: {
        provider: "tidal",
        entityType: "release",
        providerId: "release-planned",
        title: "Release A",
        availability: "available",
      },
      members: [{
        ...trackMember({
          providerId: "p-a",
          title: "Alpha",
          mediumPosition: 1,
          position: 1,
          durationMs: 200000,
        }),
        audioVariants: [{
          variantKey: "lossless",
          qualityClass: "lossless",
          availability: "available",
        }],
      }],
    });

    const first = ingestOnce();
    assert.equal(first.acceptedTrackCount, 1);

    // Plan the release, so its track match is referenced.
    const trackMatchId = (db.prepare(
      "SELECT id FROM ProviderTrackMatches WHERE match_state = 'accepted'",
    ).get() as { id: number }).id;
    db.prepare(`
      INSERT INTO AcquisitionPlans (
        id, library_id, edition_id, provider, composition, download_mode, state,
        plan_key, rank, coverage, target_track_count, quality_tier,
        explicit_content, planner_version, policy_hash, computed_at
      ) VALUES (1, 1, 1, 'tidal', 'single_source', 'album', 'current',
                'tidal|lossless|clean|single_source|1', 0, 1, 1, 'lossless', 'clean', 1, 'hash',
                CURRENT_TIMESTAMP)
    `).run();
    const editionMatchId = (db.prepare(
      "SELECT id FROM ProviderEditionMatches",
    ).get() as { id: number }).id;
    db.prepare(`
      INSERT INTO AcquisitionPlanSources (id, plan_id, provider_edition_match_id, role, sort_order)
      VALUES (1, 1, ?, 'primary', 0)
    `).run(editionMatchId);
    const variantId = (db.prepare(
      "SELECT id FROM ProviderItemAudioVariants LIMIT 1",
    ).get() as { id: number }).id;
    db.prepare(`
      INSERT INTO AcquisitionPlanTracks (
        plan_id, track_id, source_id, provider_track_match_id, provider_audio_variant_id
      ) VALUES (1, 1, 1, ?, ?)
    `).run(trackMatchId, variantId);

    // The whole point: this must not throw.
    const second = ingestOnce();
    assert.equal(second.acceptedTrackCount, 1, "re-matching a planned release must succeed");

    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM AcquisitionPlans").get() as { count: number }).count,
      0,
      "plans built on replaced matches are dropped for the planner to rebuild",
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM AcquisitionPlanTracks").get() as { count: number }).count,
      0,
      "plan tracks cascade with their plan",
    );
  });
});

// Structure resolves most repeated titles, but when two provider tracks are
// genuinely indistinguishable — same title, same runtime, and neither slot
// matches the canonical track — the match must stay ambiguous rather than pick
// one arbitrarily.
test("genuinely indistinguishable candidates stay ambiguous", () => {
  withDb((db) => {
    db.exec(`
      INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-a', 'Artist A');
      INSERT INTO Albums (id, mbid, artist_metadata_id, title) VALUES (1, 'group-a', 1, 'Group A');
      INSERT INTO AlbumEditions (id, mbid, release_group_id, title) VALUES (1, 'release-a', 1, 'Release A');
      INSERT INTO Recordings (id, mbid, title, length_ms) VALUES (1, 'rec-interlude', 'Interlude', 60000);
      -- The canonical track sits at disc 1 position 5; neither provider track does.
      INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title, length_ms) VALUES
        (1, 't-interlude', 1, 1, 1, 5, 'Interlude', 60000);
    `);

    const result = new ProviderReleaseIngestionService(db).ingest({
      canonicalReleaseId: 1,
      matcherVersion: 1,
      release: {
        provider: "tidal",
        entityType: "release",
        providerId: "release-two-interludes",
        title: "Release A",
        availability: "available",
      },
      members: [
        trackMember({ providerId: "p-interlude-1", title: "Interlude", mediumPosition: 1, position: 2, durationMs: 60000 }),
        trackMember({ providerId: "p-interlude-2", title: "Interlude", mediumPosition: 1, position: 9, durationMs: 60000 }),
      ],
    });

    assert.equal(result.acceptedTrackCount, 0, "neither candidate may be picked arbitrarily");
    assert.equal(result.ambiguousTrackCount, 2);
    // With no accepted overlap there is nothing to anchor a release match on, so
    // ingestion persists neither the relation nor the ambiguous rows rather than
    // inventing a link.
    assert.equal(result.releaseMatchId, null);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM ProviderEditionMatches").get() as { count: number }).count,
      0,
    );
  });
});

// Maximum cardinality must dominate confidence: taking the highest-scoring edge
// for one target can strand another target that had only that one candidate.
test("assignment maximises coverage before confidence", () => {
  withDb((db) => {
    db.exec(`
      INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-a', 'Artist A');
      INSERT INTO Albums (id, mbid, artist_metadata_id, title) VALUES (1, 'group-a', 1, 'Group A');
      INSERT INTO AlbumEditions (id, mbid, release_group_id, title) VALUES (1, 'release-a', 1, 'Release A');
      INSERT INTO Recordings (id, mbid, title, length_ms, isrcs) VALUES
        (1, 'rec-one', 'Landslide',        200000, '["GBAAA0000001"]'),
        (2, 'rec-two', 'Landslide (edit)', 200000, NULL);
      INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title, length_ms) VALUES
        (1, 't-one', 1, 1, 1, 1, 'Landslide',        200000),
        (2, 't-two', 1, 2, 1, 2, 'Landslide (edit)', 200000);
    `);

    const result = new ProviderReleaseIngestionService(db).ingest({
      canonicalReleaseId: 1,
      matcherVersion: 1,
      release: {
        provider: "tidal",
        entityType: "release",
        providerId: "release-landslide",
        title: "Release A",
        availability: "available",
      },
      members: [
        // Carries the ISRC of canonical track 1, so it is a perfect 1.0 for it —
        // but it also scores well against track 2. Track 2's only other
        // candidate is the second member, so the solver must not let the ISRC
        // track take slot 2.
        trackMember({ providerId: "p-one", title: "Landslide", mediumPosition: 1, position: 1, durationMs: 200000, isrc: "GBAAA0000001" }),
        trackMember({ providerId: "p-two", title: "Landslide", mediumPosition: 1, position: 2, durationMs: 200000 }),
      ],
    });

    assert.equal(result.acceptedTrackCount, 2, "both canonical tracks must be covered");
    assert.deepEqual(
      db.prepare(`
        SELECT ptm.track_id, pi.provider_id, ptm.method
        FROM ProviderTrackMatches ptm
        JOIN ProviderEditionMembers mem ON mem.id = ptm.provider_edition_member_id
        JOIN ProviderItems pi ON pi.id = mem.member_item_id
        WHERE ptm.match_state = 'accepted'
        ORDER BY ptm.track_id
      `).all(),
      [
        { track_id: 1, provider_id: "p-one", method: "external_id" },
        { track_id: 2, provider_id: "p-two", method: "medium_position_duration" },
      ],
    );
  });
});

// Callers collect edges in whatever order the provider returned members; the
// assignment must not depend on it.
test("assignment is deterministic when member order changes", () => {
  const ingestOrder = (reversed: boolean) => {
    let assignments: Array<{ track_id: number; provider_id: string }> = [];
    withDb((db) => {
      db.exec(`
        INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-a', 'Artist A');
        INSERT INTO Albums (id, mbid, artist_metadata_id, title) VALUES (1, 'group-a', 1, 'Group A');
        INSERT INTO AlbumEditions (id, mbid, release_group_id, title) VALUES (1, 'release-a', 1, 'Release A');
        INSERT INTO Recordings (id, mbid, title, length_ms) VALUES
          (1, 'rec-a', 'Alpha', 200000),
          (2, 'rec-b', 'Beta',  210000),
          (3, 'rec-c', 'Gamma', 220000);
        INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title, length_ms) VALUES
          (1, 't-a', 1, 1, 1, 1, 'Alpha', 200000),
          (2, 't-b', 1, 2, 1, 2, 'Beta',  210000),
          (3, 't-c', 1, 3, 1, 3, 'Gamma', 220000);
      `);
      const members = [
        trackMember({ providerId: "p-a", title: "Alpha", mediumPosition: 1, position: 1, durationMs: 200000 }),
        trackMember({ providerId: "p-b", title: "Beta", mediumPosition: 1, position: 2, durationMs: 210000 }),
        trackMember({ providerId: "p-c", title: "Gamma", mediumPosition: 1, position: 3, durationMs: 220000 }),
      ];
      new ProviderReleaseIngestionService(db).ingest({
        canonicalReleaseId: 1,
        matcherVersion: 1,
        release: {
          provider: "tidal",
          entityType: "release",
          providerId: "release-abc",
          title: "Release A",
          availability: "available",
        },
        members: reversed ? [...members].reverse() : members,
      });
      assignments = db.prepare(`
        SELECT ptm.track_id, pi.provider_id
        FROM ProviderTrackMatches ptm
        JOIN ProviderEditionMembers mem ON mem.id = ptm.provider_edition_member_id
        JOIN ProviderItems pi ON pi.id = mem.member_item_id
        WHERE ptm.match_state = 'accepted'
        ORDER BY ptm.track_id
      `).all() as Array<{ track_id: number; provider_id: string }>;
    });
    return assignments;
  };

  assert.deepEqual(ingestOrder(false), ingestOrder(true));
  assert.deepEqual(ingestOrder(false), [
    { track_id: 1, provider_id: "p-a" },
    { track_id: 2, provider_id: "p-b" },
    { track_id: 3, provider_id: "p-c" },
  ]);
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
    assert.equal(first.acceptedTrackCount, 2);
    assert.equal(first.ambiguousTrackCount, 0);
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
          match_state: "accepted",
          track_id: 2,
          recording_id: 2,
          method: "medium_position_duration",
        },
      ],
      "The disc-1 provider track belongs to the disc-1 canonical track; the disc-2"
      + " instrumental of the same name and runtime is a weaker title-only rival"
      + " and must not cast doubt on a proven slot",
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
