# Provider auth

A download provider's login is one state, not a reason to fail every queued
album. Tidal and Deezer use it today. Apple Music, Spotify, Amazon, and
YouTube report the same `ProviderAuthError` when they grow a login check.

## State

`ProviderAuthState` stores `ok`, `needs_reauth`, or `unknown`, plus
`last_ok_at`, `last_error`, `since`, the account label, when the credential
was saved, and when it was last probed.

`recordProviderAuthFailure` and `recordProviderAuthOk` are the only writers.
A second failure while the provider is already `needs_reauth` does not write
and does not notify again. A healthy provider is touched at most every 6
hours unless the account label, saved credential, or probe time changed.
Transient network errors are not auth failures.

The table is migration `provider-auth-state`. It does not change
`user_version` (46 before and after). A database that is already 46, including
one with RetagArtist 19285 running or queued, only gains this table.

## Hold and resume

While a provider is `needs_reauth`, its unclaimed downloads stay on the wait
queue with a reason such as `Waiting for Deezer login`. They are not started,
not failed, and the retry counter is not incremented. The scheduler does not
fall through to another provider. Other providers keep downloading.

An album already downloading when the login dies is put back on that wait
queue. The started command is deleted, so it does not become `Failed`.

Saving a valid Tidal login or a valid Deezer ARL sets the provider to `ok`
and clears the hold. The download worker then claims those albums in their
original `queue_order`.

`POST /api/v1/queue/retry-auth-failures` (`days`, default 14, max 90) puts
back only `DownloadAlbum` rows that already failed with an auth error. The
banner button calls it. It does not requeue a 404 or a track.

## Deezer ARL

The ARL is the user's browser cookie, about 192 hex characters. Discogenius
does not refresh it, does not store an email or password, does not use a
leaked mobile app id, and does not drive a browser login.

- A paste is checked as 192 hex characters before any network call. Then
  `deezer.getUserData` must return a real `USER_ID`. The settings row shows
  the account name, plan, and country. `USER_ID` 0 is `needs_reauth`.
- The same call runs about every 6 hours, and once before a Deezer batch when
  the last probe is older than that. A network or 502 error leaves the status
  alone and does not write `last_probe_at`. The next try waits 15 minutes in
  memory so a dead network is not probed on every queue tick.
- `arl_saved_at` and `last_ok_at` are stored. Settings shows the age. At 75
  days the row warns, in Dutch, to paste a new ARL before it expires.
- If a gw response sends a new `Set-Cookie` `arl`, that cookie is saved. The
  value is never logged.
- Deezer downloads stay single-flight, with a short jitter between requests.
- Album metadata resolve uses one `requests` session. The streamrip bridge
  serializes that session (pool size 1, blocking). A full connection pool,
  a connection reset, or a timeout is a bounded same-offer retry and does not
  mark the release unavailable. A bare Python traceback is not transport
  evidence: "not available for stream" with only a traceback is permanent and
  falls through to the next provider. Not-found, auth, region, and quality
  failures stay permanent. `max_connections` in the generated toml only limits
  file transfers.

## What Robert sees

Every page shows a banner while any provider is `needs_reauth`: "Deezer
opnieuw koppelen" or "Tidal opnieuw inloggen", the number of held albums, and
a link straight to that field (`#deezer-arl` or the Tidal connect button).
The banner is `role="alert"`, large text, and an icon plus the words "Actie
nodig". One toast fires per transition. `GET /health` includes `providerAuth`
and stays `status: "ok"`.

## Cost

No extra write on a quiet tick. Scheduling reads `needs_reauth` once. The
Deezer probe adds one indexed `SELECT 1` for an unclaimed Deezer row, and a
network call only when that probe is due. `/health` and the diagnostics
snapshot read the table; they do not call the providers.
