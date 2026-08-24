# Lidarr file/folder structure alignment

> Historical. AGENTS.md already calls this a folder-mapping snapshot, not the
> live architecture. Artist identity, monitoring, and libraries are in
> [SCHEMA_41_AUTHORITY_CUTOVER.md](SCHEMA_41_AUTHORITY_CUTOVER.md) and
> [DATA_MODEL_TARGET.md](DATA_MODEL_TARGET.md). Remaining monoliths below are
> still large files; they are not a project to split for its own sake.

Discogenius borrowed Lidarr's control plane (commands, media files, naming).
It did not borrow Lidarr's one-library artist row. This page only tracks how
folders map.

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
| `Indexers` + `Download/Clients` + `ThingiProvider` | `services/providers/` today (adapters; a later move to `api/src/providers/<id>/` is still open — see `docs/TASKS.md` / plugin contract) |

## Command Queue Layout

Command queue code is split by responsibility:

- `command-names.ts` — command identity: `CommandNames`, the `*_COMMAND_NAMES`
  groupings, type guards. (≈ Lidarr command type identity.)
- `command-model.ts` — `CommandStatus` + the name→body `CommandBodyMap` +
  `CommandModel`. (≈ Lidarr `CommandStatus.cs` / `CommandModel.cs`.)
- `command-ordering.ts` — SQL `ORDER BY` builders, priority comparators
  (`compareJobsBy...`), payload parsing + row hydration. (≈ Lidarr
  `CommandPriorityComparer` / `CommandQueue` ordering.)
- `command-queue-manager.ts` — queue persistence/state transitions. (≈ Lidarr
  `CommandQueueManager`.)
- `command-bodies.ts` (pre-existing) holds the per-command body interfaces
  (≈ Lidarr's individual `*Command.cs`). `command-trigger.ts`,
  `command-registry.ts`, `command-executor.ts`, `command.ts` were already split.

## Remaining monolith candidates (deferred)

These are large and Lidarr splits the equivalent concern, but they sit on the
data-sensitive import/tagging/scan/DB paths. Splitting them blindly risks the
reliability that is the whole point, so they should be split incrementally and
validated with Docker plus real provider auth/files when host tooling is not
enough.

| File | Lines | Lidarr decomposition to mirror |
|---|---|---|
| `mediafiles/organizer.ts` | ~3450 | `Organizer/FileNameBuilder` + `MediaFiles/*MovingService` + `MediaFiles/UpgradeMediaFileService` |
| `mediafiles/library-files.ts` | ~2560 | `MediaFiles/MediaFileService` + `MediaFiles/MediaFileRepository` |
| `mediafiles/audio-tag-service.ts` | ~2560 | `MediaFiles/AudioTag` + tag read/write split |
| `commands/command-history.ts` | ~1150 | `History/EntityHistory` + `EntityHistoryRepository` + `EntityHistoryService` |
| `providers/tidal/tidal.ts` | ~1910 | n/a (provider client; no direct Lidarr analogue) |

`database.ts` was previously listed here at ~1690 lines; it is now ~890 (schema
extracted into `database/schema/`), so it is no longer a split candidate.

**Intentional divergence:** the service folder and v1 route use `mediafiles`/
`/api/v1/mediaFile` (not Lidarr's `TrackFile`) because Discogenius manages video +
extras, not just audio. Keep that naming. Note the *database table* stays
`TrackFiles` for Lidarr parity (see `docs/DATA_MODEL_TARGET.md`); the folder/route
naming and the table naming are deliberately different and neither should be
"corrected" to match the other.
