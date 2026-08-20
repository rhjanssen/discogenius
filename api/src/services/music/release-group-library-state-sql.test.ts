import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTIST_WANTED_RELEASE_GROUPS_SQL,
  CURATED_LIBRARY_RELEASE_GROUPS_SQL,
  pagedReleaseGroupIdsSql,
  planQualityExpression,
  releaseGroupLibraryStateCte,
} from "./release-group-library-state-sql.js";

test("library-state CTE ranks only the caller's wanted groups and defers headline quality", () => {
  const sql = releaseGroupLibraryStateCte(ARTIST_WANTED_RELEASE_GROUPS_SQL);

  assert.match(sql, /wanted_groups AS MATERIALIZED/);
  assert.match(sql, /FROM wanted_groups/);
  assert.match(sql, /ArtistReleaseGroups/);
  assert.match(sql, /selected_plan_id/);
  assert.doesNotMatch(sql, /AcquisitionPlanTracks/);
  assert.doesNotMatch(sql, /FROM LibraryAlbums library_group\s+JOIN Libraries/);
});

test("headline quality is a per-plan expression for the outer page rows", () => {
  const sql = planQualityExpression("stereo.selected_plan_id");
  assert.match(sql, /WHEN stereo\.selected_plan_id IS NULL THEN NULL/);
  assert.match(sql, /AcquisitionPlanTracks/);
  assert.match(sql, /headline_track\.plan_id = stereo\.selected_plan_id/);
});

test("library list wanted groups are monitored LibraryAlbums, not curation overlay", () => {
  assert.match(CURATED_LIBRARY_RELEASE_GROUPS_SQL, /FROM LibraryAlbums/);
  assert.match(CURATED_LIBRARY_RELEASE_GROUPS_SQL, /Libraries library/);
  assert.doesNotMatch(CURATED_LIBRARY_RELEASE_GROUPS_SQL, /ArtistReleaseGroupCuration/);
  assert.equal(pagedReleaseGroupIdsSql("?, ?"), "SELECT id FROM Albums WHERE id IN (?, ?)");
});
