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
    priority: 4,
  });

  const commands = dbModule.db.prepare("SELECT name, priority FROM commands ORDER BY id").all() as Array<{ name: string; priority: number }>;
  assert.deepEqual(commands.map((command) => command.name), [commandNamesModule.CommandNames.CurateArtist]);
  assert.equal(commands[0]?.priority, 5);
});

test("scheduled monitoring context reaches the queued curation command", () => {
  eventsModule.appEvents.emit(eventsModule.AppEvent.ARTIST_REFRESH_COMPLETE, {
    artistId: "artist-1",
    artistName: "Bastille",
    workflow: "monitoring-intake",
    monitoringCycle: "full-cycle",
    scanLibrary: true,
    metadataChanged: false,
    isNewArtist: false,
    forceDownloadQueue: false,
    trigger: 2,
    priority: 0,
  });

  const command = dbModule.db.prepare("SELECT name, payload FROM commands ORDER BY id DESC LIMIT 1").get() as { name: string; payload: string };
  assert.equal(command.name, commandNamesModule.CommandNames.CurateArtist);
  assert.equal(JSON.parse(command.payload).monitoringCycle, "full-cycle");
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
    priority: 7,
  });

  const commands = dbModule.db.prepare("SELECT name, priority, payload FROM commands ORDER BY id").all() as Array<{ name: string; priority: number; payload: string }>;
  assert.deepEqual(commands.map((command) => command.name), [commandNamesModule.CommandNames.RescanFolders]);
  assert.equal(commands[0]?.priority, 8);
  assert.equal(JSON.parse(commands[0].payload).filter, "matched");
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
    priority: 0,
  });

  const commands = dbModule.db.prepare("SELECT name, payload FROM commands ORDER BY id").all() as Array<{ name: string; payload: string }>;
  assert.deepEqual(commands.map((command) => command.name), [commandNamesModule.CommandNames.RescanFolders]);
  assert.equal(JSON.parse(commands[0].payload).filter, "known");
});

test("artist scan completion advances curation priority", () => {
  eventsModule.appEvents.emit(eventsModule.AppEvent.ARTIST_SCANNED, {
    artistId: "artist-1",
    artistName: "Bastille",
    workflow: "monitoring-intake",
    monitoringCycle: "full-cycle",
    skipDownloadQueue: false,
    skipCuration: false,
    skipMetadataBackfill: false,
    forceDownloadQueue: true,
    trigger: 2,
    priority: 11,
  });

  const command = dbModule.db.prepare("SELECT name, priority FROM commands ORDER BY id DESC LIMIT 1")
    .get() as { name: string; priority: number };
  assert.equal(command.name, commandNamesModule.CommandNames.CurateArtist);
  assert.equal(command.priority, 12);
});
