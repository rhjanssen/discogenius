# Discogenius codebase review, 5 September 2026

The architecture is worth keeping, but the download/import boundary has correctness problems that deserve attention before UI polish. The recent changes contain useful improvements and two incomplete reliability fixes. Passing CI currently gives more confidence in individual services than in the assembled runtime.

## Scope and validation

- Reviewed checkout `da647131`, version 2.16.3, including the 55 files changed since 2.14.3. Compared relevant workflows and UI code with `.ref_lidarr`, `.ref_fluentui`, and `.ref_tiddl`.
- The running container reports **2.16.2**, with active schema 46. Its stored download history was inspected through a read-only SQLite connection inside the container. The host database was not opened.
- Ran full `yarn ci`: lint, typechecks, **1,786 API tests**, **175 frontend tests**, and both production builds passed. Exit code 0. Vite reported its existing large-chunk warning.
- Examined the current frontend build through a temporary local preview using the running API. Mutating API requests were blocked in that preview. Checked library navigation, Bastille, Bad Blood, edition controls, rename preview, and naming help at desktop and 390 × 844 dimensions. Naming preview POSTs were also blocked, so preview text behavior was checked separately with the actual naming renderer.
- Ran isolated diagnostics against the active schema and compiled code. Probed one affected real audio file with the container's ffprobe. No fresh downloads, live retagging, file moves, or settings changes were performed.

This is a targeted review of the main workflows and recent changes, not a claim that every provider or feature has been tested end to end.

## Findings in repair order

### 1. [P1] Stereo imports can be routed into the spatial library

**Confirmed in saved production history and still present in current code.**

Command **1137**, Bastille's **Bad Blood**, explicitly requested library 1 and slot `stereo`. Its import produced 33 TrackFiles rows under `/library/spatial-music`, assigned to library 2, with two-channel FLAC technical facts. Import then failed with:

> [ImportDownload] Reported TrackFiles row 925 belongs to library 2, not 1

File 925 still exists. ffprobe confirmed FLAC, 44.1 kHz, two channels. This is an actual misplaced stereo file, not just a misleading status badge. The other 32 rows were checked in the database, not individually probed.

The organizer tries to recover an album context by joining a provider edition to accepted canonical matches. When that lookup returns nothing, it selects the destination from the provider album's available quality. The lookup does return nothing for this job. The Apple album advertises both lossless and Atmos, and the fallback query prefers spatial capability. That choice overrides the explicit stereo request.

Source capability must never decide the destination of a job that already names its library. Resolve and validate the requested library, canonical edition, and probed media before moving anything. A missing provider-edition match must not turn stereo into spatial.

Evidence: [context lookup](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/mediafiles/organizer.ts:486), [destination fallback](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/mediafiles/organizer.ts:1957), [late library check](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/mediafiles/downloaded-tracks-import-service.ts:658).

This defect predates the latest releases. Repairing existing affected files should be a separate, reviewable operation using exact TrackFiles IDs and verified destination conflicts.

### 2. [P1] Provider fallback breaks the identity handed to import

**Confirmed in the same production job; independently incorrect in current code.**

All 33 final track offers in command 1137 are TIDAL offers, but its import handoff still says `provider: apple-music`. File 925 is consequently stamped `apple-music:track:131971386`. The only ProviderItems track with that ID is a TIDAL track.

The download loop replaces individual offers and persists the changed list. The organizer subsequently combines each replacement track ID with the original command's provider. Updating provenance after organization is too late because the wrong identity and destination have already been used.

The loop also allows individual tracks to fall back across providers. That permits a mixed-provider album even though the project explicitly requires every acquisition plan to use one provider. The observed job happened to end entirely on TIDAL; it demonstrates stale handoff identity, not a mixed final offer list.

Keep fallback within the selected provider, or replace/replan the whole acquisition using one other provider. Validate the complete execution manifest before downloading and importing. Carry ProviderItems IDs and the chosen canonical occurrences through every step.

Evidence: [per-track fallback ranking](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/download/download-processor.ts:2564), [persisted replacement offers](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/download/download-processor.ts:2506), [original provider stamped onto the track](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/mediafiles/organizer.ts:2233).

### 3. [P1] Recent recovery changes leave hangs unbounded

**Confirmed wiring regression in 2.15.0; no active hang was induced in production.**

The download proxy no longer starts its watchdog. The command executor no longer calls its periodic stale-command recovery routine. Restart and worker-exit recovery still exist, but neither handles a worker that remains alive while its operation never finishes.

The new ten-minute import timeout does not cover normal production imports. The main server starts CommandWorkerPool, but the separate download thread has its own unstarted instance of that class. Its `isActive()` is false, so imports take the inline branch inside the download thread and bypass the timeout. An isolated startup probe of the actual download-worker entry point confirmed this.

There is a second problem in the pool branch: `Promise.race` rejects the caller without cancelling or joining the underlying import. An active-schema diagnostic confirmed that a command marked `failed` by timeout does **not** make `isImportDownloadCancellationRequested()` return true. If that branch is used, an import can continue after the caller reports failure and releases its logical slot.

Restore bounded liveness checks using progress and ownership, with asynchronous database access where needed. Put the timeout at the execution boundary that production actually uses. Cancellation must retire the owned attempt and reach a safe stopping boundary before capacity is reused. A blanket wall-clock cutoff should not kill a healthy large import.

Evidence: [disabled download watchdog](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/download/download-processor.ts:2983), [executor loop](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/commands/command-executor.ts:201), [timeout and inline branches](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/download/download-processor.ts:891), [thread-local pool state](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/commands/worker/command-worker-pool.ts:117), [cancellation predicate](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/mediafiles/downloaded-tracks-import-service.ts:256).

Lidarr's three command threads are a useful scheduling reference. Its architecture does not justify disabling Discogenius-specific supervision of downloader subprocesses and worker threads.

### 4. [P2] New naming tokens promise behavior the runtime does not supply

**Confirmed in 2.16.2 changes.**

- `{MediaInfo AudioBitRate}` appends `kbps` to a value measured in bits per second. The actual renderer turns `320000` into **`320000 kbps`**.
- `{Original Filename}`, `{Original Title}`, `{Medium Name}`, and `{Medium Format}` exist in the token resolver and sample context, but the normal import and rename contexts do not populate them. A sample can show a filename and `CD` while the real operation renders empty values.
- `{Quality Full}`, `{Quality Title}`, and `{Quality Proper}` all return the same quality string. With `LOSSLESS`, all three produce `LOSSLESS`, despite the help examples showing `FLAC Proper`, `FLAC`, and `Proper`.
- The changelog claims MediaInfo Simple/Full support and “1:1 parity”; those tokens are absent from the resolver. “Proper” and scene release-group semantics also need a Discogenius use case before being copied from Lidarr.

Generate help examples through the same supported token definitions and context builders used by actual file operations. Fill fields from persisted facts or remove unsupported choices. Add a preview-to-real-rename check on an active-schema fixture.

Evidence: [bitrate and quality rendering](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/config/naming.ts:553), [rename context](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/mediafiles/library-files.ts:1541), [import context](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/mediafiles/organizer.ts:2264), [help examples](C:/Users/Robert/Documents/Projects/discogenius/app/src/pages/settings/NamingSettingsSection.tsx:147).

### 5. [P2] Import progress can update the wrong track

**Introduced in the recent import-progress change.**

The new matching expression accepts provider ID **or** disc/track position **or** title. A title match is allowed even when an exact ID was supplied and disagrees. Two tracks called “Intro” on different discs can therefore both appear completed after only one finishes. Missing disc numbers also permit position collisions.

Use exact occurrence/provider identity first. Use position or title only when stronger identity is absent and the fallback is unambiguous. Preserve error and skipped states instead of mapping every non-completed update to downloading.

Evidence: [import progress matching](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/download/download-processor.ts:812). This is a display defect; this expression does not itself select the imported file.

### 6. [P2] The test suite misses runtime assembly and still mixes schemas

CI is green, but the watchdog test calls `runWatchdogOnce()` directly. It continues to pass when startup stops scheduling that method. The import-timeout branch similarly lacked coverage of the real download-thread entry point.

Several production repository/planning suites still create `domain-baseline`, including acquisition planning and composite-plan regression tests. Those fixtures cannot prove compatibility with the active production schema. Keep aspirational schema tests, but move production-service tests to the active fixture.

The most valuable added coverage is a narrow end-to-end contract test: mono-provider plan, fallback, actual execution context, organized file, exact TrackFiles identity, correct library, and restart/retry. Include a stereo request whose provider album also has Atmos capability.

Evidence: [direct watchdog invocation](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/download/download-processor-liveness.test.ts:227), [planning fixture](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/music/acquisition-planning-service.test.ts:134), [composite fixture](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/music/composite-plan-regression.test.ts:96).

## What explains slow downloads?

The saved Bad Blood job provides a useful separation:

| Stage | Stored UTC timestamp / elapsed time |
| --- | --- |
| Execution started | 4 September, 21:56:05.533 |
| Import execution handoff | 22:07:06.956 |
| Time before import execution | About 11 minutes 1 second |
| Import failed | 22:07:30 |
| Import duration | About 23 seconds |

Most of that job's elapsed time was before import. The history does not separate provider transfer, preparation, failed attempts, backoff, and time waiting for import execution. It cannot establish a CDN bandwidth bottleneck or assign a percentage of the delay to code.

The current code nevertheless has concrete overhead:

- Downloads are capped at two globally and one per provider. Raising the global limit alone will not increase TIDAL concurrency.
- Planned albums await each track sequentially and launch a fresh downloader for each track. tiddl's configured four concurrent tasks cannot batch different tracks when each process receives only one track.
- Each track repeats provider preparation. TIDAL credentials and settings are synchronized in both the processor and backend.
- The default transient-error policy makes three attempts with two- and four-second backoffs. Repeated failures on the original provider can make a fallback album slow even when the replacement provider transfers quickly. The original job lacks enough attempt-level history to quantify this.

Prefer bounded batches of the exact selected offers, a provider-level preparation cache, and recorded per-attempt timings. Keep canonical edition membership intact; do not optimize by downloading an arbitrary whole provider album.

Sources: [provider concurrency](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/download/download-processor.ts:1658), [sequential tracks](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/download/download-processor.ts:2554), [preparation](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/download/download-processor.ts:2151), [subprocess launch](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/providers/tidal/tiddl-backend.ts:265), [retry policy](C:/Users/Robert/Documents/Projects/discogenius/api/src/services/download/download-failure-policy.ts:4).

Today's limited HTTP probe did **not** reproduce the earlier API stall. Four concurrent monitored-track requests completed in 45–229 ms; a status request during that burst took 16 ms and a subsequent status request took 4 ms. One 200-track response was about 849 KB. Smaller list responses remain worth pursuing, but this sample does not justify a language rewrite or prove behavior during heavy refresh/import writes.

## Verification of the attached UI analysis

| Claim or recommendation | Assessment |
| --- | --- |
| Shared semantic dialog sizes | Agree. Current dialogs use inconsistent widths and breakpoints. Lidarr's five quoted desktop widths match its source; a smaller shared set can suit Discogenius. These are application layout constants, not Fluent spacing tokens. |
| Standard scrolling body and persistent actions | Agree with the design goal. The 2.16.3 naming dialog already retains the footer and avoids horizontal content overflow at the tested desktop and phone sizes. A proposal must account for that existing fix. |
| Rename/retag Select All disappears when the file list scrolls | Overstated. The toolbar is a sibling of the independently scrolling list. Short screens can still introduce outer scrolling, but the normal list scroll does not move the toolbar. A shared footer is a consistency improvement, not the claimed universal bug fix. |
| `Field orientation="horizontal"` is automatically responsive | Incorrect. Fluent defines a `33% 1fr` grid with no automatic mobile orientation switch. Supply an explicit responsive rule. Use `hint` for supporting text and verify label association when composing controls. |
| `borderRadiusLarge = 8px`, `borderRadiusXLarge = 12px` | Incorrect in both the reference and installed theme. They are 6px and 8px; `borderRadius2XLarge` is 12px. The quoted spacing values are correct. |
| Exact DialogBody grid-area snippet is Fluent's universal layout | Too strong. The implementation positions child slots by grid coordinates and has responsive rules. Preserve those contracts rather than assuming a copied grid-area declaration reproduces them. |
| Lidarr has a destination-folder banner above rename rows | The inspected component has a naming-pattern banner. It does not contain the quoted destination-folder banner. Showing the destination remains a sensible addition. |
| Settings are universally a 35/65 split below 768px | Not supported by the reference inspected. Lidarr uses shared form-width variables and its large breakpoint. Define Discogenius's form layout deliberately with Fluent fields. |

Reference files: [Fluent Field](C:/Users/Robert/Documents/Projects/discogenius/.ref_fluentui/packages/react-components/react-field/library/src/components/Field/useFieldStyles.styles.ts:29), [radius values](C:/Users/Robert/Documents/Projects/discogenius/.ref_fluentui/packages/tokens/src/global/borderRadius.ts:3), [dialog body](C:/Users/Robert/Documents/Projects/discogenius/.ref_fluentui/packages/react-components/react-dialog/library/src/components/DialogBody/useDialogBodyStyles.styles.ts:20), [Lidarr modal sizes](C:/Users/Robert/Documents/Projects/discogenius/.ref_lidarr/frontend/src/Components/Modal/Modal.css:46), [Lidarr rename preview](C:/Users/Robert/Documents/Projects/discogenius/.ref_lidarr/frontend/src/Organize/OrganizePreviewModalContent.js:116).

Two UI issues matter more than matching pixel values:

- On Bad Blood, Rename/Tags operate on the selected edition while Download covers both monitored editions. The accessible label already says “Download all 2 monitored editions,” but the visible button just says “Download.” Make that scope visible, alongside the target library and edition in file previews.
- “Fingerprint unidentified files” still promises fingerprinting during retagging. Normal retagging now deliberately excludes online identification and never calls the old enrichment method. The setting's explanation must point to a real identification workflow, or the control should be removed from that context.

The saved single-volume naming template also contains `{Album Year}` three times after `{Track Title}`. The running preview shows `Pompeii201320132013.flac`. This is a separate configuration observation, not proof of a code defect or of who changed the setting. It was left unchanged.

## Architecture assessment and next steps

Keep TypeScript, Express, React, Fluent UI, and SQLite. The project has useful service boundaries, canonical/provider separation in much of the model, durable commands, indexed reads, worker isolation, and a substantial passing test suite. Normal audio retagging now uses persisted data and local assets. These are meaningful improvements.

The weakest boundaries are where download plans become execution requests and where those requests become files. The organizer and download processor each contain thousands of lines and repeat identity decisions across phases. A typed, validated execution manifest would prevent more defects than a broad folder reshuffle. Remove dead enrichment code and stale comments after the behavior is covered.

The new interactive priority improves pending-job ordering; it does not interrupt an already running refresh. Long artist pipelines and disk-operation exclusion can still delay a user action. If this remains noticeable, measure wait time and introduce safe phase boundaries or reserved interactive capacity. Do not describe the priority change as eliminating starvation without that validation.

Recommended implementation sequence:

1. Fix library/slot authority and provider identity together, with an active-schema reproduction of job 1137. Prepare a separate exact-file repair preview for its 33 affected rows.
2. Correct the real worker/import execution boundary, restore bounded recovery, and test startup wiring plus safe cancellation and restart.
3. Add phase/attempt measurements, then benchmark bounded same-provider batches against sequential downloads using Bastille or Bakermat.
4. Fix naming token semantics, real context population, and progress identity; make help examples derive from supported behavior.
5. Introduce shared Fluent dialog/form patterns and visible operation scope, then finish the production-fixture migration.

Application source and runtime settings were not changed during this review. This report is the only repository addition.

