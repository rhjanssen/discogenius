# Lidarr File/Folder Structure Alignment

Discogenius mirrors Lidarr's architecture; this tracks how our file/folder layout
maps to Lidarr's, what we've split to match, and the remaining monoliths.

## Folder mapping (already aligned)

| Lidarr (`NzbDrone.Core/`) | Discogenius (`api/src/`) |
|---|---|
| `Messaging/Commands` + `Jobs` | `services/commands/` (queue, executor, scheduler, worker pool) |
| `MediaFiles` + `Organizer` | `services/mediafiles/` |
| `DecisionEngine` | `services/import-decision/` |
| `MetadataSource` | `services/metadata/` + `services/catalog/` |
| `Music` (Artist/Album/Track) | `services/music/` |
| `Download` | `services/download/` |
| `History` | `services/commands/command-history.ts` |
| `Configuration` / `Profiles` / `Qualities` | `services/config/` |
| `Datastore` | `database.ts` + `repositories/` |
| `Extras` | `services/extras/` |

## Split to match Lidarr (done 2026-06-22)

`command-queue.ts` (1160 lines) bundled what Lidarr keeps in separate files. Split,
preserving the public API via barrel re-exports from `command-queue.ts` (so no
import sites changed):

- `command-names.ts` — command identity: `CommandNames`, the `*_COMMAND_NAMES`
  groupings, type guards. (≈ Lidarr command type identity.)
- `command-model.ts` — `CommandStatus` + the name→body `CommandBodyMap` +
  `CommandModel`. (≈ Lidarr `CommandStatus.cs` / `CommandModel.cs`.)
- `command-ordering.ts` — SQL `ORDER BY` builders, priority comparators
  (`compareJobsBy...`), payload parsing + row hydration. (≈ Lidarr
  `CommandPriorityComparer` / `CommandQueue` ordering.)
- `command-bodies.ts` (pre-existing) holds the per-command body interfaces
  (≈ Lidarr's individual `*Command.cs`). `command-trigger.ts`,
  `command-registry.ts`, `command-executor.ts`, `command.ts` were already split.

## Remaining monolith candidates (deferred)

These are large and Lidarr splits the equivalent concern, but they sit on the
data-sensitive import/tagging/scan/DB paths that can't be runtime-validated on the
Windows dev host (need Docker + real provider auth + files). Splitting them blindly
risks the reliability that is the whole point, so they should be split
incrementally with real-data validation, not in one mechanical pass:

| File | Lines | Lidarr decomposition to mirror |
|---|---|---|
| `mediafiles/organizer.ts` | ~2540 | `Organizer/FileNameBuilder` + `MediaFiles/*MovingService` + `MediaFiles/UpgradeMediaFileService` |
| `mediafiles/library-files.ts` | ~2350 | `MediaFiles/MediaFileService` + `MediaFiles/MediaFileRepository` |
| `mediafiles/audio-tag-service.ts` | ~2090 | `MediaFiles/AudioTag` + tag read/write split |
| `database.ts` | ~1690 | `Datastore/` — connection vs schema vs per-migration files vs `TableMapping` |
| `commands/command-history.ts` | ~1100 | `History/EntityHistory` + `EntityHistoryRepository` + `EntityHistoryService` |
| `providers/tidal/tidal.ts` | ~1610 | n/a (provider client; no direct Lidarr analogue) |

**Intentional divergence:** Discogenius uses `MediaFile` (not Lidarr's `TrackFile`)
because it manages video + extras, not just audio. Keep `MediaFile`/`mediafiles/`
naming; don't "correct" it to `TrackFile`.
