import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCurationDecisions,
  type CurationAlbumCandidate,
} from "./curation-decision-service.js";

const baseConfig = {
  include_album: true,
  include_single: true,
  include_ep: true,
  include_compilation: true,
  include_soundtrack: true,
  include_live: true,
  include_remix: true,
  include_appears_on: false,
  prefer_explicit: true,
  enable_redundancy_filter: true,
};

const qualityConfig = { audio_quality: "max" };

test("curation decisions select the best exact-release variant inside an edition", async () => {
  const result = await buildCurationDecisions({
    albums: [
      album({
        id: 10,
        title: "Album",
        mbid: "mb-release-1",
        quality: "LOSSLESS",
        explicit: 0,
        tracks: [track("A")],
      }),
      album({
        id: 11,
        title: "Album",
        mbid: "mb-release-1",
        quality: "HIRES_LOSSLESS",
        explicit: 1,
        tracks: [track("A")],
      }),
    ],
    libraryType: "music",
    curationConfig: baseConfig,
    qualityConfig,
  });

  assert.equal(result.editionGroupCount, 1);
  assert.deepEqual(selectedIds(result.finalSelection), ["11"]);
  assert.deepEqual(result.decisionsByAlbumId.get("10"), {
    albumId: "10",
    monitor: false,
    redundant: "11",
    reason: "duplicate_edition",
  });
  assert.equal(result.decisionsByAlbumId.get("11")?.monitor, true);
});

test("curation decisions keep exact standard and deluxe releases separate before subset filtering", async () => {
  const result = await buildCurationDecisions({
    albums: [
      album({
        id: 20,
        title: "Album",
        version: "Standard",
        mb_release_group_id: "mb-rg-1",
        mbid: "mb-release-standard",
        upc: "111",
        num_tracks: 2,
        tracks: [track("A"), track("B")],
      }),
      album({
        id: 21,
        title: "Album",
        version: "Deluxe",
        mb_release_group_id: "mb-rg-1",
        mbid: "mb-release-deluxe",
        upc: "222",
        num_tracks: 3,
        tracks: [track("A"), track("B"), track("C")],
      }),
    ],
    libraryType: "music",
    curationConfig: baseConfig,
    qualityConfig,
  });

  assert.equal(result.editionGroupCount, 2);
  assert.equal(result.afterEditionCount, 2);
  assert.deepEqual(selectedIds(result.finalSelection), ["21"]);
  assert.deepEqual(result.decisionsByAlbumId.get("20"), {
    albumId: "20",
    monitor: false,
    redundant: "21",
    reason: "subset",
  });
});

test("curation decisions skip subset filtering when redundancy is disabled", async () => {
  const result = await buildCurationDecisions({
    albums: [
      album({
        id: 30,
        title: "Album",
        mbid: "mb-release-standard",
        num_tracks: 2,
        tracks: [track("A"), track("B")],
      }),
      album({
        id: 31,
        title: "Album Deluxe",
        mbid: "mb-release-deluxe",
        num_tracks: 3,
        tracks: [track("A"), track("B"), track("C")],
      }),
    ],
    libraryType: "music",
    curationConfig: { ...baseConfig, enable_redundancy_filter: false },
    qualityConfig,
  });

  assert.equal(result.subsetFilteringApplied, false);
  assert.deepEqual(selectedIds(result.finalSelection), ["30", "31"]);
  assert.equal(result.decisionsByAlbumId.get("30")?.monitor, true);
  assert.equal(result.decisionsByAlbumId.get("31")?.monitor, true);
});

test("curation decisions apply category filters before redundancy", async () => {
  const result = await buildCurationDecisions({
    albums: [
      album({
        id: 40,
        title: "Appears On",
        module: "APPEARS_ON",
        tracks: [track("A")],
      }),
      album({
        id: 41,
        title: "Album",
        tracks: [track("B")],
      }),
    ],
    libraryType: "music",
    curationConfig: { ...baseConfig, include_appears_on: false },
    qualityConfig,
  });

  assert.deepEqual(selectedIds(result.finalSelection), ["41"]);
  assert.deepEqual(result.decisionsByAlbumId.get("40"), {
    albumId: "40",
    monitor: false,
    redundant: "filtered",
    reason: "filtered_category",
  });
});

function album(overrides: Partial<CurationAlbumCandidate>): CurationAlbumCandidate {
  return {
    id: 1,
    title: "Album",
    type: "ALBUM",
    quality: "LOSSLESS",
    explicit: 1,
    num_tracks: overrides.tracks?.length ?? 1,
    tracks: [track("A")],
    ...overrides,
  };
}

function track(seed: string) {
  return {
    id: `track-${seed}`,
    title: `Track ${seed}`,
    isrc: `USRC${seed.padStart(8, "0")}`,
  };
}

function selectedIds(albums: CurationAlbumCandidate[]): string[] {
  return albums.map((candidate) => String(candidate.id)).sort();
}
