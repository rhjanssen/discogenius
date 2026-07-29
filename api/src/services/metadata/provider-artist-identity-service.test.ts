import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { LidarrArtist } from "./servarr-metadata.js";
import type { CatalogSearchResults } from "../catalog/catalog-provider.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-provider-artist-identity-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let serviceModule: typeof import("./provider-artist-identity-service.js");
let dbModule: typeof import("../../database.js");
let catalogRegistry: typeof import("../catalog/index.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  serviceModule = await import("./provider-artist-identity-service.js");
  catalogRegistry = await import("../catalog/index.js");
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

function patchCatalogSearch(search: (query: string) => Promise<CatalogSearchResults>) {
  const active = catalogRegistry.catalogProviderRegistry.getActive();
  const original = active.search;
  active.search = ((query: string) => search(query)) as typeof active.search;
  return () => {
    active.search = original;
  };
}

function albumSearchRow(input: {
  rgId: string;
  title: string;
  artistId: string;
  artistName: string;
  artistDisambiguation?: string;
  barcode?: string | null;
  trackCount?: number;
}) {
  return {
    score: 0,
    artist: null,
    album: {
      id: input.rgId,
      title: input.title,
      type: "Single",
      releasedate: "2021-01-26",
      artistid: input.artistId,
      artists: [
        {
          id: input.artistId,
          artistname: input.artistName,
          sortname: input.artistName,
          disambiguation: input.artistDisambiguation || "",
          type: "Person",
          Albums: [],
        },
      ],
      Releases: [
        {
          Id: `${input.rgId}-release`,
          Title: input.title,
          Barcode: input.barcode ?? null,
          ReleaseDate: "2021-01-26",
          TrackCount: input.trackCount ?? 1,
          MediumCount: 1,
          Tracks: [
            {
              Id: `${input.rgId}-track`,
              RecordingId: `${input.rgId}-recording`,
              TrackName: input.title,
              TrackPosition: 1,
              MediumNumber: 1,
              DurationMs: 180000,
            },
          ],
        },
      ],
    },
  };
}

test("stored provider artist identity writes normalized facts and an accepted typed edge", () => {
  const mbid = "11111111-1111-4111-8111-111111111111";
  dbModule.db.prepare(`
    INSERT OR IGNORE INTO ArtistMetadata (mbid, name) VALUES (?, 'Typed Artist')
  `).run(mbid);
  serviceModule.ProviderArtistIdentityService.store("tidal", {
    providerId: "typed-provider-artist",
    name: "Typed Artist",
    picture: "https://images.example/artist.jpg",
    providerUrl: "https://tidal.com/artist/typed-provider-artist",
  }, {
    mbid,
    status: "verified",
    confidence: 1,
    method: "external-id",
  });
  assert.deepEqual(
    dbModule.db.prepare(`
      SELECT
        item.entity_type,
        item.provider_id,
        item.artwork_url,
        match.match_state,
        match.decision_source,
        match.confidence,
        canonical.mbid
      FROM ProviderItems item
      JOIN ProviderArtistMatches match ON match.provider_artist_item_id = item.id
      JOIN ArtistMetadata canonical ON canonical.id = match.artist_id
      WHERE item.provider = 'tidal'
        AND item.entity_type = 'artist'
        AND item.provider_id = 'typed-provider-artist'
    `).get(),
    {
      entity_type: "artist",
      provider_id: "typed-provider-artist",
      artwork_url: "https://images.example/artist.jpg",
      match_state: "accepted",
      decision_source: "automatic",
      confidence: 1,
      mbid,
    },
  );
});

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
  const restoreSearch = patchCatalogSearch(async () => ({
    artists: [
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
    ],
  }));

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
    restoreSearch();
  }
});

test("resolve expands candidates from provider release evidence when artist search misses the right MB artist", async () => {
  const { ProviderArtistIdentityService } = serviceModule;
  const { servarrMetadata } = await import("./servarr-metadata.js");
  const originalSearchArtist = servarrMetadata.searchForNewArtist;
  const originalSearchAll = servarrMetadata.searchAll;
  servarrMetadata.searchForNewArtist = async () => [
    artist({
      id: "7c88f831-947b-48ce-b6c4-4376cf83a979",
      artistname: "Eden",
      disambiguation: "Australian indie rock band",
      Albums: [
        { Id: "a", Title: "Stone Cat" },
        { Id: "b", Title: "Healingbow" },
      ],
    }),
    artist({
      id: "806c9da0-255c-43fb-932b-39c9a0aa621a",
      artistname: "Eden",
      disambiguation: "Swedish pop group",
      Albums: [],
    }),
  ];
  servarrMetadata.searchAll = async (query: string) => {
    if (query.includes("Set Me Free")) {
      return [albumSearchRow({
        rgId: "b1201e96-6ae0-4922-a5dd-89e161cc15f3",
        title: "Set Me Free",
        artistId: "1be7cde4-8c97-4a83-8a85-5fd251da4be8",
        artistName: "Eden Alene",
        artistDisambiguation: "Israeli singer",
      })];
    }
    if (query.includes("Feker Libi")) {
      return [albumSearchRow({
        rgId: "01790eb5-ea5f-4437-8544-b922ef58e783",
        title: "Feker Libi",
        artistId: "1be7cde4-8c97-4a83-8a85-5fd251da4be8",
        artistName: "Eden Alene",
        artistDisambiguation: "Israeli singer",
      })];
    }
    return [];
  };

  try {
    const resolution = await ProviderArtistIdentityService.resolve(
      "tidal",
      { providerId: "33469788", name: "Eden", providerUrl: "https://tidal.com/artist/33469788" },
      {
        listProviderAlbums: async () => [
          { provider: "tidal", providerId: "1", title: "Set Me Free", trackCount: 1, volumeCount: 1 },
          { provider: "tidal", providerId: "2", title: "Feker Libi", trackCount: 1, volumeCount: 1 },
        ],
      },
    );
    assert.equal(resolution.mbid, "1be7cde4-8c97-4a83-8a85-5fd251da4be8");
    assert.equal(resolution.method, "provider-discography-release-search");
    assert.equal(resolution.status, "probable");
  } finally {
    servarrMetadata.searchForNewArtist = originalSearchArtist;
    servarrMetadata.searchAll = originalSearchAll;
  }
});

test("release evidence treats unique UPC matches as verified artist evidence", async () => {
  const restoreSearch = patchCatalogSearch(async () => ({
    artists: [],
    raw: [
      albumSearchRow({
        rgId: "rg-upc",
        title: "Specific Single",
        artistId: "artist-upc",
        artistName: "Short Name Extended",
        barcode: "123456789012",
      }),
    ],
  }));

  try {
    const candidates = await serviceModule.findArtistCandidatesByProviderReleaseEvidence(
      { providerId: "provider-short", name: "Short Name" },
      [{ providerId: "album-upc", title: "Specific Single", upc: "123456789012", trackCount: 1, volumeCount: 1 }],
      "tidal",
    );
    const match = serviceModule.bestProviderReleaseEvidenceArtistMatch(candidates);
    assert.equal(match?.artist.id, "artist-upc");
    assert.equal(match?.status, "verified");
    assert.equal(match?.method, "provider-discography-upc");
  } finally {
    restoreSearch();
  }
});
