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
  assert.equal(errors.errorIndicatesProviderAuth(new Error("Apple Music decryption failed because the wrapper session expired or Apple rejected it.")), true);
  const appleWrapped = errors.asProviderAuthError("apple-music", new Error("Apple Music decryption failed because the wrapper session expired."));
  assert.equal(appleWrapped?.provider, "apple-music");
  assert.equal(appleWrapped?.code, "needs_reauth");
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
    assert.equal(events[0]?.banner, "Sign in to Tidal again");
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

test("recordProviderAuthFailure: updates since to now when transitioning from ok, and keeps since when already needs_reauth", async () => {
  const oldOkSince = "2026-01-01T00:00:00.000Z";
  dbModule.db.prepare(`
    INSERT INTO ProviderAuthState (provider, status, since, updated_at)
    VALUES ('test-prov', 'ok', ?, ?)
    ON CONFLICT(provider) DO UPDATE SET status = 'ok', since = excluded.since, updated_at = excluded.updated_at
  `).run(oldOkSince, oldOkSince);

  // Transition from ok to needs_reauth: since MUST be updated to now, not keep old ok since
  const fail1 = await auth.recordProviderAuthFailure("test-prov", "expired token");
  assert.equal(fail1.transitioned, true);
  assert.equal(fail1.persisted, true);
  const row1 = auth.readProviderAuthPublic("test-prov");
  assert.notEqual(row1?.since, oldOkSince, "since must not keep old ok since when transitioning to needs_reauth");
  assert.ok(row1?.since);
  const failureSince = row1?.since;

  // Now test apple-music: ok -> needs_reauth updates since, then stuck message rewrite keeps since
  const oldAppleOkSince = "2026-01-01T00:00:00.000Z";
  dbModule.db.prepare(`
    INSERT INTO ProviderAuthState (provider, status, since, updated_at)
    VALUES ('apple-music', 'ok', ?, ?)
    ON CONFLICT(provider) DO UPDATE SET status = 'ok', since = excluded.since, updated_at = excluded.updated_at
  `).run(oldAppleOkSince, oldAppleOkSince);

  const appleFail1 = await auth.recordProviderAuthFailure("apple-music", "ports 10020 not answering");
  assert.equal(appleFail1.transitioned, true);
  const appleRow1 = auth.readProviderAuthPublic("apple-music");
  assert.notEqual(appleRow1?.since, oldAppleOkSince, "apple since must update on ok -> needs_reauth transition");
  const initialAppleFailSince = appleRow1?.since;
  assert.ok(initialAppleFailSince);

  // Repeat failure on apple-music with stuck message: should rewrite, but retain since from initial failure
  const appleFail2 = await auth.recordProviderAuthFailure("apple-music", auth.APPLE_WRAPPER_STUCK_MESSAGE);
  assert.equal(appleFail2.persisted, true, "should rewrite once for stuck message");
  assert.equal(appleFail2.transitioned, false);
  const appleRow2 = auth.readProviderAuthPublic("apple-music");
  assert.equal(appleRow2?.lastError, auth.APPLE_WRAPPER_STUCK_MESSAGE);
  assert.equal(appleRow2?.since, initialAppleFailSince, "since must be kept when already needs_reauth");
});

test("recordProviderAuthFailure: rewrites once when already held and message changes to APPLE_WRAPPER_STUCK_MESSAGE, does not rewrite again, and ignores generic /stuck/ on other providers", async () => {
  // 1. Initial failure for deezer
  await auth.recordProviderAuthFailure("deezer", "first deezer failure");
  const deezerBefore = auth.readProviderAuthPublic("deezer");
  assert.equal(deezerBefore?.lastError, "first deezer failure");

  // Generic /stuck/i message on a non-apple provider must NOT rewrite
  const deezerRepeat = await auth.recordProviderAuthFailure("deezer", "deezer is stuck; restart the wrapper container");
  assert.equal(deezerRepeat.persisted, false, "generic stuck message on non-apple provider must not rewrite");
  const deezerAfter = auth.readProviderAuthPublic("deezer");
  assert.equal(deezerAfter?.lastError, "first deezer failure");

  // 2. apple-music: transition to needs_reauth with unreachable error
  await auth.recordProviderAuthOk("apple-music");
  await auth.recordProviderAuthFailure("apple-music", "ports unreachable");
  const appleBefore = auth.readProviderAuthPublic("apple-music");
  assert.equal(appleBefore?.lastError, "ports unreachable");

  // Rewrite once to APPLE_WRAPPER_STUCK_MESSAGE
  const appleStuck = await auth.recordProviderAuthFailure("apple-music", auth.APPLE_WRAPPER_STUCK_MESSAGE);
  assert.equal(appleStuck.persisted, true, "must rewrite once when message changes to APPLE_WRAPPER_STUCK_MESSAGE");
  const appleAfterStuck = auth.readProviderAuthPublic("apple-music");
  assert.equal(appleAfterStuck?.lastError, auth.APPLE_WRAPPER_STUCK_MESSAGE);

  // Calling again with the same stuck message must NOT rewrite again
  const appleStuckAgain = await auth.recordProviderAuthFailure("apple-music", auth.APPLE_WRAPPER_STUCK_MESSAGE);
  assert.equal(appleStuckAgain.persisted, false, "must not rewrite again when stuck message is unchanged");
});

test("recordProviderAuthFailure: a Tidal session wait does not downgrade a real expired login", async () => {
  await auth.recordProviderAuthOk("tidal");
  const initialFail = await auth.recordProviderAuthFailure("tidal", "Tidal login expired (token has expired).");
  assert.equal(initialFail.transitioned, true);
  const initialRow = auth.readProviderAuthPublic("tidal");
  assert.equal(initialRow?.lastError, "Tidal login expired (token has expired).");
  assert.equal(initialRow?.banner, "Sign in to Tidal again");

  const downgradeAttempt = await auth.recordProviderAuthFailure("tidal", errors.TIDAL_SESSION_WAIT_MESSAGE);
  assert.equal(downgradeAttempt.persisted, false, "session wait must not overwrite expired login");
  assert.equal(downgradeAttempt.transitioned, false);

  const rowAfter = auth.readProviderAuthPublic("tidal");
  assert.equal(rowAfter?.lastError, "Tidal login expired (token has expired).");
  assert.equal(rowAfter?.banner, "Sign in to Tidal again");
});

test("recordProviderAuthFailure: a Tidal session wait escalates to a real expired login", async () => {
  await auth.recordProviderAuthOk("tidal");
  const waitFail = await auth.recordProviderAuthFailure("tidal", errors.TIDAL_SESSION_WAIT_MESSAGE);
  assert.equal(waitFail.transitioned, true);
  const waitRow = auth.readProviderAuthPublic("tidal");
  assert.equal(waitRow?.lastError, errors.TIDAL_SESSION_WAIT_MESSAGE);
  assert.equal(waitRow?.banner, errors.TIDAL_SESSION_WAIT_MESSAGE);

  const escalation = await auth.recordProviderAuthFailure("tidal", "Tidal login expired (token has expired).");
  assert.equal(escalation.persisted, true, "expired login must overwrite session wait");
  assert.equal(escalation.transitioned, false);

  const escalatedRow = auth.readProviderAuthPublic("tidal");
  assert.equal(escalatedRow?.lastError, "Tidal login expired (token has expired).");
  assert.equal(escalatedRow?.banner, "Sign in to Tidal again");
});

test("queueHoldMessage falls back to stored last_error for Tidal session wait and hold guards do not mutate session wait", async () => {
  await auth.recordProviderAuthOk("tidal");
  await auth.recordProviderAuthFailure("tidal", errors.TIDAL_SESSION_WAIT_MESSAGE);

  assert.equal(auth.queueHoldMessage("tidal"), "Waiting for Tidal token refresh");

  const guardResult = await auth.recordProviderAuthFailure("tidal", auth.queueHoldMessage("tidal"));
  assert.equal(guardResult.persisted, false, "hold guard message must not overwrite session wait");

  const row = auth.readProviderAuthPublic("tidal");
  assert.equal(row?.lastError, errors.TIDAL_SESSION_WAIT_MESSAGE);
  assert.equal(row?.banner, errors.TIDAL_SESSION_WAIT_MESSAGE);
});
