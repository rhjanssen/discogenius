import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { seedCanonicalAlbum } from "../../test-support/normalized-provider-fixtures.js";
import type { CatalogProvider, CatalogTrackArtistCredit } from "../catalog/catalog-provider.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-track-artist-credit-"));
const musicRoot = path.join(tempDir, "stereo");
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.MUSIC_PATH = musicRoot;
process.env.SPATIAL_PATH = path.join(tempDir, "spatial");
process.env.VIDEO_PATH = path.join(tempDir, "video");
process.env.DOWNLOAD_PATH = path.join(tempDir, "downloads");

const AFROJACK = "a3ee920f-4e7f-4993-8aca-4b8538cfaa4a";
const EVA = "481cbdd9-02ac-46fd-825f-afed658bc505";
const SUPREMES = "c1aa2ec9-53e7-4d90-8d36-bac75832e986";
const WAITS = "c3aeb863-7b26-4388-94e8-5a240f2be21b";
const GAYLE = "cefd9d3d-9506-461c-972f-89b4cbade9da";
const WINTORY = "78f15956-c5e1-46d6-a46b-fa6f46681ec8";
const TRIPOD = "4b6f7a3c-0000-4000-8000-000000000001";
const MONTAIGNE = "4b6f7a3c-0000-4000-8000-000000000002";

let dbModule: typeof import("../../database.js");
let tags: typeof import("./audio-tag-service.js");
let sync: typeof import("../metadata/track-artist-credit-sync.js");

before(async () => {
  fs.mkdirSync(musicRoot, { recursive: true });
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  tags = await import("./audio-tag-service.js");
  sync = await import("../metadata/track-artist-credit-sync.js");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const part = (artistMbid: string, artistName: string, artistSortName: string | null, creditedName = artistName, joinPhrase = "") =>
  ({ artistMbid, artistName, artistSortName, creditedName, joinPhrase });

// ---- pure mapping -------------------------------------------------------

test("feat. credit: ARTIST keeps the join phrase, ARTISTS/MBIDs/sort list every credited artist", () => {
  const plan = tags.planTrackArtistTags([
    part(AFROJACK, "Afrojack", "Afrojack", "Afrojack", " feat. "),
    part(EVA, "Eva Simons", "Simons, Eva"),
  ], "Owner");
  assert.equal(plan.artist, "Afrojack feat. Eva Simons");
  assert.deepEqual(plan.artists, ["Afrojack", "Eva Simons"]);
  assert.deepEqual(plan.artistMbids, [AFROJACK, EVA]);
  assert.equal(plan.artistSort, "Afrojack feat. Simons, Eva");
});

test("'&' credited-as name: ARTIST is the printed credit, ARTISTS the MusicBrainz artist", () => {
  const plan = tags.planTrackArtistTags([part(SUPREMES, "The Supremes", "Supremes, The", "Diana Ross & The Supremes")], "The Supremes");
  assert.equal(plan.artist, "Diana Ross & The Supremes");
  assert.deepEqual(plan.artists, ["The Supremes"]);
  assert.deepEqual(plan.artistMbids, [SUPREMES]);
  assert.equal(plan.artistSort, "Supremes, The");
});

test("multi-artist credit keeps MusicBrainz join phrases and order", () => {
  const plan = tags.planTrackArtistTags([
    part(WINTORY, "Austin Wintory", "Wintory, Austin", "Austin Wintory", ", "),
    part(TRIPOD, "Tripod", "Tripod", "Tripod", " & "),
    part(MONTAIGNE, "Montaigne", "Montaigne"),
  ], "Austin Wintory");
  assert.equal(plan.artist, "Austin Wintory, Tripod & Montaigne");
  assert.deepEqual(plan.artists, ["Austin Wintory", "Tripod", "Montaigne"]);
  assert.deepEqual(plan.artistMbids, [WINTORY, TRIPOD, MONTAIGNE]);
  assert.equal(plan.artistSort, "Wintory, Austin, Tripod & Montaigne");
});

test("an unknown sort name drops ARTISTSORT instead of writing a partial one; empty credit uses the fallback", () => {
  const partial = tags.planTrackArtistTags([part(AFROJACK, "Afrojack", "Afrojack", "Afrojack", " & "), part(EVA, "Eva Simons", null)], "x");
  assert.equal(partial.artistSort, null);
  const empty = tags.planTrackArtistTags([], "Owner Name");
  assert.deepEqual(empty, { artist: "Owner Name", artists: ["Owner Name"], artistMbids: [], artistSort: null });
});

// ---- tag pipeline -------------------------------------------------------

function fakeCatalog(credits: Record<string, CatalogTrackArtistCredit[]>): CatalogProvider {
  return {
    getTrackArtistCredits: async (mbids: string[]) => new Map(mbids.filter((mbid) => credits[mbid]).map((mbid) => [mbid, credits[mbid]])),
  } as unknown as CatalogProvider;
}

const credit = (artistId: string, artistName: string, artistSortName: string | null, creditedName = artistName, joinPhrase = ""): CatalogTrackArtistCredit =>
  ({ artistId, artistName, artistSortName, creditedName, joinPhrase });

function artistRowId(mbid: string, name: string, sortName: string | null): number {
  dbModule.db.prepare("INSERT OR IGNORE INTO ArtistMetadata (mbid, name, sort_name) VALUES (?, ?, ?)").run(mbid, name, sortName);
  return (dbModule.db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = ?").get(mbid) as { id: number }).id;
}

function insertFile(input: { ownerMbid: string; group: string; release: string; track?: string; recording?: string; name: string }): number {
  const library = dbModule.db.prepare("SELECT id, root_path FROM Libraries WHERE name = 'Stereo'").get() as { id: number; root_path: string };
  const filePath = path.join(musicRoot, input.group, input.name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "not-audio");
  const ownerId = (dbModule.db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = ?").get(input.ownerMbid) as { id: number }).id;
  return (dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, library_id, track_id, recording_id,
      canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid, provider, provider_id, provider_entity_type,
      file_path, relative_path, library_root, filename, extension, file_type, library_slot
    ) VALUES (
      ?, ?, (SELECT id FROM Tracks WHERE mbid = ?), (SELECT id FROM Recordings WHERE mbid = ?),
      ?, ?, ?, ?, ?, ?, ?, 'track',
      ?, ?, ?, ?, 'flac', 'track', 'stereo'
    ) RETURNING id
  `).get(
    ownerId, library.id, input.track ?? null, input.recording ?? null,
    input.ownerMbid, input.track ? input.group : null, input.track ? input.release : null,
    input.track ?? null, input.recording ?? null,
    input.track ? null : "tidal", input.track ? null : `tidal-${input.name}`,
    filePath, path.relative(library.root_path, filePath), library.root_path, path.basename(filePath),
  ) as { id: number }).id;
}

function desired(fileId: number): Map<string, string> {
  return new Map(tags.AudioTagService.buildDesiredTagsForTrackFileIdsForTest([fileId]).map((tag) => [tag.key, tag.targetValue]));
}

test("solo track on a duet album: track tags follow the track credit, album tags the album credit", async () => {
  const waitsId = artistRowId(WAITS, "Tom Waits", "Waits, Tom");
  const gayleId = artistRowId(GAYLE, "Crystal Gayle", "Gayle, Crystal");
  const seeded = seedCanonicalAlbum(dbModule.db, {
    artistMbid: WAITS, releaseGroupMbid: "rg-one-from-the-heart", releaseMbid: "rel-one-from-the-heart",
    title: "One From the Heart",
    tracks: [{ trackMbid: "efabadd4-cda6-4c1a-9ddd-cb3b065bdd55", recordingMbid: "rec-once-upon-a-town", title: "Once Upon a Town / Empty Pockets" }],
  });
  // What the catalogue sync stores today: the album credit copied onto every
  // track and recording (TrackArtistCredits/RecordingArtistCredits).
  for (const [ordinal, artistId, name, join] of [[0, waitsId, "Tom Waits", " and "], [1, gayleId, "Crystal Gayle", ""]] as const) {
    dbModule.db.prepare("INSERT INTO ReleaseArtistCredits (edition_id, artist_id, ordinal, credited_name, join_phrase) VALUES (?, ?, ?, ?, ?)")
      .run(seeded.editionId, artistId, ordinal, name, join);
    dbModule.db.prepare("INSERT INTO TrackArtistCredits (track_id, artist_id, ordinal, credited_name, join_phrase) VALUES ((SELECT id FROM Tracks WHERE mbid = 'efabadd4-cda6-4c1a-9ddd-cb3b065bdd55'), ?, ?, ?, ?)")
      .run(artistId, ordinal, name, join);
  }
  const fileId = insertFile({ ownerMbid: WAITS, group: "rg-one-from-the-heart", release: "rel-one-from-the-heart",
    track: "efabadd4-cda6-4c1a-9ddd-cb3b065bdd55", recording: "rec-once-upon-a-town", name: "14 - Once Upon a Town.flac" });

  const result = await sync.TrackArtistCreditSync.syncForTrackFiles([fileId], {
    catalog: fakeCatalog({ "efabadd4-cda6-4c1a-9ddd-cb3b065bdd55": [credit(WAITS, "Tom Waits", "Waits, Tom")] }),
  });
  assert.equal(result.changed, 1);
  const byKey = desired(fileId);
  assert.equal(byKey.get("artist"), "Tom Waits");
  assert.equal(byKey.get("artists"), "Tom Waits");
  assert.equal(byKey.get("musicbrainz_artistid"), WAITS);
  assert.equal(byKey.get("artist_sort"), "Waits, Tom");
  // Album side unchanged: primary artist only, full credit kept losslessly.
  assert.equal(byKey.get("album_artist"), "Tom Waits");
  assert.equal(byKey.get("album_artists"), "Tom Waits; Crystal Gayle");
  assert.equal(byKey.get("musicbrainz_albumartistid"), WAITS);

  // A second sync with the same credit writes nothing.
  const again = await sync.TrackArtistCreditSync.syncForTrackFiles([fileId], {
    catalog: fakeCatalog({ "efabadd4-cda6-4c1a-9ddd-cb3b065bdd55": [credit(WAITS, "Tom Waits", "Waits, Tom")] }),
  });
  assert.equal(again.changed, 0);
});

test("feat. remix: track credit replaces the owner, and a credited-as artist name is repaired to MusicBrainz", async () => {
  // Older builds stored the credited-as spelling as the artist's name.
  artistRowId(AFROJACK, "AFROJACK", "Afrojack");
  seedCanonicalAlbum(dbModule.db, {
    artistMbid: AFROJACK, releaseGroupMbid: "rg-take-over-control", releaseMbid: "rel-take-over-control",
    title: "Take Over Control (The Remixes 2025)",
    tracks: [{ trackMbid: "3fc4ed9c-5995-4648-9bcd-4dc1da9cc64e", recordingMbid: "rec-nitefreak", title: "Take Over Control (Nitefreak remix)" }],
  });
  const fileId = insertFile({ ownerMbid: AFROJACK, group: "rg-take-over-control", release: "rel-take-over-control",
    track: "3fc4ed9c-5995-4648-9bcd-4dc1da9cc64e", recording: "rec-nitefreak", name: "01 - Take Over Control.flac" });
  assert.equal(desired(fileId).get("artist"), "AFROJACK", "before the sync: owner only, credited-as spelling");

  const result = await sync.TrackArtistCreditSync.syncForTrackFiles([fileId], {
    catalog: fakeCatalog({
      "3fc4ed9c-5995-4648-9bcd-4dc1da9cc64e": [
        credit(AFROJACK, "Afrojack", "Afrojack", "Afrojack", " feat. "),
        credit(EVA, "Eva Simons", "Simons, Eva"),
      ],
    }),
  });
  assert.equal(result.artistsRepaired >= 1, true);
  const byKey = desired(fileId);
  assert.equal(byKey.get("artist"), "Afrojack feat. Eva Simons");
  assert.equal(byKey.get("artists"), "Afrojack; Eva Simons");
  assert.equal(byKey.get("musicbrainz_artistid"), `${AFROJACK}; ${EVA}`);
  assert.equal(byKey.get("artist_sort"), "Afrojack feat. Simons, Eva");
  assert.equal(byKey.get("album_artist"), "Afrojack");
  assert.equal(byKey.get("musicbrainz_albumartistid"), AFROJACK);
});

test("provider-only single (no MusicBrainz track): owner's MusicBrainz name, no album credit leakage", async () => {
  artistRowId(SUPREMES, "The Supremes", "Supremes, The");
  const fileId = insertFile({ ownerMbid: SUPREMES, group: "provider-single", release: "", name: "01 - Provider Single.flac" });
  // Sync is a no-op without a MusicBrainz track.
  const result = await sync.TrackArtistCreditSync.syncForTrackFiles([fileId], { catalog: fakeCatalog({}) });
  assert.equal(result.requested, 0);
  const byKey = desired(fileId);
  assert.equal(byKey.get("artist"), "The Supremes");
  assert.equal(byKey.get("artists"), "The Supremes");
  assert.equal(byKey.get("musicbrainz_artistid"), SUPREMES);
  assert.equal(byKey.get("artist_sort"), "Supremes, The");
  assert.equal(byKey.get("album_artist"), "The Supremes");
});

test("catalogue without per-track credits or unreachable: nothing changes and nothing throws", async () => {
  const fileId = (dbModule.db.prepare("SELECT id FROM TrackFiles WHERE canonical_track_mbid = ?")
    .get("efabadd4-cda6-4c1a-9ddd-cb3b065bdd55") as { id: number }).id;
  const unsupported = await sync.TrackArtistCreditSync.syncForTrackFiles([fileId], { catalog: {} as CatalogProvider });
  assert.equal(unsupported.supported, false);
  const failing = await sync.TrackArtistCreditSync.syncForTrackFiles([fileId], {
    catalog: { getTrackArtistCredits: async () => { throw new Error("connection refused"); } } as unknown as CatalogProvider,
  });
  assert.match(failing.error ?? "", /connection refused/);
  assert.equal(desired(fileId).get("artist"), "Tom Waits");
});

test("credit sync never renames an artist to a credited-as name", async () => {
  const { catalogProviderRegistry } = await import("../catalog/index.js");
  const { MusicBrainzArtistCreditService } = await import("../metadata/musicbrainz-artist-credit-service.js");
  const MJ = "f27ec8db-af05-4f36-916e-3d57f91ecf5e";
  artistRowId(MJ, "Michael Jackson", "Jackson, Michael");
  const active = catalogProviderRegistry.getActive();
  catalogProviderRegistry.register({
    ...active,
    id: catalogProviderRegistry.getActiveId(),
    getCreditedReleaseGroupsForArtist: async () => [{
      id: "rg-mj-credited",
      title: "Credited as MJ",
      primaryType: "Single",
      secondaryTypes: [],
      firstReleaseDate: "2001",
      artistCredits: [
        { artistId: MJ, name: "MJ", joinPhrase: " & ", artistName: "Michael Jackson", artistSortName: "Jackson, Michael" },
        { artistId: "new-artist-credited", name: "Guest (credited)", joinPhrase: "", artistName: "Guest", artistSortName: "Guest" },
      ],
    }],
  } as CatalogProvider);
  try {
    await MusicBrainzArtistCreditService.syncCreditedReleaseGroupsForArtist(MJ);
  } finally {
    catalogProviderRegistry.register(active);
  }
  const names = new Map((dbModule.db.prepare("SELECT mbid, name, sort_name FROM ArtistMetadata WHERE mbid IN (?, ?)")
    .all(MJ, "new-artist-credited") as Array<{ mbid: string; name: string; sort_name: string }>).map((row) => [row.mbid, row]));
  assert.equal(names.get(MJ)?.name, "Michael Jackson");
  assert.equal(names.get("new-artist-credited")?.name, "Guest");
  assert.equal(names.get("new-artist-credited")?.sort_name, "Guest");
  const credited = dbModule.db.prepare(`SELECT credited_name FROM AlbumArtists WHERE release_group_mbid = 'rg-mj-credited' ORDER BY ord`).all() as Array<{ credited_name: string }>;
  assert.deepEqual(credited.map((row) => row.credited_name), ["MJ", "Guest (credited)"]);
});
