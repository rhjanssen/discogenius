import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveQuality,
  extractImportListsFromPage,
  getTidalPageImage,
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

test("TIDAL import artwork resolves mixImages arrays and cover UUIDs", () => {
  assert.equal(
    getTidalPageImage({
      mixImages: [{ url: "https://images.tidal.com/mix-mosaic" }],
    }),
    "https://images.tidal.com/mix-mosaic",
  );
  assert.equal(
    getTidalPageImage({ cover: "21824bc6-1cfd-44da-9f78-c400e83cf133" }),
    "https://resources.tidal.com/images/21824bc6/1cfd/44da/9f78/c400e83cf133/640x640.jpg",
  );
  const lists = extractImportListsFromPage({
    rows: [{ modules: [{
      title: "Featured",
      pagedList: { items: [{
        mixType: "DAILY_MIX",
        id: "daily-1",
        title: "Daily Mix 1",
        mixImages: [{ url: "https://images.tidal.com/daily-1" }],
      }] },
    }] }],
  }, "Mix");
  assert.deepEqual(lists[0], {
    id: "mix:daily-1",
    title: "Daily Mix 1",
    subtitle: "Featured",
    image: "https://images.tidal.com/daily-1",
  });
});

test("TIDAL import artwork prefers playlist squareImage over landscape image", () => {
  // Editorial hits playlists expose both: `image` is landscape-only (403 at NxN),
  // `squareImage` is the usable square cover.
  assert.equal(
    getTidalPageImage({
      uuid: "edf3b7d2-cb42-41d7-93c0-afa2a395521b",
      title: "TIDAL's Top Hits",
      type: "EDITORIAL",
      image: "59da45e4-eeaf-4658-ab75-6375f833e4d0",
      squareImage: "be3cff6c-f014-4ada-a7af-e1cff4086cc4",
    }),
    "https://resources.tidal.com/images/be3cff6c/f014/4ada/a7af/e1cff4086cc4/640x640.jpg",
  );
  const lists = extractImportListsFromPage({
    rows: [{ modules: [{
      title: "The Hits",
      pagedList: { items: [{
        uuid: "36ea71a8-445e-41a4-82ab-6628c581535d",
        title: "Pop Hits",
        type: "EDITORIAL",
        image: "a8c4fa5f-14d0-44b0-8535-68680a7540ed",
        squareImage: "f0209f5c-833b-4ff3-aebb-22850b8db506",
      }] },
    }] }],
  }, "Mix");
  assert.deepEqual(lists[0], {
    id: "playlist:36ea71a8-445e-41a4-82ab-6628c581535d",
    title: "Pop Hits",
    subtitle: "The Hits",
    image: "https://resources.tidal.com/images/f0209f5c/833b/4ff3/aebb/22850b8db506/640x640.jpg",
  });
});
