import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { CatalogArtistLocaleAlias, CatalogProvider } from "../catalog/catalog-provider.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-artist-locale-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.MUSIC_PATH = path.join(tempDir, "stereo");
process.env.SPATIAL_PATH = path.join(tempDir, "spatial");
process.env.VIDEO_PATH = path.join(tempDir, "video");
process.env.DOWNLOAD_PATH = path.join(tempDir, "downloads");

const TCHAIKOVSKY = "9ddd7abc-9e1b-471d-8031-583bc6bc8be9";
const SAKAMOTO = "eda3ed0c-5c4c-4c2e-8d9e-f2a3a1e6f0a1";
const AFROJACK = "a3ee920f-4e7f-4993-8aca-4b8538cfaa4a";
const EVA = "481cbdd9-02ac-46fd-825f-afed658bc505";

const tchaikovskyAliases: CatalogArtistLocaleAlias[] = [
  { name: "Pjotr Iljitsj Tsjaikovski", sortName: "Tsjaikovski, Pjotr Iljitsj", locale: "nl", primaryForLocale: true, type: "Artist name" },
  { name: "Peter Tchaikovsky", sortName: "Tchaikovsky, Peter", locale: "en", primaryForLocale: false, type: "Artist name" },
  { name: "Pyotr Ilyich Tchaikovsky", sortName: "Tchaikovsky, Pyotr Ilyich", locale: "en", primaryForLocale: true, type: "Artist name" },
  { name: "Tchaik", sortName: null, locale: "en", primaryForLocale: false, type: "Search hint" },
];
const ON = { enabled: true, locales: ["en", "nl"], skipLatin: true };

let dbModule: typeof import("../../database.js");
let names: typeof import("./artist-locale-names.js");
let tags: typeof import("../mediafiles/audio-tag-service.js");
let sync: typeof import("./track-artist-credit-sync.js");

before(async () => {
  fs.mkdirSync(process.env.MUSIC_PATH!, { recursive: true });
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  names = await import("./artist-locale-names.js");
  tags = await import("../mediafiles/audio-tag-service.js");
  sync = await import("./track-artist-credit-sync.js");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("Latin-script detection ignores digits and punctuation", () => {
  assert.equal(names.isLatinScript("Björk & Sigur Rós (2001)"), true);
  assert.equal(names.isLatinScript("Пётр Ильич Чайковский"), false);
  assert.equal(names.isLatinScript("坂本龍一"), false);
  assert.equal(names.isLatinScript("Ryuichi 坂本"), false);
  assert.equal(names.isLatinScript("!!!"), true);
});

test("locale list is normalised and deduplicated", () => {
  assert.deepEqual(names.normalizeLocaleList("en, nl,EN,en-GB,xx-??"), ["en", "nl", "en_gb"]);
  assert.deepEqual(names.normalizeLocaleList(["nl"]), ["nl"]);
});

test("en before nl: the primary English alias wins (Tchaikovsky, not Tsjaikovski)", () => {
  const out = names.translateArtistName("Пётр Ильич Чайковский", "Tchaikovsky, Pyotr Ilyich", tchaikovskyAliases, ON);
  assert.deepEqual(out, { name: "Pyotr Ilyich Tchaikovsky", sortName: "Tchaikovsky, Pyotr Ilyich", translated: true });
});

test("nl first picks the Dutch primary alias", () => {
  const out = names.translateArtistName("Пётр Ильич Чайковский", null, tchaikovskyAliases, { ...ON, locales: ["nl", "en"] });
  assert.equal(out.name, "Pjotr Iljitsj Tsjaikovski");
  assert.equal(out.sortName, "Tsjaikovski, Pjotr Iljitsj");
});

test("falls through the locale list, accepts regional locales, never uses search hints", () => {
  const aliases: CatalogArtistLocaleAlias[] = [
    { name: "Hint", sortName: null, locale: "en", primaryForLocale: true, type: "Search hint" },
    { name: "Legal", sortName: null, locale: "nl", primaryForLocale: true, type: "Legal name" },
    { name: "Regional", sortName: null, locale: "nl_BE", primaryForLocale: true, type: "Artist name" },
  ];
  assert.equal(names.chooseLocaleAlias(aliases, ["en", "nl"])?.name, "Legal");
  assert.equal(names.chooseLocaleAlias(aliases.slice(0, 1), ["en"]), null);
  assert.equal(names.chooseLocaleAlias(aliases.slice(2), ["nl"])?.name, "Regional");
});

test("Latin names are kept when skipLatin is on, translated when it is off; disabled is a no-op", () => {
  const aliases: CatalogArtistLocaleAlias[] = [{ name: "Bjork", sortName: "Bjork", locale: "en", primaryForLocale: true, type: "Artist name" }];
  assert.equal(names.translateArtistName("Björk", "Björk", aliases, ON).name, "Björk");
  assert.equal(names.translateArtistName("Björk", "Björk", aliases, { ...ON, skipLatin: false }).name, "Bjork");
  assert.equal(names.translateArtistName("Пётр", null, tchaikovskyAliases, { ...ON, enabled: false }).translated, false);
  assert.equal(names.translateArtistName("Пётр", null, [], ON).translated, false);
});

test("sync stores aliases; track credit parts are translated, real credited-as names kept", async () => {
  const catalog = {
    async getTrackArtistCredits() { return new Map(); },
    async getArtistLocaleAliases(mbids: string[]) {
      return new Map(mbids.map((mbid) => [mbid, mbid === TCHAIKOVSKY ? tchaikovskyAliases
        : mbid === SAKAMOTO ? [{ name: "Ryuichi Sakamoto", sortName: "Sakamoto, Ryuichi", locale: "en", primaryForLocale: true, type: "Artist name" }]
        : []]));
    },
  } as unknown as CatalogProvider;
  const changed = await sync.TrackArtistCreditSync.syncArtistLocaleAliases([TCHAIKOVSKY, SAKAMOTO, AFROJACK], catalog);
  assert.equal(changed, 2);
  assert.equal(await sync.TrackArtistCreditSync.syncArtistLocaleAliases([TCHAIKOVSKY], catalog), 0, "unchanged aliases are not rewritten");

  const parts = tags.translateTrackArtistCreditParts([
    { artistMbid: TCHAIKOVSKY, artistName: "Пётр Ильич Чайковский", artistSortName: "Tchaikovsky, Pyotr Ilyich", creditedName: "Пётр Ильич Чайковский", joinPhrase: ", " },
    { artistMbid: SAKAMOTO, artistName: "坂本龍一", artistSortName: "Sakamoto, Ryuichi", creditedName: "坂本", joinPhrase: " & " },
    { artistMbid: AFROJACK, artistName: "Afrojack", artistSortName: "Afrojack", creditedName: "AFROJACK", joinPhrase: " feat. " },
    { artistMbid: EVA, artistName: "Eva Simons", artistSortName: "Simons, Eva", creditedName: "Eva Simons", joinPhrase: "" },
  ], ON);
  const plan = tags.planTrackArtistTags(parts, "Owner");
  assert.equal(plan.artist, "Pyotr Ilyich Tchaikovsky, 坂本 & AFROJACK feat. Eva Simons");
  assert.deepEqual(plan.artists, ["Pyotr Ilyich Tchaikovsky", "Ryuichi Sakamoto", "Afrojack", "Eva Simons"]);
  assert.equal(plan.artistSort, "Tchaikovsky, Pyotr Ilyich, Sakamoto, Ryuichi & Afrojack feat. Simons, Eva");
  assert.deepEqual(plan.artistMbids, [TCHAIKOVSKY, SAKAMOTO, AFROJACK, EVA]);
});

test("options come from metadata config; default for this install is on, en then nl, skip Latin", () => {
  assert.deepEqual(tags.getArtistNameTranslationOptions({ translate_artist_names: true, artist_name_locales: "en,nl" }), ON);
  assert.equal(tags.getArtistNameTranslationOptions({ translate_artist_names: false }).enabled, false);
  assert.deepEqual(tags.getArtistNameTranslationOptions(), ON);
});
