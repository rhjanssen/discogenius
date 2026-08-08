import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import {
  assertTableHasColumns,
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
  resetActiveSchemaRows,
} from "../../test-support/active-schema-fixture.js";

// Production-service test → ACTIVE schema, never domain-baseline.
const { tempDir } = prepareActiveSchemaEnv("import-operation-identity");
const { db, dbModule } = await openActiveSchemaDb();
const {
  persistPreparedImportQuality,
  persistDownloadedProviderProvenance,
  reconcileImportedDownload,
  releaseGroupMbidFromJobContext,
} = await import("./downloaded-tracks-import-service.js");

after(() => closeActiveSchemaDb(dbModule, tempDir));

beforeEach(() => {
  resetActiveSchemaRows(db, ["Libraries", "MetadataProfiles", "quality_profiles"]);
});

function seedLibrary(): number {
  db.prepare(`
    INSERT INTO MetadataProfiles (
      id, name, release_type_policy, explicit_policy,
      require_provider_availability, redundancy_enabled
    ) VALUES (1, 'Default', '{}', 'allow', 1, 0)
  `).run();
  db.prepare(`
    INSERT INTO quality_profiles (
      id, name, allowed_source_formats, preference_order, cutoff,
      continue_upgrades, fallback_policy, output_format, transcode_policy
    ) VALUES (1, 'High', '["lossless"]', '["lossless"]', 'lossless', 0, 'none', '{}', 'preserve')
  `).run();
  return Number((db.prepare(`
    INSERT INTO Libraries (name, root_path, metadata_profile_id, quality_profile_id)
    VALUES ('Stereo', 'C:/library/stereo', 1, 1)
    RETURNING id
  `).get() as { id: number }).id);
}

function seedTrackFile(overrides: Record<string, unknown> = {}): number {
  db.prepare("INSERT OR IGNORE INTO Artists (id, name) VALUES ('op-artist', 'Op Artist')").run();
  const row = {
    artist_id: "op-artist",
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "prov-track-1",
    file_path: "C:/library/stereo/a.flac",
    relative_path: "a.flac",
    library_root: "C:/library/stereo",
    filename: "a.flac",
    extension: "flac",
    file_type: "track",
    library_id: null,
    ...overrides,
  };
  return Number((db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, provider, provider_entity_type, provider_id, library_id,
      file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (
      @artist_id, @provider, @provider_entity_type, @provider_id, @library_id,
      @file_path, @relative_path, @library_root, @filename, @extension, @file_type
    )
    RETURNING id
  `).get(row) as { id: number }).id);
}

const QUALITY = { sourceQuality: "lossless", importedQuality: "lossless" };

function organizeResult(
  processedTrackIds: string[],
  importedTrackFileIds: Record<string, number>,
) {
  return {
    type: "album" as const,
    providerId: "prov-album-1",
    processedTrackIds,
    totalTracksInStaging: processedTrackIds.length,
    importedTrackFileIds,
  };
}

// ── The active schema itself ────────────────────────────────────────────────

test("the active TrackFiles schema carries the columns manual import probes into", () => {
  const missing = assertTableHasColumns(db, "TrackFiles", [
    "quality", "imported_quality", "source_quality",
    "bitrate", "sample_rate", "bit_depth", "channels", "codec",
    "video_codec", "width", "height", "duration",
  ]);
  assert.deepEqual(missing, []);
});

// ── Issue 2: exact operation identity for imported quality ─────────────────

test("prepared quality lands on the exact reported row", () => {
  const libraryId = seedLibrary();
  const fileId = seedTrackFile();

  persistPreparedImportQuality(
    libraryId,
    new Map([["prov-track-1", QUALITY]]),
    organizeResult(["prov-track-1"], { "prov-track-1": fileId }),
    "tidal",
  );

  const row = db.prepare(`
    SELECT library_id, file_class, source_quality, imported_quality FROM TrackFiles WHERE id = ?
  `).get(fileId) as Record<string, unknown>;
  assert.equal(row.library_id, libraryId);
  assert.equal(row.file_class, "audio");
  assert.equal(row.source_quality, "lossless");
  assert.equal(row.imported_quality, "lossless");
});

test("a colliding provider_id under another provider is never rewritten", () => {
  const libraryId = seedLibrary();
  const ours = seedTrackFile({ provider: "tidal", provider_id: "collide-1" });
  const theirs = seedTrackFile({
    provider: "apple-music",
    provider_id: "collide-1",
    file_path: "C:/library/stereo/b.m4a",
    relative_path: "b.m4a",
    filename: "b.m4a",
    extension: "m4a",
  });

  persistPreparedImportQuality(
    libraryId,
    new Map([["collide-1", QUALITY]]),
    organizeResult(["collide-1"], { "collide-1": ours }),
    "tidal",
  );

  assert.equal(
    (db.prepare("SELECT imported_quality FROM TrackFiles WHERE id = ?").get(ours) as any).imported_quality,
    "lossless",
  );
  assert.equal(
    (db.prepare("SELECT imported_quality, library_id FROM TrackFiles WHERE id = ?").get(theirs) as any).imported_quality,
    null,
    "the other provider's file with the same id must be untouched",
  );
});

test("an unreported track fails closed instead of being position-matched", () => {
  const libraryId = seedLibrary();
  const fileA = seedTrackFile({ provider_id: "track-a" });
  seedTrackFile({
    provider_id: "track-b",
    file_path: "C:/library/stereo/b.flac",
    relative_path: "b.flac",
    filename: "b.flac",
  });

  // Two organized tracks, one decision each, but only track-a has a reported row.
  // The old positional fallback would have zipped track-b's decision onto
  // whatever row was left over.
  assert.throws(
    () => persistPreparedImportQuality(
      libraryId,
      new Map([["track-a", QUALITY], ["track-b", QUALITY]]),
      organizeResult(["track-a", "track-b"], { "track-a": fileA }),
      "tidal",
    ),
    /No imported TrackFiles row reported for 1 track\(s\)/,
  );
});

test("a decision for a file this operation did not organize is ignored, not fatal", () => {
  // Quality decisions are prepared by scanning the download workspace, which can
  // hold debris from an earlier download that failed part-way. Such a decision
  // has nothing to apply, so dropping it is the whole correction — failing the
  // import instead let one stale file abort an otherwise complete one.
  const libraryId = seedLibrary();
  const fileId = seedTrackFile();
  persistPreparedImportQuality(
    libraryId,
    new Map([["prov-track-1", QUALITY], ["stale-from-another-download", QUALITY]]),
    organizeResult(["prov-track-1"], { "prov-track-1": fileId }),
    "tidal",
  );
  const row = db.prepare(
    "SELECT library_id, source_quality, imported_quality FROM TrackFiles WHERE id = ?",
  ).get(fileId) as { library_id: number; source_quality: string; imported_quality: string };
  assert.equal(row.library_id, libraryId, "the real track still imports");
  assert.equal(row.imported_quality, QUALITY.importedQuality);
});

test("two decisions collapsing onto one row fails closed", () => {
  const libraryId = seedLibrary();
  const fileId = seedTrackFile();
  assert.throws(
    () => persistPreparedImportQuality(
      libraryId,
      new Map([["track-a", QUALITY], ["track-b", QUALITY]]),
      organizeResult(["track-a", "track-b"], { "track-a": fileId, "track-b": fileId }),
      "tidal",
    ),
    /map onto only 1 distinct TrackFiles row/,
  );
});

test("a row already owned by another library fails closed", () => {
  const libraryId = seedLibrary();
  const otherLibrary = Number((db.prepare(`
    INSERT INTO Libraries (name, root_path, metadata_profile_id, quality_profile_id)
    VALUES ('Spatial', 'C:/library/spatial', 1, 1)
    RETURNING id
  `).get() as { id: number }).id);
  const fileId = seedTrackFile({ library_id: otherLibrary });

  assert.throws(
    () => persistPreparedImportQuality(
      libraryId,
      new Map([["prov-track-1", QUALITY]]),
      organizeResult(["prov-track-1"], { "prov-track-1": fileId }),
      "tidal",
    ),
    /already belongs to library/,
  );
});

test("a reported row that is not a track file fails closed", () => {
  const libraryId = seedLibrary();
  const coverId = seedTrackFile({
    file_type: "cover",
    file_path: "C:/library/stereo/cover.jpg",
    relative_path: "cover.jpg",
    filename: "cover.jpg",
    extension: "jpg",
  });
  assert.throws(
    () => persistPreparedImportQuality(
      libraryId,
      new Map([["prov-track-1", QUALITY]]),
      organizeResult(["prov-track-1"], { "prov-track-1": coverId }),
      "tidal",
    ),
    /is a cover file, not a track/,
  );
});

test("downloaded provenance lands on the exact organizer row", () => {
  const libraryId = seedLibrary();
  const fileId = seedTrackFile();
  const providerItem = db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability)
    VALUES ('tidal', 'track', 'prov-track-1', 'Track', 'available')
    RETURNING id
  `).get() as { id: number };
  const variant = db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, availability
    ) VALUES (?, 'lossless', 'lossless', 'available')
    RETURNING id
  `).get(providerItem.id) as { id: number };

  persistDownloadedProviderProvenance(
    libraryId,
    organizeResult(["prov-track-1"], { "prov-track-1": fileId }),
    [{
      provider: "tidal",
      providerTrackId: "prov-track-1",
      providerTrackItemId: providerItem.id,
      providerAudioVariantId: variant.id,
    }],
    77,
  );

  assert.deepEqual(db.prepare(`
    SELECT library_id, provider_item_id, source_audio_variant_id
    FROM TrackFiles WHERE id = ?
  `).get(fileId), {
    library_id: libraryId,
    provider_item_id: providerItem.id,
    source_audio_variant_id: variant.id,
  });
});

test("a provider-id collision cannot redirect downloaded provenance", () => {
  const libraryId = seedLibrary();
  const fileId = seedTrackFile({ provider: "tidal", provider_id: "same-id" });
  const tidalItem = db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability)
    VALUES ('tidal', 'track', 'same-id', 'TIDAL Track', 'available')
    RETURNING id
  `).get() as { id: number };
  const appleItem = db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability)
    VALUES ('apple-music', 'track', 'same-id', 'Apple Track', 'available')
    RETURNING id
  `).get() as { id: number };

  persistDownloadedProviderProvenance(
    libraryId,
    organizeResult(["same-id"], { "same-id": fileId }),
    [
      { provider: "tidal", providerTrackId: "same-id", providerTrackItemId: tidalItem.id },
      { provider: "apple-music", providerTrackId: "same-id", providerTrackItemId: appleItem.id },
    ],
    88,
  );

  assert.equal(
    (db.prepare("SELECT provider_item_id FROM TrackFiles WHERE id = ?").get(fileId) as { provider_item_id: number }).provider_item_id,
    tidalItem.id,
  );
});

test("an acquisition-plan import without exact provider identity fails closed", () => {
  const libraryId = seedLibrary();
  const fileId = seedTrackFile();
  assert.throws(
    () => persistDownloadedProviderProvenance(
      libraryId,
      organizeResult(["prov-track-1"], { "prov-track-1": fileId }),
      [{ provider: "tidal", providerTrackId: "prov-track-1" }],
      99,
    ),
    /has no exact provider_item_id/,
  );
});

// ── Issue 3: canonical group from job context, else agreement ───────────────

function seedCanonicalRelease(groupMbid: string, releaseMbid: string): void {
  db.prepare("INSERT OR IGNORE INTO ArtistMetadata (mbid, name) VALUES ('rc-artist', 'RC Artist')").run();
  db.prepare(`
    INSERT OR IGNORE INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, 'rc-artist', ?, 'album')
  `).run(groupMbid, groupMbid);
  db.prepare(`
    INSERT OR IGNORE INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count)
    VALUES (?, ?, 'rc-artist', ?, 1)
  `).run(releaseMbid, groupMbid, releaseMbid);
}

test("an explicit releaseGroupMbid is used directly", () => {
  assert.equal(
    releaseGroupMbidFromJobContext({ releaseGroupMbid: "rg-explicit" }),
    "rg-explicit",
  );
});

test("an explicit releaseMbid resolves to its group", () => {
  seedCanonicalRelease("rg-from-release", "rel-from-release");
  assert.equal(
    releaseGroupMbidFromJobContext({ releaseMbid: "rel-from-release" }),
    "rg-from-release",
  );
});

test("a releaseMbid not in the catalogue yields null rather than a guess", () => {
  assert.equal(releaseGroupMbidFromJobContext({ releaseMbid: "rel-unknown" }), null);
});

test("no job context and disagreeing accepted matches reconciles by provider, not an arbitrary group", () => {
  seedCanonicalRelease("rg-one", "rel-one");
  seedCanonicalRelease("rg-two", "rel-two");
  const releaseItem = Number((db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability)
    VALUES ('tidal', 'release', 'prov-album-1', 'Ambiguous', 'available')
    RETURNING id
  `).get() as { id: number }).id);
  for (const releaseMbid of ["rel-one", "rel-two"]) {
    const release = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = ?").get(releaseMbid) as { id: number };
    db.prepare(`
      INSERT INTO ProviderEditionMatches (
        provider_edition_item_id, edition_id, relation, match_state, decision_source,
        confidence, method, matcher_version
      ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 0.9, 'test_fixture', 1)
    `).run(releaseItem, release.id);
  }

  // Two accepted groups disagree. The old query took ORDER BY confidence LIMIT 1
  // and reconciled download state onto whichever came first. It must not throw,
  // and must not pick one.
  assert.doesNotThrow(() => reconcileImportedDownload(
    "album",
    "prov-album-1",
    organizeResult(["t1"], { t1: 1 }) as any,
    "tidal",
    {},
  ));
});

test("job context wins over provider matches for the reconciled group", () => {
  seedCanonicalRelease("rg-planned", "rel-planned");
  seedCanonicalRelease("rg-other", "rel-other");
  assert.equal(
    releaseGroupMbidFromJobContext({ releaseGroupMbid: "rg-planned", releaseMbid: "rel-other" }),
    "rg-planned",
    "the plan's own group beats anything re-derived",
  );
});

test("a composite plan's cross-provider track keeps its own provenance", () => {
  // A composite plan draws tracks from several provider releases, so a download
  // queued against an Apple Music album can legitimately carry a TIDAL-sourced
  // track. The organizer stamps such a file with the *command's* provider, and
  // filtering offers by that excluded the one real candidate: a spatial import
  // that had already placed all eight files correctly then failed with
  // "0 exact offer contexts".
  const libraryId = seedLibrary();
  const fileId = seedTrackFile({ provider: "apple-music", provider_id: "453015789" });
  const tidalItem = db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability)
    VALUES ('tidal', 'track', '453015789', 'Good Grief', 'available')
    RETURNING id
  `).get() as { id: number };

  persistDownloadedProviderProvenance(
    libraryId,
    organizeResult(["453015789"], { "453015789": fileId }),
    [{ provider: "tidal", providerTrackId: "453015789", providerTrackItemId: tidalItem.id }],
    99,
  );

  const row = db.prepare(
    "SELECT provider, provider_item_id FROM TrackFiles WHERE id = ?",
  ).get(fileId) as { provider: string; provider_item_id: number };
  assert.equal(row.provider_item_id, tidalItem.id, "the offer is the authority on where the track came from");
  assert.equal(row.provider, "tidal", "and the file's provider is corrected to match it");
});
