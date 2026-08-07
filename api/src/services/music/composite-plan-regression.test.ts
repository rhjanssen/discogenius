/**
 * Permanent regression fixtures for the two composites that justified deleting
 * provider-release fan-out.
 *
 * These run the real `AcquisitionPlanningService` and assert on persisted
 * `AcquisitionPlans` / `AcquisitionPlanTracks` rows, not on hand-written SQL.
 * That distinction is the whole point: the fan-out existed because the planner
 * used to ask "which provider albums are matched to this Edition?", and the
 * claim being protected here is that anchoring on the Edition's own Recordings
 * reaches strictly more, through fewer stored matches.
 *
 * Both fixtures are shaped from real library data:
 *
 *  - *Killing Me Softly* — a three-track Edition filled from two provider
 *    singles that each match a *different* Edition, one of them in another
 *    Release Group, with no edition match pointing at the target at all.
 *  - *Back to Black* — the deluxe Edition whose best plan is a 19/19 composite
 *    of three TIDAL albums at two quality tiers.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createCurrentDomainSchema } from "../../database/schema/domain-baseline.js";
import { AcquisitionPlanningService } from "./acquisition-planning-service.js";
import { ProviderReleaseIngestionService } from "../providers/provider-release-ingestion-service.js";

/** A provider album whose tracks carry ISRCs, ingested through the real matcher. */
interface OfferTrack {
  providerId: string;
  title: string;
  durationMs: number;
  isrc: string;
  /** `lossless` | `hires-lossless` | `spatial` — one variant per track. */
  quality: string;
}

function ingestOffer(
  db: Database.Database,
  canonicalEditionId: number,
  providerAlbumId: string,
  albumTitle: string,
  tracks: readonly OfferTrack[],
): void {
  new ProviderReleaseIngestionService(db).ingest({
    canonicalReleaseId: canonicalEditionId,
    matcherVersion: 1,
    release: {
      provider: "tidal",
      entityType: "release",
      providerId: providerAlbumId,
      title: albumTitle,
      availability: "available",
    },
    members: tracks.map((track, index) => ({
      item: {
        provider: "tidal",
        entityType: "track" as const,
        providerId: track.providerId,
        title: track.title,
        version: null,
        isrc: track.isrc,
        durationMs: track.durationMs,
        availability: "available" as const,
      },
      mediumPosition: 1,
      position: index + 1,
      contextualTitle: null,
      contextualDurationMs: null,
    })),
  });

  // Audio variants are a separate fact from the match; attach one per track.
  for (const track of tracks) {
    const item = db.prepare(
      "SELECT id FROM ProviderItems WHERE provider = 'tidal' AND provider_id = ?",
    ).get(track.providerId) as { id: number } | undefined;
    if (!item) throw new Error(`provider track ${track.providerId} was not ingested`);
    db.prepare(`
      INSERT OR IGNORE INTO ProviderItemAudioVariants (
        provider_item_id, variant_key, quality_class, spatial_format, availability
      ) VALUES (?, ?, ?, ?, 'available')
    `).run(
      item.id,
      track.quality,
      track.quality,
      track.quality === "spatial" ? "atmos" : null,
    );
  }
}

function seedLibrary(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  createCurrentDomainSchema(db);
  db.exec(`
    INSERT INTO MetadataProfiles (id, name, release_type_policy, redundancy_enabled)
      VALUES (1, 'Default', '{}', 0);
    INSERT INTO quality_profiles (
      id, name, allowed_source_formats, preference_order, cutoff,
      continue_upgrades, fallback_policy, output_format, transcode_policy
    ) VALUES (
      1, 'High', '["lossless","hires-lossless"]',
      '["hires-lossless","lossless","lossy","spatial"]',
      'hires-lossless', 1, 'best_allowed', '{"codec":"flac"}', 'preserve'
    );
    INSERT INTO Libraries (id, name, root_path, metadata_profile_id, quality_profile_id)
      VALUES (1, 'Stereo', '/library/stereo', 1, 1);
  `);
}

function withDb(run: (db: Database.Database) => void): void {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-composite-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    seedLibrary(db);
    run(db);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
}

/** The persisted plan the planner ranked first, with its per-track sources. */
function readBestPlan(db: Database.Database, editionId: number) {
  const plan = db.prepare(`
    SELECT id, composition, coverage, quality_tier
    FROM AcquisitionPlans
    WHERE edition_id = ? AND library_id = 1
    ORDER BY rank LIMIT 1
  `).get(editionId) as {
    id: number; composition: string; coverage: number; quality_tier: string;
  } | undefined;
  if (!plan) return null;
  const tracks = db.prepare(`
    SELECT
      target_track.position,
      album.provider_id AS source_album,
      variant.quality_class
    FROM AcquisitionPlanTracks plan_track
    JOIN Tracks target_track ON target_track.id = plan_track.track_id
    JOIN ProviderItemAudioVariants variant ON variant.id = plan_track.provider_audio_variant_id
    JOIN ProviderItems track_item ON track_item.id = variant.provider_item_id
    JOIN ProviderEditionMembers member ON member.member_item_id = track_item.id
    JOIN ProviderItems album ON album.id = member.provider_edition_item_id
    WHERE plan_track.plan_id = ?
    ORDER BY target_track.position
  `).all(plan.id) as Array<{ position: number; source_album: string; quality_class: string }>;
  return { ...plan, tracks };
}

const plan = (db: Database.Database, editionId: number) =>
  new AcquisitionPlanningService(db).compute({
    libraryId: 1,
    editionId,
    providerPriority: ["tidal"],
    plannerVersion: 1,
  });

/* ── Killing Me Softly: two singles, two Editions, two Release Groups ─ */

test("a three-track Edition is filled from two provider singles that match neither it nor each other", () => {
  withDb((db) => {
    db.exec(`
      INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-bastille', 'Bastille');
      INSERT INTO Albums (id, mbid, artist_metadata_id, title, primary_type) VALUES
        (1, 'group-kms', 1, 'Killing Me Softly With His Song (MTV Unplugged)', 'Single'),
        (2, 'group-pompeii', 1, 'Pompeii / Come as You Are (MTV Unplugged)', 'Single');
      INSERT INTO AlbumEditions (id, mbid, release_group_id, title, status, media_count) VALUES
        (1, 'kms-1track', 1, 'KMS 1-track', 'Official', 1),
        (2, 'kms-3track', 1, 'KMS 3-track', 'Official', 1),
        (3, 'pompeii-2track', 2, 'Pompeii 2-track', 'Official', 1);
      INSERT INTO Recordings (id, mbid, title, length_ms, isrcs) VALUES
        (1, 'rec-kms', 'Killing Me Softly With His Song (edit)', 298000, '["GBUM72302334"]'),
        (2, 'rec-pompeii', 'Pompeii (edit)', 268000, '["GBUM72302279"]'),
        (3, 'rec-cay', 'Come as You Are (edit)', 231000, '["GBUM72302277"]');
      INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title, length_ms) VALUES
        (1, 't-kms-1',  1, 1, 1, 1, 'Killing Me Softly With His Song (edit)', 298000),
        (2, 't-kms-3a', 2, 1, 1, 1, 'Killing Me Softly With His Song (edit)', 298000),
        (3, 't-kms-3b', 2, 2, 1, 2, 'Pompeii (edit)', 268000),
        (4, 't-kms-3c', 2, 3, 1, 3, 'Come as You Are (edit)', 231000),
        (5, 't-pom-a',  3, 2, 1, 1, 'Pompeii (edit)', 268000),
        (6, 't-pom-b',  3, 3, 1, 2, 'Come as You Are (edit)', 231000);
    `);

    ingestOffer(db, 1, "290132977", "Killing Me Softly (MTV Unplugged / Edit)", [
      { providerId: "p-kms", title: "Killing Me Softly With His Song (edit)", durationMs: 298000, isrc: "GBUM72302334", quality: "hires-lossless" },
    ]);
    ingestOffer(db, 3, "287367980", "Pompeii / Come As You Are (MTV Unplugged)", [
      { providerId: "p-pompeii", title: "Pompeii (edit)", durationMs: 268000, isrc: "GBUM72302279", quality: "lossless" },
      { providerId: "p-cay", title: "Come as You Are (edit)", durationMs: 231000, isrc: "GBUM72302277", quality: "lossless" },
    ]);

    // Neither provider album is matched to the three-track Edition.
    assert.deepEqual(
      (db.prepare(`
        SELECT album.provider_id, edition_match.edition_id
        FROM ProviderEditionMatches edition_match
        JOIN ProviderItems album ON album.id = edition_match.provider_edition_item_id
        WHERE edition_match.match_state = 'accepted'
        ORDER BY album.provider_id
      `).all() as Array<{ provider_id: string; edition_id: number }>),
      [
        { provider_id: "287367980", edition_id: 3 },
        { provider_id: "290132977", edition_id: 1 },
      ],
    );

    // `compute` returns the *selected* plan id, which is null until curation
    // monitors the Edition. Plans are persisted regardless — that is the seam
    // curation reads to decide what is worth monitoring.
    plan(db, 2);
    const best = readBestPlan(db, 2);
    assert.ok(best, "a plan was persisted");
    assert.equal(best.coverage, 3, "3/3 coverage");
    assert.equal(best.composition, "composite");
    assert.deepEqual(
      best.tracks.map((row) => [row.position, row.source_album]),
      [[1, "290132977"], [2, "287367980"], [3, "287367980"]],
      "one track from the KMS single, two from the Pompeii single in another Release Group",
    );
  });
});

/* ── Back to Black: 19/19 across three albums and two tiers ─────────── */

test("the Back to Black deluxe composite covers 19/19 across three provider albums", () => {
  withDb((db) => {
    // 13 tracks the hi-res standard issue carries, then 6 deluxe-only ones
    // split across two further albums — the measured shape of the real case.
    const hiRes = Array.from({ length: 13 }, (_, i) => i + 1);
    const supplementA = [14, 15, 16];
    const supplementB = [17, 18, 19];

    db.exec(`
      INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-amy', 'Amy Winehouse');
      INSERT INTO Albums (id, mbid, artist_metadata_id, title, primary_type)
        VALUES (1, 'group-btb', 1, 'Back to Black', 'Album');
      INSERT INTO AlbumEditions (id, mbid, release_group_id, title, status, media_count) VALUES
        (1, 'btb-deluxe', 1, 'Back to Black (Deluxe)', 'Official', 1),
        (2, 'btb-standard', 1, 'Back to Black', 'Official', 1),
        (3, 'btb-supp-a', 1, 'Back to Black (B-sides)', 'Official', 1),
        (4, 'btb-supp-b', 1, 'Back to Black (Live)', 'Official', 1);
      ${Array.from({ length: 19 }, (_, i) => {
        const n = i + 1;
        return `INSERT INTO Recordings (id, mbid, title, length_ms, isrcs)
                VALUES (${n}, 'rec-${n}', 'Track ${n}', ${180000 + n * 1000}, '["GBAAA070000${String(n).padStart(2, "0")}"]');`;
      }).join("\n")}
      ${Array.from({ length: 19 }, (_, i) => {
        const n = i + 1;
        return `INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title, length_ms)
                VALUES (${n}, 't-deluxe-${n}', 1, ${n}, 1, ${n}, 'Track ${n}', ${180000 + n * 1000});`;
      }).join("\n")}
      ${hiRes.map((n) => `INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title, length_ms)
                VALUES (${100 + n}, 't-std-${n}', 2, ${n}, 1, ${n}, 'Track ${n}', ${180000 + n * 1000});`).join("\n")}
      ${supplementA.map((n, i) => `INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title, length_ms)
                VALUES (${200 + n}, 't-sa-${n}', 3, ${n}, 1, ${i + 1}, 'Track ${n}', ${180000 + n * 1000});`).join("\n")}
      ${supplementB.map((n, i) => `INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title, length_ms)
                VALUES (${300 + n}, 't-sb-${n}', 4, ${n}, 1, ${i + 1}, 'Track ${n}', ${180000 + n * 1000});`).join("\n")}
    `);

    const offer = (n: number, quality: string): OfferTrack => ({
      providerId: `p-${quality}-${n}`,
      title: `Track ${n}`,
      durationMs: 180000 + n * 1000,
      isrc: `GBAAA070000${String(n).padStart(2, "0")}`,
      quality,
    });
    ingestOffer(db, 2, "77661290", "Back to Black", hiRes.map((n) => offer(n, "hires-lossless")));
    ingestOffer(db, 3, "22888255", "Back to Black (B-sides)", supplementA.map((n) => offer(n, "lossless")));
    ingestOffer(db, 4, "77555663", "Back to Black (Live)", supplementB.map((n) => offer(n, "lossless")));

    // No provider album is matched to the deluxe Edition itself.
    assert.equal(
      (db.prepare(`
        SELECT COUNT(*) AS c FROM ProviderEditionMatches
        WHERE edition_id = 1 AND match_state = 'accepted'
      `).get() as { c: number }).c,
      0,
    );

    plan(db, 1);
    const best = readBestPlan(db, 1);
    assert.ok(best, "a plan was persisted");
    assert.equal(best.coverage, 19, "19/19 coverage");
    assert.equal(best.composition, "composite");

    // Quality distribution: the hi-res standard issue supplies its 13, the two
    // supplements the remaining 6 at lossless. The headline is the best tier.
    const byQuality = best.tracks.reduce<Record<string, number>>((acc, row) => {
      acc[row.quality_class] = (acc[row.quality_class] ?? 0) + 1;
      return acc;
    }, {});
    assert.deepEqual(byQuality, { "hires-lossless": 13, lossless: 6 });
    assert.equal(best.quality_tier, "hires-lossless", "headline is the best selected tier");

    // Source provenance: three distinct albums, each supplying its own span.
    const bySource = best.tracks.reduce<Record<string, number>>((acc, row) => {
      acc[row.source_album] = (acc[row.source_album] ?? 0) + 1;
      return acc;
    }, {});
    assert.deepEqual(bySource, { "77661290": 13, "22888255": 3, "77555663": 3 });
  });
});
