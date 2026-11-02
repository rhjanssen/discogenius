import assert from "node:assert/strict";
import { after } from "node:test";
import test from "node:test";
import { prepareActiveSchemaEnv, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";
import { AppEvent } from "../commands/app-events.js";

const { tempDir } = prepareActiveSchemaEnv("auth-hold");
const dbModule = await import("../../database.js");
dbModule.initDatabase();
const { DownloadWaitQueue } = await import("./download-wait-queue.js");
const auth = await import("../providers/provider-auth-state.js");
const { retryAuthFailedAlbums } = await import("./download-auth-retry.js");
const { appEvents } = await import("../commands/app-events.js");

after(() => closeActiveSchemaDb(dbModule, tempDir));

function enqueueAlbum(provider: string, providerId: string, title: string): number {
  const queued = DownloadWaitQueue.enqueue({
    refKey: providerId,
    mediaKind: "album",
    commandName: "DownloadAlbum",
    provider,
    providerId,
    title,
    artist: "Artist",
    payload: { provider, providerId, title, type: "album" },
    position: "back",
    notify: false,
  });
  return queued.id;
}

test("a Tidal auth failure holds its queue while Deezer still starts, in the original order", async () => {
  const events: string[] = [];
  const onAuth = () => { events.push("auth"); };
  appEvents.on(AppEvent.PROVIDER_AUTH_CHANGED, onAuth);
  try {
    const first = enqueueAlbum("tidal", "tidal-1", "First");
    const second = enqueueAlbum("tidal", "tidal-2", "Second");
    const deezer = enqueueAlbum("deezer", "deezer-1", "Deezer album");
    await auth.recordProviderAuthFailure("tidal", "token has expired");
    assert.equal(events.length, 1);

    const claimed = DownloadWaitQueue.claimNextPage();
    assert.equal(claimed.claimed?.wait.id, deezer);
    assert.equal(claimed.claimed?.wait.provider, "deezer");
    const deezerCommand = dbModule.db.prepare("SELECT status, attempts FROM commands WHERE id = ?").get(
      claimed.claimed?.commandId,
    ) as { status: string; attempts: number };
    assert.equal(deezerCommand.status, "queued");
    assert.equal(deezerCommand.attempts, 0);

    for (const id of [first, second]) {
      const row = dbModule.db.prepare("SELECT command_id, payload, queue_order FROM DownloadQueue WHERE id = ?").get(id) as {
        command_id: number | null;
        payload: string;
        queue_order: number;
      };
      assert.equal(row.command_id, null);
      assert.match(row.payload, /Waiting for Tidal login/);
    }
    assert.equal((dbModule.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE status = 'failed'").get() as { n: number }).n, 0);

    await auth.recordProviderAuthFailure("tidal", "token has expired");
    assert.equal(events.length, 1);

    await auth.recordProviderAuthOk("tidal");
    assert.equal(events.length, 2);
    const resumedFirst = DownloadWaitQueue.claimNextPage();
    assert.equal(resumedFirst.claimed?.wait.id, first);
    const resumedSecond = DownloadWaitQueue.claimNextPage();
    assert.equal(resumedSecond.claimed?.wait.id, second);
    const held = dbModule.db.prepare("SELECT payload FROM DownloadQueue WHERE id = ?").get(first) as { payload: string };
    assert.equal(JSON.parse(held.payload).authHold, undefined);
  } finally {
    appEvents.off(AppEvent.PROVIDER_AUTH_CHANGED, onAuth);
  }
});

test("a started download that hits an auth error returns to the queue instead of Failed", async () => {
  const command = dbModule.db.prepare(`
    INSERT INTO commands (name, ref_id, payload, status, attempts, attempt, error)
    VALUES ('DownloadAlbum', 'tidal-live', '{"provider":"tidal","providerId":"tidal-live","type":"album"}', 'started', 1, 1, NULL)
  `).run();
  const commandId = Number(command.lastInsertRowid);
  const wait = DownloadWaitQueue.enqueue({
    refKey: "tidal-live",
    mediaKind: "album",
    commandName: "DownloadAlbum",
    provider: "tidal",
    providerId: "tidal-live",
    title: "Live",
    payload: { provider: "tidal", providerId: "tidal-live", type: "album" },
    notify: false,
  });
  dbModule.db.prepare("UPDATE DownloadQueue SET command_id = ? WHERE id = ?").run(commandId, wait.id);
  DownloadWaitQueue.releaseForAuthHold(commandId, "tidal");
  const row = dbModule.db.prepare("SELECT command_id, payload FROM DownloadQueue WHERE id = ?").get(wait.id) as {
    command_id: number | null;
    payload: string;
  };
  assert.equal(row.command_id, null);
  assert.match(row.payload, /Waiting for Tidal login/);
  assert.equal(dbModule.db.prepare("SELECT id FROM commands WHERE id = ?").get(commandId), undefined);
  assert.equal(
    (dbModule.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE status = 'failed'").get() as { n: number }).n,
    0,
  );
});

test("retrying auth-failed history requeues only those albums, oldest first", () => {
  const now = Date.now();
  const insert = dbModule.db.prepare(`
    INSERT INTO commands (name, ref_id, payload, status, error, completed_at, attempts)
    VALUES (?, ?, ?, 'failed', ?, ?, 1)
  `);
  insert.run(
    "DownloadAlbum",
    "old-auth",
    JSON.stringify({ provider: "tidal", providerId: "old-auth", title: "Old", type: "album" }),
    "token has expired",
    new Date(now - 30 * 86_400_000).toISOString(),
  );
  insert.run(
    "DownloadAlbum",
    "recent-auth",
    JSON.stringify({ provider: "tidal", providerId: "recent-auth", title: "Recent", type: "album" }),
    "Tidal login expired (token has expired).",
    new Date(now - 2 * 86_400_000).toISOString(),
  );
  insert.run(
    "DownloadAlbum",
    "recent-missing",
    JSON.stringify({ provider: "deezer", providerId: "recent-missing", title: "Missing", type: "album" }),
    "HTTP 404 Not Found",
    new Date(now - 1 * 86_400_000).toISOString(),
  );
  insert.run(
    "DownloadTrack",
    "track-auth",
    JSON.stringify({ provider: "tidal", providerId: "track-auth", type: "track" }),
    "token has expired",
    new Date(now - 1 * 86_400_000).toISOString(),
  );
  insert.run(
    "DownloadAlbum",
    "newer-auth",
    JSON.stringify({ provider: "deezer", providerId: "newer-auth", title: "Newer", type: "album" }),
    "Deezer ARL is invalid or expired.",
    new Date(now - 12 * 60 * 60 * 1000).toISOString(),
  );

  const result = retryAuthFailedAlbums(14);
  assert.equal(result.requeued, 2);
  const titles = result.jobIds.map((id) => {
    const row = dbModule.db.prepare("SELECT title, provider FROM DownloadQueue WHERE id = ?").get(id) as {
      title: string;
      provider: string;
    };
    return `${row.provider}:${row.title}`;
  });
  assert.deepEqual(titles, ["tidal:Recent", "deezer:Newer"]);
  assert.equal(
    dbModule.db.prepare("SELECT id FROM DownloadQueue WHERE provider_id = 'recent-missing'").get(),
    undefined,
  );
  assert.equal(
    dbModule.db.prepare("SELECT id FROM DownloadQueue WHERE provider_id = 'old-auth'").get(),
    undefined,
  );
});
