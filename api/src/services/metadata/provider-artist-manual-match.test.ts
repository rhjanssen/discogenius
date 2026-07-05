import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { CatalogSearchResults } from "../catalog/catalog-provider.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-manual-match-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let manualMatch: typeof import("./provider-artist-manual-match.js");
let identityService: typeof import("./provider-artist-identity-service.js");
let catalogRegistry: typeof import("../catalog/index.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  manualMatch = await import("./provider-artist-manual-match.js");
  identityService = await import("./provider-artist-identity-service.js");
  catalogRegistry = await import("../catalog/index.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function storeUnmatchedArtist(providerId: string, name: string) {
  identityService.ProviderArtistIdentityService.store("tidal", {
    providerId,
    name,
    picture: null,
    popularity: 10,
  }, {
    mbid: null,
    status: "provider_only",
    confidence: 0,
    method: "provider-artist-unmatched",
  });
}

function patchCatalogSearch(search: (query: string) => Promise<CatalogSearchResults>) {
  const active = catalogRegistry.catalogProviderRegistry.getActive();
  const original = active.search;
  active.search = ((query: string) => search(query)) as typeof active.search;
  return () => {
    active.search = original;
  };
}

test("ignoreProviderArtist hides the row from the unmatched list", () => {
  storeUnmatchedArtist("k-1", "Hit Tunes Karaoke");
  storeUnmatchedArtist("k-2", "Some Real Artist");

  assert.equal(identityService.ProviderArtistIdentityService.listUnmatched().length, 2);

  const result = manualMatch.ignoreProviderArtist("tidal", "k-1");
  assert.equal(result.ignored, true);

  const remaining = identityService.ProviderArtistIdentityService.listUnmatched();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].name, "Some Real Artist");
});

test("ignoreProviderArtist refuses unknown or already matched rows", () => {
  assert.throws(() => manualMatch.ignoreProviderArtist("tidal", "does-not-exist"), /Unknown or already matched/);

  identityService.ProviderArtistIdentityService.store("tidal", {
    providerId: "m-1",
    name: "Matched Artist",
  }, {
    mbid: "11111111-1111-1111-1111-111111111111",
    status: "verified",
    confidence: 1,
    method: "test",
  });
  assert.throws(() => manualMatch.ignoreProviderArtist("tidal", "m-1"), /Unknown or already matched/);
});

test("applyManualArtistMatch validates the MBID and the provider artist row", async () => {
  storeUnmatchedArtist("v-1", "Some Artist");

  await assert.rejects(
    () => manualMatch.applyManualArtistMatch("tidal", "v-1", "not-a-mbid"),
    /Not a valid MusicBrainz artist id/,
  );
  await assert.rejects(
    () => manualMatch.applyManualArtistMatch("tidal", "missing-row", "ad8260b2-2767-4e9b-9ece-7977fbcedadf"),
    /Unknown provider artist/,
  );
});

test("listManualMatchCandidates ranks discography overlap above bare name matches", async () => {
  storeUnmatchedArtist("eden-1", "Eden");

  const restoreSearch = patchCatalogSearch(async () => ({
    artists: [
      {
        id: "eden-big",
        artistname: "Eden",
        sortname: "Eden",
        artistaliases: [],
        links: [],
        images: [],
        Albums: [{ Id: "x", Title: "Unrelated Album" }],
      },
      {
        id: "eden-overlap",
        artistname: "EDEN",
        sortname: "EDEN",
        artistaliases: [],
        links: [],
        images: [],
        Albums: [
          { Id: "a", Title: "i think you think too much of me" },
          { Id: "b", Title: "vertigo" },
        ],
      },
    ],
  }));

  // No provider registered in tests → provider album fetch fails gracefully and
  // candidates still return, ranked by name/release data only.
  try {
    const result = await manualMatch.listManualMatchCandidates("tidal", "eden-1");
    assert.equal(result.artistName, "Eden");
    assert.equal(result.candidates.length, 2);
    // Without provider albums both have 0 shared; name-matched candidates first.
    assert.ok(result.candidates.every((candidate) => candidate.sharedAlbums.length === 0));

    // With provider titles, overlap dominates the ranking.
    const { intersectDiscographyTitles } = identityService;
    const overlap = intersectDiscographyTitles(
      ["vertigo (Deluxe)", "i think you think too much of me"],
      { id: "eden-overlap", artistname: "EDEN", sortname: "EDEN", images: [], Albums: [
        { Id: "a", Title: "i think you think too much of me" },
        { Id: "b", Title: "vertigo" },
      ] },
    );
    assert.equal(overlap.matched.length, 2);
  } finally {
    restoreSearch();
  }
});
