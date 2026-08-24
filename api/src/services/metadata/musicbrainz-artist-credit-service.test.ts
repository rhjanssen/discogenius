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

  const marshmello = dbModule.db.prepare(`
    SELECT metadata.name AS name,
           CASE WHEN membership.id IS NULL THEN 0 ELSE 1 END AS monitored,
           membership.library_origin AS library_origin
    FROM ArtistMetadata metadata
    LEFT JOIN LibraryArtists membership ON membership.artist_metadata_id = metadata.id
    WHERE metadata.mbid = ?
    LIMIT 1
  `).get("301b45a4-b8b9-410e-8344-4b4eaf96691a") as any;
  assert.equal(marshmello.name, "Marshmello");
  assert.equal(marshmello.monitored, 0);
  assert.equal(marshmello.library_origin, null);

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
    SELECT artist_metadata_id, release_group_id
    FROM ArtistReleaseGroups
    WHERE artist_mbid = ? AND release_group_mbid = ?
  `).get("7808accb-6395-4b25-858c-678bbb73896b", "4977de41-d626-41ea-ae29-b6ebb29843eb") as {
    artist_metadata_id: number | null;
    release_group_id: number | null;
  };
  assert.ok(bastilleScope);
  assert.ok(bastilleScope.artist_metadata_id);
  assert.ok(bastilleScope.release_group_id);

  const integerCredits = dbModule.db.prepare(`
    SELECT canonical.mbid AS artist_mbid, credit.credited_name, credit.join_phrase, credit.ordinal
    FROM ReleaseGroupArtistCredits credit
    JOIN Albums release_group ON release_group.id = credit.release_group_id
    JOIN ArtistMetadata canonical ON canonical.id = credit.artist_id
    WHERE release_group.mbid = ?
    ORDER BY credit.ordinal ASC
  `).all("4977de41-d626-41ea-ae29-b6ebb29843eb") as Array<{
    artist_mbid: string;
    credited_name: string;
    join_phrase: string;
    ordinal: number;
  }>;
  assert.deepEqual(
    integerCredits.map((credit) => ({
      id: credit.artist_mbid,
      name: credit.credited_name,
      joinPhrase: credit.join_phrase,
      ordinal: credit.ordinal,
    })),
    [
      { id: "301b45a4-b8b9-410e-8344-4b4eaf96691a", name: "Marshmello", joinPhrase: " & ", ordinal: 0 },
      { id: "7808accb-6395-4b25-858c-678bbb73896b", name: "Bastille", joinPhrase: "", ordinal: 1 },
    ],
  );
});

test("ensurePrimaryScope writes integer credits and copies them onto later editions", () => {
  const { MusicBrainzArtistCreditService } = creditServiceModule;
  MusicBrainzArtistCreditService.ensureArtist("7808accb-6395-4b25-858c-678bbb73896b", "Bastille");
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run("rg-primary-scope", "7808accb-6395-4b25-858c-678bbb73896b", "Wild World", "Album");

  MusicBrainzArtistCreditService.ensurePrimaryScope(
    "rg-primary-scope",
    "7808accb-6395-4b25-858c-678bbb73896b",
    "Bastille",
  );

  const rgCredits = dbModule.db.prepare(`
    SELECT COUNT(*) AS n FROM ReleaseGroupArtistCredits credit
    JOIN Albums release_group ON release_group.id = credit.release_group_id
    WHERE release_group.mbid = ?
  `).get("rg-primary-scope") as { n: number };
  assert.equal(rgCredits.n, 1);

  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title)
    VALUES (?, ?, ?, ?)
  `).run("edition-primary-scope", "rg-primary-scope", "7808accb-6395-4b25-858c-678bbb73896b", "Wild World");
  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title, artist_mbid)
    VALUES (?, ?, ?)
  `).run("rec-primary-scope", "Good Grief", "7808accb-6395-4b25-858c-678bbb73896b");
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, title)
    VALUES (?, ?, ?, 1, 1, ?)
  `).run("track-primary-scope", "edition-primary-scope", "rec-primary-scope", "Good Grief");

  MusicBrainzArtistCreditService.materializeIntegerCreditsForReleaseGroup("rg-primary-scope");

  const editionCredits = dbModule.db.prepare(`
    SELECT COUNT(*) AS n FROM ReleaseArtistCredits credit
    JOIN AlbumEditions edition ON edition.id = credit.edition_id
    WHERE edition.mbid = ?
  `).get("edition-primary-scope") as { n: number };
  assert.equal(editionCredits.n, 1);

  const recordingCredits = dbModule.db.prepare(`
    SELECT COUNT(*) AS n FROM RecordingArtistCredits credit
    JOIN Recordings recording ON recording.id = credit.recording_id
    WHERE recording.mbid = ?
  `).get("rec-primary-scope") as { n: number };
  assert.equal(recordingCredits.n, 1);

  const trackCredits = dbModule.db.prepare(`
    SELECT COUNT(*) AS n FROM TrackArtistCredits credit
    JOIN Tracks track ON track.id = credit.track_id
    WHERE track.mbid = ?
  `).get("track-primary-scope") as { n: number };
  assert.equal(trackCredits.n, 1);
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

