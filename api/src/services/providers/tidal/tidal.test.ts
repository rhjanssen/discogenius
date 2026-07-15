import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveQuality,
  extractImportListsFromPage,
  mapTidalOpenApiTrack,
  tidalSquareImageUrl,
} from "./tidal.js";

test("deriveQuality checks mediaMetadata.tags priority", () => {
  assert.equal(deriveQuality({ mediaMetadata: { tags: ["LOSSLESS", "HIRES_LOSSLESS", "DOLBY_ATMOS"] } }), "DOLBY_ATMOS");
  assert.equal(deriveQuality({ mediaMetadata: { tags: ["LOSSLESS", "HIRES_LOSSLESS"] } }), "HIRES_LOSSLESS");
  assert.equal(deriveQuality({ mediaMetadata: { tags: ["LOSSLESS"] } }), "LOSSLESS");
  assert.equal(deriveQuality({ mediaMetadata: { tags: [] } }), "LOSSLESS");
  assert.equal(deriveQuality(null), "LOSSLESS");
  assert.equal(deriveQuality(undefined), "LOSSLESS");
});

test("bulk JSON:API tracks preserve artist identity and normalize copyright", () => {
  const includedArtists = new Map([
    ["4781900", {
      id: "4781900",
      type: "artists",
      attributes: { name: "Bakermat" },
    }],
  ]);
  const row = mapTidalOpenApiTrack(
    { id: "track-21", type: "tracks", meta: { trackNumber: 21, volumeNumber: 1 } },
    {
      id: "track-21",
      type: "tracks",
      attributes: {
        title: "Track 21",
        duration: "PT3M5S",
        copyright: { text: "(P) Example Records" },
        isrc: "DEE861400339",
        mediaTags: ["LOSSLESS"],
      },
      relationships: {
        artists: { data: [{ id: "4781900", type: "artists" }] },
      },
    },
    includedArtists,
  );

  assert.equal(row.artist_id, "4781900");
  assert.equal(row.artist_name, "Bakermat");
  assert.deepEqual(row.artists, [{ id: "4781900", name: "Bakermat", type: null }]);
  assert.equal(row.copyright, "(P) Example Records");
  assert.equal(row.track_number, 21);
  assert.equal(row.duration, 185);
});

test("TIDAL import artwork converts playlist UUIDs and prefers page image URLs", () => {
  assert.equal(
    tidalSquareImageUrl("21824bc6-1cfd-44da-9f78-c400e83cf133"),
    "https://resources.tidal.com/images/21824bc6/1cfd/44da/9f78/c400e83cf133/640x640.jpg",
  );
  const lists = extractImportListsFromPage({
    rows: [{ modules: [{
      title: "My Mixes",
      pagedList: { items: [{
        id: "mix-1",
        title: "My Mix 1",
        shortSubtitle: "Created by TIDAL",
        images: { MEDIUM: { url: "https://images.tidal.com/mix-1" } },
      }] },
    }] }],
  }, "Mix");

  assert.deepEqual(lists, [{
    id: "mix:mix-1",
    title: "My Mix 1",
    subtitle: "Created by TIDAL",
    image: "https://images.tidal.com/mix-1",
  }]);
});
