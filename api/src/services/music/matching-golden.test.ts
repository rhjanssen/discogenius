import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  matchProviderAlbumsToReleaseGroups,
  type MusicBrainzReleaseGroupForMatching,
  type ProviderAlbumForReleaseGroupMatching,
} from "../metadata/provider-release-group-matcher.js";

/**
 * Golden-master (characterization) test for the provider→MusicBrainz matcher.
 *
 * The fixtures are REAL data captured from a scan
 * (`api/scripts/capture-match-fixtures.mjs`) — actual MusicBrainz release groups
 * and actual streaming-provider albums for Bakermat and Bastille. This test runs
 * the live matcher over them and pins the result. When the matching engine is
 * refactored (see docs/MATCHING_SET_COVER_DESIGN.md §5–6), any change to the
 * output shows up here as a diff to consciously approve — you don't hand-write an
 * assertion per case.
 *
 * Regenerate goldens after an intentional behavior change:
 *   UPDATE_GOLDEN=1 node --import tsx --test src/services/music/matching-golden.test.ts
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../../../test-fixtures/matching");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

type Fixture = {
  artist: { name: string; mbid: string };
  releaseGroups: MusicBrainzReleaseGroupForMatching[];
  providerAlbums: ProviderAlbumForReleaseGroupMatching[];
};

function loadFixtureSlugs(): string[] {
  if (!fs.existsSync(fixturesDir)) return [];
  return fs.readdirSync(fixturesDir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".golden.json"))
    .map((name) => name.replace(/\.json$/, ""));
}

function runMatcher(fixture: Fixture) {
  const matches = matchProviderAlbumsToReleaseGroups(fixture.providerAlbums, fixture.releaseGroups);
  // Normalize to a stable, review-friendly shape: the selection facts, sorted by
  // provider id. Confidence is rounded so trivial float drift is not a diff.
  return fixture.providerAlbums
    .map((album) => {
      const match = matches.get(album.providerId);
      return {
        providerId: album.providerId,
        providerTitle: album.title,
        status: match?.status ?? "unmatched",
        method: match?.method ?? null,
        confidence: match ? Number(match.confidence.toFixed(3)) : 0,
        releaseGroupMbid: match?.releaseGroup?.mbid ?? null,
        releaseMbid: match?.releaseMbid ?? null,
      };
    })
    .sort((a, b) => a.providerId.localeCompare(b.providerId));
}

for (const slug of loadFixtureSlugs()) {
  test(`matcher golden: ${slug}`, () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, `${slug}.json`), "utf8")) as Fixture;
    const actual = runMatcher(fixture);
    const goldenPath = path.join(fixturesDir, `${slug}.golden.json`);

    if (UPDATE || !fs.existsSync(goldenPath)) {
      fs.writeFileSync(goldenPath, `${JSON.stringify(actual, null, 2)}\n`);
      if (UPDATE) return;
    }

    const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
    assert.deepEqual(actual, golden, `${slug} matcher output differs from golden — review, then UPDATE_GOLDEN=1 to accept.`);
  });
}

// Beyond the snapshot, pin the specific behavior we care about so the golden
// can't be silently regenerated into a wrong state: the barcode-matched original
// must outrank the same-titled remix.
test("matcher golden: Bakermat One Day radio edit outranks the remix", () => {
  const bakermatPath = path.join(fixturesDir, "bakermat.json");
  if (!fs.existsSync(bakermatPath)) return; // fixtures not captured in this checkout
  const fixture = JSON.parse(fs.readFileSync(bakermatPath, "utf8")) as Fixture;
  const rows = runMatcher(fixture);
  const radioEdit = rows.find((r) => r.providerId === "26891889");
  const remix = rows.find((r) => r.providerId === "33923839");
  if (!radioEdit || !remix) return; // this artist's One Day offers not present

  assert.equal(radioEdit.method, "musicbrainz-release-upc", "radio edit should match by UPC");
  assert.ok(
    radioEdit.confidence > remix.confidence,
    `radio edit (${radioEdit.confidence}) should outrank remix (${remix.confidence})`,
  );
});
