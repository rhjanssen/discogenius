# Deployed Container Operations

Use this skill when inspecting, debugging, or validating a **running Discogenius
container** (the operator's box or a test host such as
`192.168.1.50:3737` / `discogenius.spikkelpoot.com`) — reading logs, checking
health, poking the database safely, or exercising the Apple Music wrapper
sidecar and native tools.

## Golden rules

1. **Never write to the host SQLite DB while the container is running.** The API
   uses synchronous `better-sqlite3` on the single event loop and owns the
   connection. For ad-hoc reads, open it **read-only** from *inside* the
   container:
   ```bash
   docker exec discogenius sh -c 'node -e "const db=require(\"better-sqlite3\")(\"/config/discogenius.db\",{readonly:true,fileMustExist:true}); console.log(db.prepare(\"select count(*) c from Artists\").get())"'
   ```
   Never copy the live DB file out mid-write, and never point a second writer at it.
2. **Read state, don't mutate it.** Prefer the HTTP API and logs over editing
   files under `/config`. Mutations belong in the app (queue commands, Settings),
   not in shell pokes.
3. **Verify behavioural claims against the running container** before trusting
   them (Robert's standing rule). "It should work" is not "it works."

## Health & status (no auth required)

- `GET /api/health` — startup/preflight/runtime snapshot: writable paths, ffmpeg
  + tiddl presence, backend readiness, event-loop lag, slow requests. First stop
  for "is it up and sane?".
- Poll a provider's downloader-login handshake:
  `GET /api/auth/<providerId>/downloader-login/status`.
- Most `/api/*` business routes sit behind `authMiddleware` when `ADMIN_PASSWORD`
  is set; `/api/health` and `/api/auth/**` status endpoints are reachable without it.

## Logs

```bash
docker logs --tail 100 discogenius
docker logs --tail 100 apple-music-wrapper
```
The wrapper supervisor prints `[wrapper-manager] …` / `[wrapper-boot] …`. The API
prints `[AUTH]`, `[APPLE-MUSIC-AUTH]`, `[APP]` prefixes.

## Native tools (ffmpeg / fpcalc)

Do **not** claim these are untestable on Windows. The Dockerfile bundles
`ffmpeg` + `libchromaprint-tools` (fpcalc). Test in the container:
```bash
docker exec discogenius sh -c 'ffmpeg -version | head -1; fpcalc -version'
```
Or on the host with `winget install`. `/api/health` also reports ffmpeg/tiddl
resolution.

## Apple Music decryption wrapper sidecar

The wrapper shares the Discogenius network namespace (`network_mode:
service:discogenius`) so the downloader reaches `127.0.0.1:10020/20020`.
Discogenius provisions the supervisor script into the shared data volume
(`config/providers/apple-music/wrapper-rootfs/data/wrapper-entrypoint.sh`); the
sidecar's compose entrypoint is a wait-for-script bootstrap, so a fresh deploy
self-heals — never bind-mount that script as a file (Docker turns a missing file
mount into an empty directory and strands the sidecar).

- If you recreate the `discogenius` container, **also recreate the wrapper** or
  it stays attached to a dead network namespace:
  `docker compose up -d --force-recreate discogenius apple-music-wrapper`.
- Login stuck at "Login request sent to the decryption wrapper…" ⇒ the
  supervisor never consumed the trigger; check `docker logs apple-music-wrapper`
  and that `wrapper-entrypoint.sh` under the data dir is a **file**, not a
  directory.

## Deploying / updating

- Published image (operator): `docker compose pull && docker compose up -d`
  against `docker-compose.example.yml`. Prefer a pinned tag over `latest` on
  hosts that cache aggressively.
- Local build validation: `docker compose up -d --build` against
  `docker-compose.yml`. Do this whenever runtime packaging, the Dockerfile,
  compose, native tools, or tiddl behaviour changed.
- **Schema note:** image upgrades that bump the SQLite schema currently need a
  fresh `/config` database (library files on disk can stay). Soak-test before
  upgrading a real library.

## Smoke test after a deploy

1. `GET /api/health` → `status: healthy`, backends ready.
2. Auth page lists providers; the intended provider shows connected/available.
3. Exercise one real path with the preferred test artists **Bastille** and
   **Bakermat** (a refresh, one download, one library view) — real data over mocks.
4. Report what you actually observed (log lines, HTTP responses), not what you
   expect.

## Reference conventions

- **Jellyfin** (`.ref_jellyfin`) treats media-server operations as read-mostly
  against an owned DB with health/diagnostics endpoints — mirror that: inspect
  via API/health, never a second writer.
- **Lidarr** (`.ref_lidarr`) exposes long-running work as *commands* with status,
  not synchronous mutations; when you need the container to *do* something, prefer
  enqueuing the command over a shell poke.
