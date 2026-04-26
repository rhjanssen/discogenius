# Lidarr Redundancy Sidecar Plan

> Status: deferred future integration. Discogenius remains standalone-first.
>
> This document is retained because a Lidarr companion may still be useful later,
> but it is not the current Discogenius product direction and should not drive
> the core architecture.

## Goal

Build a small hostable service that connects to the Lidarr API, analyzes an artist's MusicBrainz-backed catalog, and automatically unmonitors redundant releases.

The first target is simple and conservative:

- If a single is fully covered by a monitored album, unmonitor the single.
- If a single contains a unique B-side, remix, live recording, acoustic version, radio edit, or missing/ambiguous metadata, keep it monitored.
- Never delete files in the first implementation. Only adjust monitored state.

This should let Lidarr remain the source of truth for metadata, wanted/missing state, importing, renaming, quality profiles, and history, while the sidecar adds the curation behavior Lidarr does not currently provide.

## Why A Sidecar First

Discogenius has grown into a broad replacement for Lidarr. That is expensive because Lidarr already solves most music-library automation problems.

A sidecar is smaller and safer:

- It can work with a stock Lidarr instance.
- It does not require forking Lidarr immediately.
- It can run as a Docker container on a schedule.
- It can start in dry-run mode and produce audit reports.
- It can later become a Lidarr fork feature if the behavior proves stable.

## Why Not Kometa

Kometa is probably not the right primary integration point. It is mainly a media-library metadata/collection automation tool for Plex-style libraries. The action we need is upstream of Plex/Jellyfin/Navidrome: deciding what Lidarr should monitor before it searches and downloads.

Kometa could be useful later for reporting or library presentation, but the redundancy decision belongs closer to Lidarr because Lidarr owns:

- monitored album state,
- wanted/missing searches,
- MusicBrainz release groups and releases,
- download decisions,
- import state.

## High-Level Architecture

```text
+-------------+
|  Scheduler  |  cron / interval / manual run
+------+------+
       |
       v
+--------------------------+
| Redundancy Sidecar       |
|                          |
| - Lidarr API client      |
| - MusicBrainz helpers    |
| - Coverage engine        |
| - Decision reporter      |
| - Apply/dry-run executor |
+------+-------------------+
       |
       v
+-------------+
|   Lidarr    |
| /api/v1/... |
+-------------+
```

The sidecar should not download anything. It should only read Lidarr metadata and update monitored state when configured to do so.

## Required Lidarr API Usage

Use Lidarr's API key via `X-Api-Key` or `apikey`.

Likely endpoints:

- `GET /api/v1/artist`
  Fetch monitored artists and IDs.

- `GET /api/v1/album?artistId={id}`
  Fetch each artist's albums/release groups. Album resources include `id`, `foreignAlbumId`, `title`, `albumType`, `secondaryTypes`, `releaseDate`, `monitored`, `releases`, and the selected release's `media`.

- `GET /api/v1/track?albumId={id}`
  Fetch tracks for an album. Track resources include `foreignRecordingId`, `foreignTrackId`, `title`, `duration`, `trackFileId`, and `hasFile`.

- `PUT /api/v1/album/monitor`
  Apply monitored state changes with `{ "albumIds": [1, 2, 3], "monitored": false }`.

Optional later:

- `GET /api/v1/history`
  Avoid changing recently grabbed/imported releases.

- `GET /api/v1/queue`
  Avoid unmonitoring something currently queued.

- `POST /api/v1/command`
  Trigger searches after pruning, if desired. This should not be in v1.

## Data Model Inside The Sidecar

The sidecar can keep a small SQLite database for auditability and incremental runs.

Suggested tables:

- `runs`
  `id`, `started_at`, `finished_at`, `mode`, `status`, `summary_json`

- `album_snapshots`
  `run_id`, `lidarr_album_id`, `artist_id`, `foreign_album_id`, `title`, `album_type`, `secondary_types_json`, `release_date`, `monitored`, `has_files`

- `track_snapshots`
  `run_id`, `lidarr_track_id`, `lidarr_album_id`, `foreign_recording_id`, `foreign_track_id`, `title`, `duration_ms`, `has_file`

- `decisions`
  `run_id`, `lidarr_album_id`, `decision`, `confidence`, `reason`, `covered_by_album_ids_json`, `unique_tracks_json`, `applied_at`

The service can run without persistent storage at first, but a local SQLite DB is useful for explaining what changed and why.

## Curation Rules

### Release Roles

Classify every album/release group for an artist into one of these roles:

- `carrier`
  Main albums that can cover tracks from singles. Usually `albumType = Album`.

- `candidate_redundant`
  Releases that might be unmonitored if fully covered. Usually singles, promo singles, and maybe EPs depending on settings.

- `protected`
  Releases never automatically unmonitored. Examples: live albums, compilations, soundtracks, remix albums, user-pinned releases, releases with files, or unknown metadata.

These should be configurable. Do not hard-code all music taste into the first version.

### Coverage Matching

Coverage should be computed in tiers:

1. **MusicBrainz recording ID exact match**
   If every meaningful track on a single has a `foreignRecordingId` that appears on a monitored carrier album, the single is redundant.

2. **Strict normalized title + duration fallback**
   Only use this when recording IDs are missing. Normalize punctuation, casing, bracket noise, and common suffixes carefully, but require a close duration match.

3. **No confident match**
   Keep monitored.

The rule should be biased toward keeping releases monitored. False positives are worse than false negatives because a false positive can cause Lidarr not to search for something the user actually wanted.

### Unique Track Detection

Keep the release monitored if it has any track that appears unique, including:

- no matching recording ID on carrier albums,
- title indicates `live`, `demo`, `remix`, `edit`, `radio edit`, `single version`, `instrumental`, `acoustic`, `remaster`, etc.,
- duration differs materially from the album version,
- track is explicit/clean variant where the carrier is the opposite variant,
- MusicBrainz IDs are missing or contradictory.

### Files Policy

Default should be:

- Never unmonitor a release that already has files.

Later optional modes:

- `unmonitor_with_files`
  Unmonitor redundant releases even if downloaded, but keep files.

- `delete_redundant_files`
  Dangerous. Should require explicit opt-in, dry-run preview, and probably a minimum age since import.

## Example Decision

```json
{
  "artist": "Example Artist",
  "album": "Song Title - Single",
  "decision": "unmonitor",
  "confidence": "high",
  "reason": "All 1/1 MusicBrainz recording IDs are covered by monitored album Example Album.",
  "coveredBy": ["Example Album"]
}
```

```json
{
  "artist": "Example Artist",
  "album": "Song Title - Single",
  "decision": "keep",
  "confidence": "high",
  "reason": "Track 2 has no matching recording on monitored carrier albums.",
  "uniqueTracks": ["Song Title - Acoustic"]
}
```

## Runtime Modes

### `dry-run`

Default mode. Fetch Lidarr state, compute decisions, write a report, but do not call `PUT /album/monitor`.

### `apply`

Apply high-confidence unmonitor decisions.

### `report-only`

Expose current decisions over HTTP and optionally write JSON/Markdown reports for review.

## Docker Design

Package as a small Node.js or Python service. TypeScript is a natural fit because Discogenius already has MusicBrainz and normalization code that could be extracted.

Environment variables:

```env
LIDARR_URL=http://lidarr:8686
LIDARR_API_KEY=...
RUN_MODE=dry-run
SCHEDULE=0 4 * * *
TZ=Europe/Amsterdam
DATABASE_PATH=/config/redundancy.db
REPORT_DIR=/config/reports
MIN_CONFIDENCE_TO_APPLY=high
PROTECT_RELEASES_WITH_FILES=true
PROTECT_RECENTLY_IMPORTED_DAYS=14
CARRIER_TYPES=Album
CANDIDATE_TYPES=Single
INCLUDE_EPS=false
```

Example compose service:

```yaml
services:
  lidarr-redundancy:
    image: local/lidarr-redundancy:latest
    container_name: lidarr-redundancy
    environment:
      LIDARR_URL: http://lidarr:8686
      LIDARR_API_KEY: ${LIDARR_API_KEY}
      RUN_MODE: dry-run
      SCHEDULE: "0 4 * * *"
      TZ: Europe/Amsterdam
    volumes:
      - ./config/lidarr-redundancy:/config
    restart: unless-stopped
```

Useful commands inside the container:

```bash
lidarr-redundancy run --dry-run
lidarr-redundancy run --apply
lidarr-redundancy report --latest
lidarr-redundancy explain --album-id 123
```

## HTTP UI / API

The first version does not need a full UI. A minimal HTTP surface is enough:

- `GET /health`
- `POST /run?mode=dry-run`
- `POST /run?mode=apply`
- `GET /runs`
- `GET /runs/{id}`
- `GET /runs/{id}/decisions`
- `GET /albums/{lidarrAlbumId}/explain`

This can later become a simple web page showing:

- redundant candidates,
- protected releases,
- confidence,
- reasons,
- apply/revert actions.

## Safety Controls

Required before any automatic apply:

- Dry-run is the default.
- Apply only high-confidence decisions.
- Never delete files in v1.
- Never unmonitor releases currently queued.
- Never unmonitor releases imported in the last N days.
- Never unmonitor if MusicBrainz recording coverage is incomplete unless strict fallback matching is enabled.
- Keep a durable decision log.
- Support a rollback report listing all albums changed in the last run.

Potential rollback action:

```text
For every decision applied in run N, call PUT /api/v1/album/monitor with monitored=true for those album IDs.
```

## Implementation Phases

### Phase 1: Offline Analyzer

- Build a CLI that reads Lidarr API data.
- Classify releases as carrier/candidate/protected.
- Match by `foreignRecordingId`.
- Output JSON and Markdown dry-run reports.
- No writes to Lidarr.

Exit criteria:

- Can run against a real Lidarr instance.
- Produces understandable reasons.
- Has fixtures for common cases: album-covered single, single with B-side, missing MBIDs, remix single.

### Phase 2: Safe Apply

- Add `PUT /api/v1/album/monitor`.
- Apply only high-confidence single-covered-by-album decisions.
- Store decisions in SQLite.
- Add rollback command.

Exit criteria:

- Dry-run and apply reports match.
- Rollback restores previous monitored state.
- No file deletion.

### Phase 3: Scheduler Container

- Add cron/interval runner.
- Add Dockerfile and compose example.
- Add health endpoint.
- Add report retention.

Exit criteria:

- Runs unattended on a schedule.
- Can be observed via logs and `/health`.
- Defaults remain non-destructive.

### Phase 4: Better Matching

- Add strict title/duration fallback.
- Add MusicBrainz API refresh for missing recording IDs if Lidarr data is incomplete.
- Add profile settings per artist or release type.
- Add queue/history protection.

Exit criteria:

- Still conservative.
- Every fallback decision explains why it was safe enough.

### Phase 5: Optional Lidarr Fork Or Plugin Work

Only consider this after the sidecar proves the behavior.

Possible directions:

- Patch Lidarr's monitoring logic directly.
- Add a custom monitor type such as `RedundancyFiltered`.
- Add UI controls to Lidarr's artist/album pages.
- Add a decision-engine specification so redundant releases are rejected during search instead of unmonitored.

This is more invasive and creates long-term maintenance work, so it should not be the first implementation.

## Open Questions

- Should EPs be candidates for pruning, or should v1 only touch singles?
- Should a single with exactly the same recording but different title, e.g. radio branding, be pruned?
- Should already-downloaded redundant singles be left monitored, unmonitored, or eventually deleted?
- Should clean/explicit variants be considered duplicates or separate desired releases?
- Should compilation albums ever act as carriers?
- Should deluxe editions act as carriers for standard editions, or should the user's preferred edition profile decide that?

## Recommendation

Build this as a standalone Dockerized Lidarr sidecar first. Keep Discogenius out of the critical path.

The first useful version should be a dry-run analyzer that only answers:

> Which monitored singles can be safely unmonitored because their MusicBrainz recordings are already covered by monitored albums?

Once that report looks trustworthy on a real library, add safe apply mode.
