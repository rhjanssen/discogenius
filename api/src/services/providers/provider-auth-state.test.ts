import assert from "node:assert/strict";
import { after } from "node:test";
import test from "node:test";
import { prepareActiveSchemaEnv, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";
import { AppEvent } from "../commands/app-events.js";

const { tempDir } = prepareActiveSchemaEnv("provider-auth");
const dbModule = await import("../../database.js");
const auth = await import("./provider-auth-state.js");
const errors = await import("./provider-auth-error.js");
const { appEvents } = await import("../commands/app-events.js");

after(() => closeActiveSchemaDb(dbModule, tempDir));

test("auth text classifies expired logins and ignores transient network errors", () => {
  // An expired ACCESS token is renewed by the refresh token; only the refresh
  // endpoint (ProviderAuthError / "Tidal login expired") proves a dead login.
  assert.equal(errors.errorIndicatesProviderAuth(new Error("The token has expired. (Expired on time)")), false);
  assert.equal(errors.errorIndicatesProviderAuth(new Error("Tidal login expired (token has expired).")), true);
  assert.equal(errors.isHistoricalAuthFailure("The token has expired. (Expired on time)"), true);
  assert.equal(errors.errorIndicatesProviderAuth(new Error("TIDAL token refresh failed (HTTP 401: invalid_token)")), true);
  assert.equal(errors.errorIndicatesProviderAuth(new Error("Invalid ARL: reconnect Deezer")), true);
  assert.equal(errors.errorIndicatesProviderAuth(new Error("Deezer ARL is invalid or expired.")), true);
  assert.equal(errors.isHistoricalAuthFailure("arl expired"), true);
  assert.equal(errors.errorIndicatesProviderAuth(new Error("TIDAL token refresh failed (HTTP 400: invalid_grant)")), false);
  assert.equal(errors.errorIndicatesProviderAuth(new Error("TIDAL token refresh failed (HTTP 403: abuse_detected)")), false);
  assert.equal(errors.errorIndicatesProviderAuth(new Error("read ECONNRESET")), false);
  assert.equal(errors.errorIndicatesProviderAuth(new Error("fetch failed")), false);
  assert.equal(errors.errorIndicatesProviderAuth(new errors.ProviderAuthError("deezer", "nope")), true);
  assert.equal(errors.asProviderAuthError("Tidal", new Error("The token has expired. (Expired on time)")), null);
  const wrapped = errors.asProviderAuthError("Tidal", new Error("Tidal login expired (token has expired)."));
  assert.equal(wrapped?.provider, "tidal");
  assert.equal(errors.asProviderAuthError("deezer", new Error("socket hang up")), null);
});

test("a database without the auth table does not persist or throw", async () => {
  auth.resetProviderAuthCacheForTests();
  const result = await auth.recordProviderAuthFailure("tidal", "token has expired");
  assert.deepEqual(result, { provider: "tidal", status: "unknown", transitioned: false, persisted: false });
  assert.deepEqual(auth.listProviderAuthPublic(), []);
});

test("migration adds ProviderAuthState and leaves user_version at 46", () => {
  dbModule.initDatabase();
  auth.resetProviderAuthCacheForTests();
  assert.equal(dbModule.db.pragma("user_version", { simple: true }), 46);
  const table = dbModule.db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ProviderAuthState'",
  ).get();
  assert.ok(table);
  const marker = dbModule.db.prepare("SELECT value FROM config WHERE key = ?").get(
    "schema.migration.provider-auth-state",
  ) as { value: string } | undefined;
  assert.equal(marker?.value, "applied");
  assert.doesNotThrow(() => dbModule.initDatabase());
  assert.equal(dbModule.db.pragma("user_version", { simple: true }), 46);
});

function insertWait(row: { ref: string; provider: string; order: number; commandId?: number; payload?: string }): void {
  dbModule.db.prepare(`
    INSERT INTO DownloadQueue (ref_key, media_kind, command_name, provider, payload, queue_order, command_id)
    VALUES (?, 'album', 'DownloadAlbum', ?, ?, ?, ?)
  `).run(row.ref, row.provider, row.payload ?? "{}", row.order, row.commandId ?? null);
}

function payloadOf(ref: string): string {
  const row = dbModule.db.prepare("SELECT payload FROM DownloadQueue WHERE ref_key = ?").get(ref) as { payload: string };
  return row.payload;
}

test("needs_reauth holds unclaimed rows once, and a valid login resumes them once", async () => {
  const events: Array<{ provider: string; status: string; held: number; banner: string | null }> = [];
  const onAuth = (payload: { provider: string; status: string; held: number; banner: string | null }) => {
    events.push(payload);
  };
  appEvents.on(AppEvent.PROVIDER_AUTH_CHANGED, onAuth);
  try {
    insertWait({ ref: "tidal-a", provider: "tidal", order: 1 });
    insertWait({ ref: "tidal-b", provider: "Tidal", order: 2 });
    insertWait({ ref: "tidal-running", provider: "tidal", order: 3, commandId: 99 });
    insertWait({ ref: "deezer-a", provider: "deezer", order: 4 });

    const first = await auth.recordProviderAuthOk("tidal");
    assert.equal(first.persisted, true);
    assert.equal(first.transitioned, true);
    assert.equal(events.length, 0, "first ok is not a recovery notification");

    const again = await auth.recordProviderAuthOk("tidal");
    assert.equal(again.persisted, false);
    const updatedAfterOk = (dbModule.db.prepare(
      "SELECT updated_at FROM ProviderAuthState WHERE provider = 'tidal'",
    ).get() as { updated_at: string }).updated_at;

    const failed = await auth.recordProviderAuthFailure("tidal", "token has expired");
    assert.equal(failed.persisted, true);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.banner, "Tidal opnieuw inloggen");
    assert.equal(events[0]?.held, 2);
    assert.match(payloadOf("tidal-a"), /Waiting for Tidal login/);
    assert.match(payloadOf("tidal-b"), /Waiting for Tidal login/);
    assert.equal(payloadOf("tidal-running"), "{}");
    assert.equal(payloadOf("deezer-a"), "{}");
    assert.equal(auth.providerNeedsReauth("tidal"), true);
    assert.equal(auth.providerNeedsReauth("deezer"), false);
    const stamped = dbModule.db.prepare(
      "SELECT updated_at, last_error FROM ProviderAuthState WHERE provider = 'tidal'",
    ).get() as { updated_at: string; last_error: string };
    assert.notEqual(stamped.updated_at, updatedAfterOk);

    const repeat = await auth.recordProviderAuthFailure("tidal", "token has expired again");
    assert.equal(repeat.persisted, false);
    assert.equal(events.length, 1);
    const updatedAfterRepeat = dbModule.db.prepare(
      "SELECT updated_at, last_error FROM ProviderAuthState WHERE provider = 'tidal'",
    ).get() as { updated_at: string; last_error: string };
    assert.equal(updatedAfterRepeat.updated_at, stamped.updated_at);
    assert.equal(updatedAfterRepeat.last_error, "token has expired");

    const recovered = await auth.recordProviderAuthOk("tidal");
    assert.equal(recovered.transitioned, true);
    assert.equal(events.length, 2);
    assert.equal(events[1]?.status, "ok");
    assert.equal(events[1]?.banner, null);
    assert.equal(JSON.parse(payloadOf("tidal-a")).authHold, undefined);
    assert.equal(JSON.parse(payloadOf("deezer-a")).authHold, undefined);
    assert.equal(auth.providerNeedsReauth("tidal"), false);

    const quiet = await auth.recordProviderAuthOk("tidal");
    assert.equal(quiet.persisted, false);
    assert.equal(events.length, 2);
  } finally {
    appEvents.off(AppEvent.PROVIDER_AUTH_CHANGED, onAuth);
  }
});

test("a Deezer ARL older than 75 days warns without changing auth status", async () => {
  const savedAt = new Date(Date.now() - 80 * 86_400_000).toISOString();
  await auth.recordProviderAuthOk("deezer", {
    accountLabel: "Robert · HiFi · NL",
    credentialSavedAt: savedAt,
  });
  const row = auth.readProviderAuthPublic("deezer");
  assert.equal(row?.status, "ok");
  assert.equal(row?.accountLabel, "Robert · HiFi · NL");
  assert.equal(row?.credentialAgeDays, 80);
  assert.match(row?.ageWarning ?? "", /Deze ARL is 80 dagen oud/);
  assert.equal(row?.banner, null);
});

test("an auth-ok touch older than 6 hours is written once and does not notify", async () => {
  const events: string[] = [];
  const onAuth = () => { events.push("event"); };
  appEvents.on(AppEvent.PROVIDER_AUTH_CHANGED, onAuth);
  try {
    dbModule.db.prepare(`
      UPDATE ProviderAuthState
      SET last_ok_at = ?, updated_at = ?
      WHERE provider = 'deezer'
    `).run(new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(), "stale");
    auth.resetProviderAuthCacheForTests();
    const touched = await auth.recordProviderAuthOk("deezer");
    assert.equal(touched.persisted, true);
    assert.equal(touched.transitioned, false);
    assert.equal(events.length, 0);
    const quiet = await auth.recordProviderAuthOk("deezer");
    assert.equal(quiet.persisted, false);
  } finally {
    appEvents.off(AppEvent.PROVIDER_AUTH_CHANGED, onAuth);
  }
});
