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

test("unchanged scheduled monitoring refresh still queues its disk scan", () => {
  eventsModule.appEvents.emit(eventsModule.AppEvent.ARTIST_REFRESH_COMPLETE, {
    artistId: "artist-1",
    artistName: "Bastille",
    workflow: "monitoring-intake",
    scanLibrary: true,
    metadataChanged: false,
    isNewArtist: false,
    trigger: 2,
    priority: 4,
  });

  const commands = dbModule.db.prepare("SELECT name, priority FROM commands ORDER BY id").all() as Array<{ name: string; priority: number }>;
  assert.deepEqual(commands.map((command) => command.name), [commandNamesModule.CommandNames.RescanFolders]);
  assert.equal(commands[0]?.priority, 5);
});

test("scheduled monitoring context reaches the queued scan command", () => {
  eventsModule.appEvents.emit(eventsModule.AppEvent.ARTIST_REFRESH_COMPLETE, {
    artistId: "artist-1",
    artistName: "Bastille",
    workflow: "monitoring-intake",
    monitoringCycle: "full-cycle",
    scanLibrary: true,
    metadataChanged: false,
    isNewArtist: false,
    trigger: 2,
    priority: 0,
  });

  const command = dbModule.db.prepare("SELECT name, payload FROM commands ORDER BY id DESC LIMIT 1").get() as { name: string; payload: string };
  assert.equal(command.name, commandNamesModule.CommandNames.RescanFolders);
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
    skipCuration: false,
    skipMetadataBackfill: false,
    trigger: 2,
    priority: 11,
  });

  const command = dbModule.db.prepare("SELECT name, priority FROM commands ORDER BY id DESC LIMIT 1")
    .get() as { name: string; priority: number };
  assert.equal(command.name, commandNamesModule.CommandNames.CurateArtist);
  assert.equal(command.priority, 12);
});

test("monitoring intake queues a scoped wanted check after curation completes", () => {
  eventsModule.appEvents.emit(eventsModule.AppEvent.ARTIST_CURATED, {
    commandId: 101,
    artistId: "artist-1",
    artistName: "Bastille",
    workflow: "monitoring-intake",
    trigger: 2,
    priority: 12,
  });

  const command = dbModule.db.prepare("SELECT name, priority, payload FROM commands ORDER BY id DESC LIMIT 1")
    .get() as { name: string; priority: number; payload: string };
  assert.equal(command.name, commandNamesModule.CommandNames.DownloadMissing);
  assert.equal(command.priority, 13);
  assert.deepEqual(JSON.parse(command.payload).artistIds, ["artist-1"]);
});

test("concurrent monitoring intake completions retain each artist scope", () => {
  for (const [index, artistId] of ["artist-1", "artist-2"].entries()) {
    eventsModule.appEvents.emit(eventsModule.AppEvent.ARTIST_CURATED, {
      commandId: 201 + index,
      artistId,
      artistName: `Artist ${index + 1}`,
      workflow: "monitoring-intake",
      trigger: 2,
      priority: 12,
    });
  }

  const commands = dbModule.db.prepare(`
    SELECT payload FROM commands
    WHERE name = ?
    ORDER BY id
  `).all(commandNamesModule.CommandNames.DownloadMissing) as Array<{ payload: string }>;
  assert.deepEqual(
    commands.map((command) => JSON.parse(command.payload).artistIds),
    [["artist-1"], ["artist-2"]],
  );
});

test("full monitoring leaves its terminal wanted check to the scheduler", () => {
  eventsModule.appEvents.emit(eventsModule.AppEvent.ARTIST_CURATED, {
    commandId: 102,
    artistId: "artist-1",
    artistName: "Bastille",
    workflow: "full-monitoring",
    monitoringCycle: "full-cycle",
    trigger: 2,
    priority: 12,
  });

  const count = dbModule.db.prepare("SELECT COUNT(*) AS count FROM commands WHERE name = ?")
    .get(commandNamesModule.CommandNames.DownloadMissing) as { count: number };
  assert.equal(count.count, 0);
});
