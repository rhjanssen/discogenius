/**
 * Every surface that shows a plan's quality must say the same thing.
 *
 * The Album page read the best selected variant; Album cards on the Artist and
 * Library pages read `ORDER BY plan_track.id LIMIT 1` — the *first* track's
 * variant. A plan of one Max track and nine High therefore read as Max on one
 * page and High on another, for the same plan, depending only on which track
 * happened to be first.
 *
 * The approved rule is that the headline is a maximum, so these tests pin the
 * maximum *and* the distribution behind it: "1 Max + 9 High" and "10 Max" share
 * a headline, and only the histogram tells them apart.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
  resetActiveSchemaRows,
} from "../../test-support/active-schema-fixture.js";
import {
  planHeadlineQualitySql,
  variantDisplayQualitySql,
  planQualityHistogramSql,
} from "../../utils/display-quality-sql.js";

const { tempDir } = prepareActiveSchemaEnv("plan-quality-summary");
const { db, dbModule } = await openActiveSchemaDb();
after(() => closeActiveSchemaDb(dbModule, tempDir));

/** `quality_class` values exactly as the ingestion layer writes them. */
type Tier = "hires-lossless" | "lossless" | "lossy" | "spatial";

/**
 * One plan whose tracks each selected a given variant tier, built through the
 * real tables so the SQL under test runs against production shapes.
 */
function seedPlan(planId: number, tiers: Tier[], spatialFormat: string | null = null): void {
  db.exec(`
    INSERT OR IGNORE INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-q', 'Quality Artist');
    INSERT OR IGNORE INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title)
      VALUES (1, 'rg-quality', 1, 'artist-q', 'Quality Album');
    INSERT OR IGNORE INTO AlbumEditions (id, mbid, release_group_id, release_group_mbid, artist_mbid, title)
      VALUES (1, 'edition-quality', 1, 'rg-quality', 'artist-q', 'Quality Album');
    INSERT OR IGNORE INTO MetadataProfiles (id, name, release_type_policy, explicit_policy, require_provider_availability, redundancy_enabled)
      VALUES (1, 'Default', '{}', 'allow', 1, 0);
    INSERT OR IGNORE INTO Libraries (id, name, root_path, metadata_profile_id, quality_profile_id, enabled)
      VALUES (1, 'Stereo', '/music', 1, 1, 1);
    INSERT OR IGNORE INTO ProviderItems (id, provider, entity_type, provider_id, title)
      VALUES (${900 + planId}, 'tidal', 'release', 'tidal-album-${planId}', 'Quality Album');
    INSERT OR IGNORE INTO AlbumEditions (id, mbid, release_group_id, release_group_mbid, artist_mbid, title)
      VALUES (${100 + planId}, 'edition-${planId}', 1, 'rg-quality', 'artist-q', 'Quality Album');
    INSERT OR IGNORE INTO ProviderEditionMatches (
      id, provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version
    ) VALUES (${900 + planId}, ${900 + planId}, ${100 + planId}, 'exact', 'accepted', 'automatic', 1.0, 'test', 1);
    INSERT INTO AcquisitionPlans (
      id, library_id, edition_id, provider, composition, download_mode, state,
      plan_key, rank, coverage, target_track_count, quality_tier, explicit_content,
      explicit_track_count, clean_track_count, unknown_explicitness_count,
      planner_version, policy_hash, computed_at
    ) VALUES (
      ${planId}, 1, ${100 + planId}, 'tidal', 'single_source', 'album', 'current',
      'plan-${planId}', 0, ${tiers.length}, ${tiers.length}, 'lossless', 'unknown',
      0, 0, ${tiers.length}, 2, 'hash', CURRENT_TIMESTAMP
    );
    INSERT INTO AcquisitionPlanSources (id, plan_id, provider_edition_match_id, role, sort_order)
      VALUES (${planId}, ${planId}, ${900 + planId}, 'primary', 0);
  `);

  tiers.forEach((tier, index) => {
    const trackId = planId * 1000 + index;
    db.exec(`
      INSERT OR IGNORE INTO Recordings (id, mbid, artist_mbid, title, length_ms)
        VALUES (${trackId}, 'rec-${trackId}', 'artist-q', 'Track ${index}', 200000);
      INSERT OR IGNORE INTO Tracks (id, mbid, album_edition_id, release_mbid, recording_id, recording_mbid, medium_position, position, title)
        VALUES (${trackId}, 'trk-${trackId}', ${100 + planId}, 'edition-${planId}', ${trackId}, 'rec-${trackId}', 1, ${index + 1}, 'Track ${index}');
      INSERT OR IGNORE INTO ProviderItems (id, provider, entity_type, provider_id, title)
        VALUES (${trackId}, 'tidal', 'track', 'tidal-${trackId}', 'Track ${index}');
      INSERT INTO ProviderItemAudioVariants (
        id, provider_item_id, variant_key, quality_class, availability, spatial_format
      ) VALUES (
        ${trackId}, ${trackId}, '${tier}', '${tier}', 'available',
        ${spatialFormat && tier === "spatial" ? `'${spatialFormat}'` : "NULL"}
      );
      -- No edition-match context: the SQL under test reads plan tracks and
      -- variants only, and binding a match to an edition needs a member row.
      INSERT OR IGNORE INTO ProviderTrackMatches (
        id, provider_track_item_id, track_id, recording_id,
        match_state, decision_source, confidence, method, matcher_version
      ) VALUES (${trackId}, ${trackId}, ${trackId}, ${trackId}, 'accepted', 'automatic', 1.0, 'test', 1);
      INSERT INTO AcquisitionPlanTracks (plan_id, track_id, source_id, provider_track_match_id, provider_audio_variant_id)
        VALUES (${planId}, ${trackId}, ${planId}, ${trackId}, ${trackId});
    `);
  });
}

function headline(planId: number): string | null {
  return (db.prepare(
    `SELECT ${planHeadlineQualitySql(String(planId))} AS q`,
  ).get() as { q: string | null }).q;
}

function histogram(planId: number): Record<string, number> {
  const raw = (db.prepare(
    `SELECT ${planQualityHistogramSql(String(planId))} AS h`,
  ).get() as { h: string | null }).h;
  return raw ? JSON.parse(raw) as Record<string, number> : {};
}

function reset(): void {
  resetActiveSchemaRows(db, [
    "AcquisitionPlanTracks", "AcquisitionPlanSources", "AcquisitionPlans",
    "ProviderTrackMatches", "ProviderEditionMatches", "ProviderItemAudioVariants",
    "ProviderItems", "Tracks", "Recordings", "AlbumEditions", "Albums",
    "ArtistMetadata", "Libraries", "MetadataProfiles",
  ]);
}

test("the headline is the best selected tier, whatever order the tracks are in", () => {
  reset();
  // Nine lossless then one hi-res: the hi-res track is last, which is exactly
  // the shape that made cards disagree with the Album page.
  seedPlan(1, [...Array(9).fill("lossless"), "hires-lossless"] as Tier[]);
  seedPlan(2, ["hires-lossless", ...Array(9).fill("lossless")] as Tier[]);
  seedPlan(3, Array(10).fill("hires-lossless") as Tier[]);
  seedPlan(4, Array(10).fill("lossless") as Tier[]);

  assert.equal(headline(1), headline(2), "track order must not change the headline");
  assert.equal(headline(1), headline(3), "one Max track makes the plan Max");
  assert.notEqual(headline(1), headline(4));
});

test("the distribution survives, so 1 Max + 9 High is not 10 Max", () => {
  reset();
  seedPlan(1, [...Array(9).fill("lossless"), "hires-lossless"] as Tier[]);
  seedPlan(2, [...Array(4).fill("lossless"), ...Array(6).fill("hires-lossless")] as Tier[]);
  seedPlan(3, Array(10).fill("hires-lossless") as Tier[]);
  seedPlan(4, Array(10).fill("lossless") as Tier[]);

  assert.deepEqual(histogram(1), { "hires-lossless": 1, lossless: 9 });
  assert.deepEqual(histogram(2), { "hires-lossless": 6, lossless: 4 });
  assert.deepEqual(histogram(3), { "hires-lossless": 10 });
  assert.deepEqual(histogram(4), { lossless: 10 });

  // Same headline, different products — the ranking input the solver needs.
  assert.equal(headline(1), headline(3));
  assert.notDeepEqual(histogram(1), histogram(3));
});

test("hi-res is ranked above lossless despite the stored spelling", () => {
  reset();
  // The column stores `hires-lossless`; an ordering that matched `hires_lossless`
  // sorted every hi-res variant last and reported the plan as Lossless.
  seedPlan(1, ["lossless", "hires-lossless"] as Tier[]);
  assert.equal(headline(1)?.toUpperCase().includes("LOSSLESS"), true);
  assert.notEqual(headline(1)?.toUpperCase(), "LOSSLESS");
});

test("a spatial plan headlines as its actual spatial format", () => {
  reset();
  seedPlan(1, Array(10).fill("spatial") as Tier[], "atmos");
  assert.equal(headline(1), "DOLBY_ATMOS");
  assert.deepEqual(histogram(1), { spatial: 10 });

  reset();
  seedPlan(2, Array(10).fill("spatial") as Tier[], "sony_360ra");
  assert.equal(headline(2), "SONY_360RA");
});

test("a stereo plan is unaffected by an unrelated spatial variant on the same provider item", () => {
  reset();
  seedPlan(1, Array(4).fill("lossless") as Tier[]);
  // The provider release also sells an Atmos stream; no planned track selected it.
  db.exec(`
    INSERT INTO ProviderItemAudioVariants (id, provider_item_id, variant_key, quality_class, availability, spatial_format)
    VALUES (99001, 1000, 'spatial', 'spatial', 'available', 'atmos');
  `);
  assert.equal(headline(1)?.includes("ATMOS"), false);
  assert.deepEqual(histogram(1), { lossless: 4 });
});

test("an empty plan has no headline rather than a fabricated one", () => {
  reset();
  db.exec(`
    INSERT OR IGNORE INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-q', 'Quality Artist');
    INSERT OR IGNORE INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title)
      VALUES (1, 'rg-quality', 1, 'artist-q', 'Quality Album');
    INSERT OR IGNORE INTO AlbumEditions (id, mbid, release_group_id, release_group_mbid, artist_mbid, title)
      VALUES (1, 'edition-quality', 1, 'rg-quality', 'artist-q', 'Quality Album');
    INSERT OR IGNORE INTO MetadataProfiles (id, name, release_type_policy, explicit_policy, require_provider_availability, redundancy_enabled)
      VALUES (1, 'Default', '{}', 'allow', 1, 0);
    INSERT OR IGNORE INTO Libraries (id, name, root_path, metadata_profile_id, quality_profile_id, enabled)
      VALUES (1, 'Stereo', '/music', 1, 1, 1);
    INSERT INTO AcquisitionPlans (
      id, library_id, edition_id, provider, composition, download_mode, state,
      plan_key, rank, coverage, target_track_count, quality_tier, explicit_content,
      explicit_track_count, clean_track_count, unknown_explicitness_count,
      planner_version, policy_hash, computed_at
    ) VALUES (7, 1, 1, 'tidal', 'single_source', 'album', 'current', 'plan-empty', 0, 0, 0, 'lossless', 'unknown', 0, 0, 0, 2, 'hash', CURRENT_TIMESTAMP);
  `);
  assert.equal(headline(7), null);
  assert.deepEqual(histogram(7), {});
});

test("a provider trait list collapses to one badge-able token", () => {
  // Providers advertise a release's capabilities as a list, and ingestion once
  // persisted the whole joined list as the variant's label — 30k rows in a real
  // library carry values like this. The badge layer takes one token, and the
  // canonical one is last.
  db.exec(`
    INSERT OR IGNORE INTO ProviderItems (id, provider, entity_type, provider_id, title)
      VALUES (7700, 'apple-music', 'track', 'am-7700', 'Trait List');
    INSERT INTO ProviderItemAudioVariants (
      id, provider_item_id, variant_key, quality_class, provider_quality_label, availability
    ) VALUES (
      7700, 7700, 'stereo:lossless', 'lossless',
      'dolby-atmos,lossless,lossy-stereo,LOSSLESS', 'available'
    );
  `);

  const rendered = (db.prepare(`
    SELECT ${variantDisplayQualitySql("variant")} AS q
    FROM ProviderItemAudioVariants variant WHERE variant.id = 7700
  `).get() as { q: string | null }).q;

  assert.equal(rendered, "LOSSLESS");
});
