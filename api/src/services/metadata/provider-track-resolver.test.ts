import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { seedSelectedAcquisitionPlan } from "../../test-support/acquisition-plan-fixture.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-provider-track-resolver-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let resolverModule: typeof import("./provider-track-resolver.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  resolverModule = await import("./provider-track-resolver.js");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("canonical provider track resolution follows the current normalized plan", async () => {
  const { db } = dbModule;
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES ('artist-1', 'Test Artist')
    RETURNING id
  `).get() as { id: number };
  const releaseGroup = db.prepare(`
    INSERT INTO Albums (mbid, artist_metadata_id, artist_mbid, title)
    VALUES ('group-1', ?, 'artist-1', 'Test Album')
    RETURNING id
  `).get(artist.id) as { id: number };
  const release = db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_id, release_group_mbid, artist_metadata_id,
      artist_mbid, title
    ) VALUES ('release-1', ?, 'group-1', ?, 'artist-1', 'Test Album')
    RETURNING id
  `).get(releaseGroup.id, artist.id) as { id: number };
  const recording = db.prepare(`
    INSERT INTO Recordings (
      mbid, artist_metadata_id, artist_mbid, title, is_video
    ) VALUES ('recording-1', ?, 'artist-1', 'Target Track', 0)
    RETURNING id
  `).get(artist.id) as { id: number };
  const track = db.prepare(`
    INSERT INTO Tracks (
      mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
      title, medium_position, position
    ) VALUES ('track-1', ?, 'release-1', ?, 'recording-1', 'Target Track', 1, 2)
    RETURNING id
  `).get(release.id, recording.id) as { id: number };
  const providerRelease = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('test-provider', 'release', 'provider-release-1', 'Test Album')
    RETURNING id
  `).get() as { id: number };
  const providerTrack = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('test-provider', 'track', 'provider-track-1', 'Target Track')
    RETURNING id
  `).get() as { id: number };
  const member = db.prepare(`
    INSERT INTO ProviderEditionMembers (
      provider_edition_item_id, member_item_id, medium_position, position
    ) VALUES (?, ?, 1, 2)
    RETURNING id
  `).get(providerRelease.id, providerTrack.id) as { id: number };
  const releaseMatch = db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 0.99, 'test', 1)
    RETURNING id
  `).get(providerRelease.id, release.id) as { id: number };
  const trackMatch = db.prepare(`
    INSERT INTO ProviderTrackMatches (
      provider_track_item_id, provider_edition_member_id, provider_edition_match_id, track_id,
      recording_id, match_state, decision_source, confidence, method,
      matcher_version
    ) VALUES (?, ?, ?, ?, ?, 'accepted', 'automatic', 0.98, 'test', 1)
    RETURNING id
  `).get(providerTrack.id, member.id, releaseMatch.id, track.id, recording.id) as { id: number };
  const stereoVariant = db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label,
      availability
    ) VALUES (?, 'lossless', 'lossless', 'LOSSLESS', 'available')
    RETURNING id
  `).get(providerTrack.id) as { id: number };
  const spatialVariant = db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label,
      availability
    ) VALUES (?, 'atmos', 'spatial', 'DOLBY_ATMOS', 'available')
    RETURNING id
  `).get(providerTrack.id) as { id: number };

  const libraries = db.prepare(`
    SELECT id, name FROM Libraries WHERE name IN ('Stereo', 'Spatial')
  `).all() as Array<{ id: number; name: string }>;
  for (const library of libraries) {
    db.prepare(`
      INSERT INTO LibraryAlbums (
        library_id, release_group_id, monitored, selection_mode, locked,
        reason, curation_version
      ) VALUES (?, ?, 1, 'auto', 0, 'test', 1)
    `).run(library.id, releaseGroup.id);
    const libraryRelease = db.prepare(`
      INSERT INTO LibraryEditions (
        library_id, edition_id, selection_mode, reason, curation_version
      ) VALUES (?, ?, 'auto', 'test', 1)
      RETURNING id
    `).get(library.id, release.id) as { id: number };
    const plan = seedSelectedAcquisitionPlan(db, { libraryEditionId: libraryRelease.id, provider: 'test-provider' }) as { id: number };
    const source = db.prepare(`
      INSERT INTO AcquisitionPlanSources (
        plan_id, provider_edition_match_id, role, sort_order
      ) VALUES (?, ?, 'primary', 0)
      RETURNING id
    `).get(plan.id, releaseMatch.id) as { id: number };
    db.prepare(`
      INSERT INTO AcquisitionPlanTracks (
        plan_id, track_id, source_id, provider_track_match_id,
        provider_audio_variant_id
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      plan.id,
      track.id,
      source.id,
      trackMatch.id,
      library.name === "Spatial" ? spatialVariant.id : stereoVariant.id,
    );
  }

  const stereo = await resolverModule.resolveProviderTrackForCanonicalTrack({
    releaseGroupMbid: "group-1",
    canonicalTrackMbid: "track-1",
    provider: "test-provider",
    slot: "stereo",
  });
  assert.deepEqual(stereo, {
    provider: "test-provider",
    providerTrackId: "provider-track-1",
    providerAlbumId: "provider-release-1",
    slot: "stereo",
    quality: "LOSSLESS",
    score: 98,
  });

  const spatial = await resolverModule.resolveProviderTrackForCanonicalTrack({
    releaseGroupMbid: "group-1",
    canonicalRecordingMbid: "recording-1",
    slot: "spatial",
  });
  assert.equal(spatial?.providerTrackId, "provider-track-1");
  assert.equal(spatial?.slot, "spatial");
  assert.equal(spatial?.quality, "DOLBY_ATMOS");
});
