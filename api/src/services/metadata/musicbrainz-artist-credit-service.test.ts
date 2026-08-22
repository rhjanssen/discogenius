import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-mb-credits-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let creditServiceModule: typeof import("./musicbrainz-artist-credit-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  creditServiceModule = await import("./musicbrainz-artist-credit-service.js");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("credited release discovery adds visible unmonitored collaborators and preserves ordered album credits", async () => {
  const { catalogProviderRegistry } = await import("../catalog/index.js");
  const originalGetActive = catalogProviderRegistry.getActive.bind(catalogProviderRegistry);
  catalogProviderRegistry.getActive = () => ({
    id: "test-catalog",
    getCreditedReleaseGroupsForArtist: async () => [{
      id: "4977de41-d626-41ea-ae29-b6ebb29843eb",
      title: "Happier",
      primaryType: "Single",
      secondaryTypes: [],
      artistCredits: [
        {
          artistId: "301b45a4-b8b9-410e-8344-4b4eaf96691a",
          name: "Marshmello",
          joinPhrase: " & ",
        },
        {
          artistId: "7808accb-6395-4b25-858c-678bbb73896b",
          name: "Bastille",
          joinPhrase: "",
        },
      ],
    }],
  }) as any;

  try {
    await creditServiceModule.MusicBrainzArtistCreditService.syncCreditedReleaseGroupsForArtist(
      "7808accb-6395-4b25-858c-678bbb73896b",
    );
  } finally {
    catalogProviderRegistry.getActive = originalGetActive;
  }

  const marshmello = dbModule.db.prepare("SELECT name, monitored, library_origin FROM Artists WHERE id = ?")
    .get("301b45a4-b8b9-410e-8344-4b4eaf96691a") as any;
  assert.equal(marshmello.name, "Marshmello");
  assert.equal(marshmello.monitored, 0);
  assert.equal(marshmello.library_origin, "musicbrainz-credit");

  const album = dbModule.db.prepare("SELECT artist_mbid FROM Albums WHERE mbid = ?")
    .get("4977de41-d626-41ea-ae29-b6ebb29843eb") as any;
  assert.equal(album.artist_mbid, "301b45a4-b8b9-410e-8344-4b4eaf96691a");

  const artists = creditServiceModule.MusicBrainzArtistCreditService.getAlbumArtists(
    "4977de41-d626-41ea-ae29-b6ebb29843eb",
  );
  assert.deepEqual(
    artists.map((artist) => ({ id: artist.artistId, name: artist.name, joinPhrase: artist.joinPhrase })),
    [
      { id: "301b45a4-b8b9-410e-8344-4b4eaf96691a", name: "Marshmello", joinPhrase: " & " },
      { id: "7808accb-6395-4b25-858c-678bbb73896b", name: "Bastille", joinPhrase: "" },
    ],
  );

  const bastilleScope = dbModule.db.prepare(`
    SELECT 1
    FROM ArtistReleaseGroups
    WHERE artist_mbid = ? AND release_group_mbid = ?
  `).get("7808accb-6395-4b25-858c-678bbb73896b", "4977de41-d626-41ea-ae29-b6ebb29843eb");
  assert.ok(bastilleScope);
});

test("Servarr catalog without credited browse leaves credits empty instead of calling musicbrainz.org", async () => {
  const { catalogProviderRegistry } = await import("../catalog/index.js");
  const originalGetActive = catalogProviderRegistry.getActive.bind(catalogProviderRegistry);
  catalogProviderRegistry.getActive = () => ({ id: "servarr-metadata" }) as any;
  try {
    const result = await creditServiceModule.MusicBrainzArtistCreditService.syncCreditedReleaseGroupsForArtist(
      "7808accb-6395-4b25-858c-678bbb73896b",
    );
    assert.deepEqual(result, { releaseGroups: 0, artists: 0, artistMbids: [] });
  } finally {
    catalogProviderRegistry.getActive = originalGetActive;
  }
});

