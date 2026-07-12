import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-curation-listener-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let eventsModule: typeof import("../commands/app-events.js");
let commandNamesModule: typeof import("../commands/command-names.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  eventsModule = await import("../commands/app-events.js");
  commandNamesModule = await import("../commands/command-names.js");
  const listenerModule = await import("./curation.listener.js");
  listenerModule.initCurationListeners();
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM commands").run();
});

after(() => {
  eventsModule.appEvents.removeAllListeners();
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("unchanged scheduled monitoring refresh skips rescan and continues to curation", () => {
  eventsModule.appEvents.emit(eventsModule.AppEvent.ARTIST_REFRESH_COMPLETE, {
    artistId: "artist-1",
    artistName: "Bastille",
    workflow: "monitoring-intake",
    scanLibrary: true,
    metadataChanged: false,
    isNewArtist: false,
    forceDownloadQueue: false,
    trigger: 2,
  });

  const commands = dbModule.db.prepare("SELECT name FROM commands ORDER BY id").all() as Array<{ name: string }>;
  assert.deepEqual(commands.map((command) => command.name), [commandNamesModule.CommandNames.CurateArtist]);
});

test("changed scheduled monitoring refresh queues the per-artist rescan", () => {
  eventsModule.appEvents.emit(eventsModule.AppEvent.ARTIST_REFRESH_COMPLETE, {
    artistId: "artist-1",
    artistName: "Bastille",
    workflow: "monitoring-intake",
    scanLibrary: true,
    metadataChanged: true,
    isNewArtist: false,
    forceDownloadQueue: false,
    trigger: 2,
  });

  const commands = dbModule.db.prepare("SELECT name FROM commands ORDER BY id").all() as Array<{ name: string }>;
  assert.deepEqual(commands.map((command) => command.name), [commandNamesModule.CommandNames.RescanFolders]);
});

test("manual refresh-scan rescans even when metadata is unchanged", () => {
  eventsModule.appEvents.emit(eventsModule.AppEvent.ARTIST_REFRESH_COMPLETE, {
    artistId: "artist-1",
    artistName: "Bastille",
    workflow: "refresh-scan",
    scanLibrary: true,
    metadataChanged: false,
    isNewArtist: false,
    forceDownloadQueue: false,
    trigger: 1,
  });

  const commands = dbModule.db.prepare("SELECT name FROM commands ORDER BY id").all() as Array<{ name: string }>;
  assert.deepEqual(commands.map((command) => command.name), [commandNamesModule.CommandNames.RescanFolders]);
});
