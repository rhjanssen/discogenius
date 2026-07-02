import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { LidarrArtist } from "./servarr-metadata.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-provider-artist-identity-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let serviceModule: typeof import("./provider-artist-identity-service.js");
let dbModule: typeof import("../../database.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  serviceModule = await import("./provider-artist-identity-service.js");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function artist(overrides: Partial<LidarrArtist>): LidarrArtist {
  return {
    id: overrides.id || "artist-mbid",
    artistname: overrides.artistname || "Artist",
    sortname: overrides.sortname || overrides.artistname || "Artist",
    artistaliases: overrides.artistaliases || [],
    links: overrides.links || [],
    images: [],
    Albums: overrides.Albums || [],
    ...(overrides.disambiguation !== undefined ? { disambiguation: overrides.disambiguation } : {}),
    ...(overrides.type !== undefined ? { type: overrides.type } : {}),
  };
}

function albums(count: number): LidarrArtist["Albums"] {
  return Array.from({ length: count }, (_, index) => ({
    Id: `album-${index}`,
    Title: `Album ${index}`,
  }));
}

test("provider artist matching uses MusicBrainz aliases, not only canonical artist names", () => {
  const match = serviceModule.bestCanonicalArtistMatch(
    { providerId: "3712029", name: "Concertgebouworkest" },
    [
      artist({
        id: "d97f1e92-d40f-4190-947c-c0eaf24be565",
        artistname: "Concertgebouworkest Young",
        type: "Orchestra",
        Albums: [],
      }),
      artist({
        id: "ad8260b2-2767-4e9b-9ece-7977fbcedadf",
        artistname: "Koninklijk Concertgebouworkest",
        sortname: "Koninklijk Concertgebouworkest",
        artistaliases: [
          "Royal Concertgebouw Orchestra",
          "Concertgebouworkest Amsterdam",
          "Concertgebouw Orchestra",
        ],
        type: "Orchestra",
        Albums: albums(82),
      }),
    ],
  );

  assert.equal(match?.artist.id, "ad8260b2-2767-4e9b-9ece-7977fbcedadf");
  assert.equal(match?.status, "probable");
  assert.equal(match?.method, "musicbrainz-artist-alias-prefix");
});

test("provider artist matching uses MusicBrainz URL relationships before name fallback", () => {
  const match = serviceModule.bestCanonicalArtistMatch(
    {
      provider: "tidal",
      providerId: "3521263",
      name: "Wrong Provider Name",
      providerUrl: "https://listen.tidal.com/artist/3521263",
    },
    [
      artist({
        id: "wrong-name",
        artistname: "Wrong Provider Name",
        links: [{ target: "https://listen.tidal.com/artist/9999999", type: "tidal" }],
        Albums: albums(30),
      }),
      artist({
        id: "linked-artist",
        artistname: "Canonical Artist Name",
        links: [{ target: "https://tidal.com/browse/artist/3521263", type: "tidal" }],
        Albums: [],
      }),
    ],
    "tidal",
  );

  assert.equal(match?.artist.id, "linked-artist");
  assert.equal(match?.status, "verified");
  assert.equal(match?.method, "musicbrainz-artist-url");
});

test("provider artist matching keeps equally plausible prefix matches ambiguous", () => {
  const match = serviceModule.bestCanonicalArtistMatch(
    { providerId: "artist-1", name: "Test Ensemble" },
    [
      artist({
        id: "artist-a",
        artistname: "Test Ensemble North",
        Albums: albums(10),
      }),
      artist({
        id: "artist-b",
        artistname: "Test Ensemble South",
        Albums: albums(9),
      }),
    ],
  );

  assert.equal(match, null);
});

test("discography overlap resolves same-named artists that name evidence cannot separate", () => {
  // The "Eden problem": several MusicBrainz artists share the exact name, so
  // name scoring alone must stay ambiguous — but only one candidate shares
  // several album titles with the provider artist.
  const providerAlbums = [
    "i think you think too much of me",
    "vertigo (Deluxe Edition)",
    "no future",
    "About Time",
  ];

  const match = serviceModule.bestDiscographyOverlapMatch(providerAlbums, [
    artist({
      id: "eden-irish",
      artistname: "Eden",
      Albums: [
        { Id: "a", Title: "i think you think too much of me" },
        { Id: "b", Title: "vertigo" },
        { Id: "c", Title: "no future" },
      ],
    }),
    artist({
      id: "eden-other",
      artistname: "Eden",
      Albums: [
        { Id: "d", Title: "Completely Different Record" },
        { Id: "e", Title: "About Time" },
      ],
    }),
  ]);

  assert.equal(match?.artist.id, "eden-irish");
  assert.equal(match?.status, "probable");
  assert.equal(match?.method, "provider-discography-overlap");
});

test("discography overlap refuses to pick when candidates tie or share too little", () => {
  const providerAlbums = ["Greatest Hits", "Live at the Arena"];

  // One shared compilation title each — not enough separation to flip identity.
  const match = serviceModule.bestDiscographyOverlapMatch(providerAlbums, [
    artist({
      id: "artist-a",
      artistname: "Someone",
      Albums: [{ Id: "a", Title: "Greatest Hits" }],
    }),
    artist({
      id: "artist-b",
      artistname: "Someone Else",
      Albums: [{ Id: "b", Title: "Live at the Arena" }],
    }),
  ]);

  assert.equal(match, null);
});

test("resolve falls back to discography overlap for ambiguous names", async () => {
  const { ProviderArtistIdentityService } = serviceModule;
  const { servarrMetadata } = await import("./servarr-metadata.js");
  const original = servarrMetadata.searchForNewArtist;
  servarrMetadata.searchForNewArtist = async () => [
    artist({
      id: "band-japan",
      artistname: "Japan",
      Albums: [
        { Id: "a", Title: "Tin Drum" },
        { Id: "b", Title: "Gentlemen Take Polaroids" },
        { Id: "c", Title: "Quiet Life" },
      ],
    }),
    artist({
      id: "other-japan",
      artistname: "Japan",
      Albums: [{ Id: "d", Title: "Unrelated" }],
    }),
  ];

  try {
    const resolution = await ProviderArtistIdentityService.resolve(
      "tidal",
      { providerId: "test-japan-overlap", name: "Japan" },
      {
        listProviderAlbumTitles: async () => ["Tin Drum", "Quiet Life", "Gentlemen Take Polaroids (Remastered)"],
      },
    );
    assert.equal(resolution.mbid, "band-japan");
    assert.equal(resolution.method, "provider-discography-overlap");
    assert.equal(resolution.status, "probable");
  } finally {
    servarrMetadata.searchForNewArtist = original;
  }
});
