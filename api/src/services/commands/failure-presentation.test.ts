import assert from "node:assert/strict";
import { test } from "node:test";
import { presentFailure } from "./failure-presentation.js";

// Error texts stored on Primula, 18–21 Nov 2026.
const LIVE = {
  deezerNoData: "Streamrip produced no Deezer media files: unknown: [21:41:44] ERROR Error getting downloadable data for track 1 track.py:153; unavailable: unavailable: no media URL for this track;; unknown: ERROR Error getting downloadable data for track 2 track.py:153.",
  deezerApiTraceback: "Streamrip exited with 1: unknown: Traceback (most recent call last) ; unknown: 51 if result_json['error']['code'] == 500: raise WrongPar ; unknown: 56 raise APIError(json.dumps(result_json['error']))",
  appleAlbumResponse: "apple-music-downloader exited with code 0: Failed to get album response.",
  appleToken: "apple-music-downloader exited with code 1: ⚠ Failed to dl MV: media-user-token may wrong or expired",
  ytBare: "yt-dlp exited with code 1: ERROR:",
  ytAge: "yt-dlp exited with code 1: ERROR: [youtube] wIaaBuGNwNw: Sign in to confirm your age. Use --cookies-from-browser or --cookies for the authentication.",
  ytRemoved: "yt-dlp exited with code 1: ERROR: [youtube] KLW0TLSmdr4: This video is not available",
  tidalSession: "TIDAL session is not available yet; waiting for a token refresh",
  importMissing: "[ImportDownload] Canonical audio tags were not applied for album 433171891: 1 file(s) missing",
  importIdentity: "[ImportDownload] Acquisition plan 13539967 has no exact provider offers available for apple-music; refusing to organize files without identity",
  restartImport: "Dedicated download worker restarted before the attempt completed; import execution may have partially mutated library files and was not replayed",
  curationRestart: "Command stopped after 3 execution attempt(s): Discogenius process restarted while command was running",
  refreshStalled: "Command stopped after 3 execution attempt(s): worker stopped: Command watchdog recovered progress stopped",
  upgradesBusy: "Command stopped after 3 execution attempt(s): sqlite busy: database is locked",
};

test("live failures read as a cause and a next step, and keep the original text", () => {
  const cases: Array<[string, string | null, string, string]> = [
    [LIVE.deezerNoData, "deezer", "unavailable", "Not available on Deezer"],
    [LIVE.deezerApiTraceback, "deezer", "unknown", "Deezer returned an error for this item"],
    [LIVE.appleAlbumResponse, "apple-music", "unavailable", "Apple Music didn't return this album"],
    [LIVE.appleToken, "apple-music", "account", "Apple Music sign-in has expired"],
    [LIVE.ytBare, "youtube-music", "unknown", "YouTube Music failed without giving a reason"],
    [LIVE.ytAge, "youtube-music", "account", "YouTube asks for age verification for this video"],
    [LIVE.ytRemoved, "youtube-music", "unavailable", "Not available on YouTube Music"],
    [LIVE.tidalSession, "tidal", "account", "TIDAL was refreshing its sign-in"],
    [LIVE.importMissing, "apple-music", "import", "Import incomplete: 1 file(s) went missing before tagging"],
    [LIVE.importIdentity, "apple-music", "import", "Couldn't match the downloaded files to the album's tracks"],
    [LIVE.restartImport, "tidal", "interrupted", "Import was interrupted before it finished"],
    [LIVE.curationRestart, null, "interrupted", "Interrupted by an app restart"],
    [LIVE.refreshStalled, null, "interrupted", "Stopped because it made no progress"],
    [LIVE.upgradesBusy, null, "unknown", "The database stayed busy, so this was stopped"],
  ];
  for (const [error, provider, category, summary] of cases) {
    const failure = presentFailure(error, { provider });
    assert.ok(failure, error);
    assert.equal(failure.category, category, error);
    assert.equal(failure.summary, summary, error);
    assert.equal(failure.detail, error);
    assert.ok(failure.summary.length <= 120, failure.summary);
    assert.doesNotMatch(failure.summary, /Traceback|exited with|\[ImportDownload\]/u);
  }
});

test("an expired sign-in links to that provider's sign-in page", () => {
  const failure = presentFailure("Deezer ARL is invalid or expired.", { provider: "deezer" });
  assert.equal(failure?.action?.href, "/auth?provider=deezer#deezer-arl");
});

test("an unrecognised failure keeps its own words without tool prefixes", () => {
  const failure = presentFailure("Streamrip exited with 1: APIError: {\"type\": \"Exception\", \"message\": \"Something odd\", \"code\": 42}", { provider: "deezer" });
  assert.equal(failure?.category, "unknown");
  assert.equal(failure?.summary, "Deezer returned an error for this item");

  const plain = presentFailure("Album download track identities must use the selected provider", {});
  assert.equal(plain?.summary, "Album download track identities must use the selected provider");
  assert.equal(presentFailure("   ", {}), null);
});
