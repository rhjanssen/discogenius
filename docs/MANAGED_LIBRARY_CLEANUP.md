# Managed library inventory and strict cleanup

## Intended behavior

Robert's October 4 clarification defines three separate policies:

- Remove unmonitored files removes managed releases that are no longer monitored.
- Delete empty folders removes empty directories inside a configured library root.
- Delete untracked files is an optional strict policy. After a successful complete
  inventory, it removes files owned by neither the managed library nor the
  unmapped review inventory, then prunes directories that became empty.

The third policy is not implemented or enabled by the current monitoring toggle.
Do not reinterpret remove_unmonitored_files as strict cleanup.

## Inventory before deletion

1. Enumerate the configured roots, including plain-name/legacy directories,
   files directly in a root, and files in disabled media categories. Category
   preferences must not make existing media invisible to ownership checks.
2. Match supported audio/video using canonical identity and explicit edition
   context. A folder name is a discovery hint, not a track or edition decision.
3. Register unmatched applicable media in UnmappedFiles. A wholly unmatched
   album directory appears as one expandable review group; a remaining track
   in a matched album appears as that individual track. Individual videos stay
   individual items. Grouping must preserve per-file identity and review actions.
4. Associate artist art/NFO with the artist, album art/NFO with the edition or
   album as appropriate, lyrics with the exact track/recording occurrence, and
   video assets with their recording. Preserve sidecars belonging to an unmapped
   media group until those associations can be confirmed. A file must not be
   declared disposable merely because its parent media awaits identification.
5. Only after all required discovery and persistence completes successfully,
   build a deletion plan for remaining unsupported/unowned files. Do not delete
   files in a folder skipped because of a read error or interrupted scan.
6. Before each deletion, recheck current DB ownership and filesystem identity.
   Respect file locks, pending file mutations and media rewrite temporary files.
   Keep the work bounded, journal outcomes, stay within the configured root and
   never follow a symlink into another directory. No root-wide recursive delete.
7. Prune genuinely empty parents without deleting the root, and report actual
   counts plus actionable refused paths. An unchanged repeat scan is a no-op.

The strict setting should default off and have concise explicit help stating
that files absent from both inventories are permanently removed. Supported
unmapped music is protected even when strict cleanup is on. JSON/executable
leftovers are not protected merely by an unmapped folder's path prefix.

## Current bounded fix

Routine artist scans now include an unambiguously identified plain-name sibling
of the configured artist folder. Exact artist-name lookup uses the existing
case-insensitive catalogue index and rejects duplicate names. Explicit unknown
MBIDs never fall back to an artist-name match. Custom configured folder matching
falls back only to artists represented in LibraryArtists, avoiding a full
ArtistMetadata read for every unrelated directory.

Whole-library scans now finish artist reconciliation with a resumable inventory
of all configured roots. Each dispatch checks at most 100 entries or 15 seconds
before yielding. Directory/file cursors survive a command continuation or DB
reopen. Ownership lookups use indexed paths in TrackFiles, MetadataFiles,
LyricFiles and ExtraFiles. Existing review entries, including ignored files, are
preserved and do not need another metadata probe. New unowned media is registered
for review; this stage does not automatically identify unknown artists or albums.

The traversal skips symlinks and reserved system directories. Read failures stop
the command; missing roots are recorded in its checkpoint. Orphan-record pruning
now requires the file's library root to be accessible before treating an absent
file as deleted. This guards unavailable roots, but does not detect an empty
directory left behind by a failed mount; strict deletion still needs a separate
root-availability and inventory-completeness gate.

Native-container validation used real generated FLACs directly in a root and
under an unknown artist/album. The actual RescanFolders handler registered both,
preserved an ignored file and an unsupported JSON file, and added nothing on a
repeat scan. The app displayed both review rows and opened the correct album
directory in Manual Import. Active-schema tests also cover restart recovery,
concurrent import, inaccessible directories, unavailable roots and symlinks.
Full CI passed 1,970 backend and 186 frontend tests before these inventory changes
shipped in 2.21.0. Automatic identification of unknown folders, complete sidecar
ownership and strict cleanup remain release gates.

## Lidarr as a secondary index

The live October 4 API check found renameTracks=false, writeAudioTags=no,
scrubAudioTags=false, deleteEmptyFolders=true, watchLibraryForChanges=true and
rescanAfterRefresh=always. Rename and tag writing are independent settings.
embedCoverArt=true does not mean covers are being rewritten while tag writing
is disabled. Keep the rename/tag settings disabled during reconciliation.

After Discogenius passes its inventory and tag acceptance gates, snapshot Lidarr
configuration/database and run controlled rescans on Bastille and Bakermat.
Compare physical paths, embedded release/track MBIDs, selected editions and
unmapped counts. Determine why existing files remain sticky before requesting
an explicit reassignment; a full rescan is not proof that Lidarr selected the
same editions. Keep both apps connected to the shared files, with Discogenius
owning writes while Lidarr provides the secondary database.

## Acceptance cases before release

- Manually copied recognized album becomes exact tracked edition/track rows.
- Unrecognized album is one review group; one unresolved album track is one row.
- New plain-name artist folder is discovered without an explicit import action.
- Artist names shared by two catalogue identities remain unresolved.
- Sidecars do not lose ownership when media moves or edition identity changes.
- Strict cleanup preserves tracked and unmapped media, but removes unsupported
  leftovers, with nested empty folders pruned and root retained.
- Concurrent import, interrupted scan, inaccessible directory and symlink cases
  cannot turn an incomplete inventory into a deletion plan.
- Repeat scan, rename and retag previews show no changes for settled files.
- Controlled Lidarr rescans account for standard/deluxe coexistence without
  renaming or retagging the shared files.

## October 6 cleanup hardening

The next full rename/retag and cleanup is explicitly authorized once its
prerequisites pass. Strict cleanup is not implemented and must not be substituted
with remove-unmonitored cleanup.

On `codex/managed-library-cleanup`, empty-parent pruning now returns the actual
removal count, never removes the configured root, stops at retained files and
refuses directory links anywhere in the traversed ancestor chain. A Windows
case-insensitive root regression caught an infinite traversal in the candidate;
the corrected check recognizes root aliases and bounds ancestor traversal.

Rename deduplication now requires identical sidecar bytes as well as matching
scope. The destination artist-field alias is corrected. A lyric collision with
another tracked row must share its exact TrackFiles parent. A DB claim on an
absent target does not justify deleting the source. Different artwork and lyrics
remain conflicts. Hashing runs outside writer admission; the staged file is
reverified and filesystem witnesses are checked inside the commit. Tests inject
a changed retained lyric and a failing DB commit and verify source restoration,
preserved ownership and a settled journal. Native Linux checks passed 81 tests,
with the Windows-only casing test skipped there and passing on Windows.

An interrupted full test runner could previously be mistaken for a recoverable
clone flake when its partial output contained an earlier clone failure. The
runner now requires a completed top-level TAP plan and refuses retries after a
termination or spawn error. Fault-injection subprocess checks confirm interrupted
and terminated runs fail while a completed clone-flake run can still retry.
The earlier interrupted candidate CI is discarded as validation evidence.

All eight live failed artist refresh retries completed successfully on 2.21.0.
A fresh read-only audit decoded the earlier eight audio conflict pairs into
32-bit PCM hashes: seven pairs agree, including two whose edition tags disagree;
one target is now absent. Equal audio alone does not establish edition ownership.
Do not consolidate these paths until current tracked/review ownership and the
intended edition are reconciled. No live rename, retag or deletion was started
during this hardening work.

The subsequent ownership check found all seven existing destinations tracked as
rows 36044-36050, with matching canonical track/edition IDs and stereo quality.
They are same-slot duplicates; two still carry outdated embedded edition tags.
Consolidation must preserve their sidecar associations and repair tags, using
exact row IDs and the mutation journal. The absent target belongs to source row
35761 and should be reconsidered through a fresh rename plan.

The final full CI completed with no new assertion failures. A provider-registry
clone-deserialization failure passed its isolated retry. All 186 frontend tests,
lint, types and builds passed. These candidate fixes remain undeployed until the
broader cleanup and duplicate-consolidation requirements are satisfied.

## October 6 completed live inventory and traversal checks

Live root scan 15506 completed on 2.21.0. Its persisted inventory reports 63,445
files, 3,802 directories, 26 new review files and no missing roots. Artist
reconciliation reported 187 additions, 61 updates and no removals. The actual
Activity view shows completion and no active jobs. Unmapped shows 79 files,
including grouped Bastille mixtape folders. The latest 26 review rows span ten
directories; a read-only audit found no JPG/PNG/WebP/NFO/LRC/SRT/TXT sidecars in
those directories. This bounded check is not a whole-library sidecar audit.
Downloads remain paused, with no active downloads or imports. The last 45
minutes of container logs showed no new scan or writer errors.

The cleanup candidate now rejects a discovered directory disappearing rather
than silently finishing without its contents. It checks ancestor links and
containment before listing directories, including empty ones. Root device/inode
identities and the current directory identity survive continuations; replacing
either invalidates the stored cursor. A root missing when inventory starts stays
recorded as missing even if it reappears later. Existing checkpoints without
these witnesses remain readable, but cannot supply the new identity evidence
for a future deletion gate. Detecting an empty failed mount and rechecking the
full inventory before deletion still require further work.

Actual-app testing also confirmed a remaining scan split. The dashboard Scan
Library Files action uses mediaFile/scan-roots with addNewArtists=true, entering
the older discovery handler. The RescanFolders system task uses the resumable
inventory with addNewArtists=false. The former registered an unknown album FLAC
but reported no file changes, and produced no rootInventory checkpoint. The
latter registered a FLAC directly in the root, persisted witnesses for all three
roots and reported its new review entry. Its repeat added nothing, kept the
ignored review decision, retained the unsupported JSON file and preserved the
album FLAC's SHA-256. Activity and Unmapped showed the actual results. Shared
coverage/completion evidence and truthful discovery counts remain required;
legacy completion must not be treated as deletion authorization.

The reference Lidarr DiskScanService routes RescanFolders through one Scan
method with AddNewArtists passed into the shared import decision configuration.
It checks the configured root before cleaning a missing artist folder, and skips
an empty scan folder before cleaning its media records. See
`.ref_lidarr/src/NzbDrone.Core/MediaFiles/DiskScanService.cs`, Scan and Execute.
Use that common execution structure here: persist new-artist discovery as a
phase, reconcile artists with the existing bounded scan work, then complete the
same all-root inventory. Preserve AddNewArtists as an identification policy,
not a switch to a separate uncheckpointed traversal. An empty root with existing
ownership needs to block orphan-record pruning as well as strict file deletion;
genuinely unused empty roots need not prevent reviewing other healthy roots.

Ten active-schema inventory tests passed on Windows and in the final native
Linux image. The final full CI passed with no newly failing test names against
the previous candidate; the same provider-registry clone-deserialization failure
passed its isolated retry. Lint, types, builds and all 186 frontend tests passed.
The root witness is verified using the ancestor checks, avoiding separate root
filesystem checks for every file. The rebuilt final app registered two real
stereo FLACs, including a loose file directly in the root, then completed a repeat
scan with no additions and stable review row IDs. These traversal fixes remain
on the cleanup branch and are not deployed to the live 2.21.0 container.

## October 6 Lidarr comparison and shared scan execution

The following reference flows were checked directly in the local Lidarr checkout:

| Concern | Lidarr behavior | Discogenius decision |
| --- | --- | --- |
| Scan entry points | `MediaFiles/DiskScanService.cs` routes RescanFolders through one Scan flow with AddNewArtists in its import-decision configuration. It skips empty folders and guards unavailable/empty roots before cleaning missing records. | Manual and scheduled commands now share artist reconciliation and all-root inventory. Optional discovery settles into the checkpoint once before inventory. Empty roots cannot establish that missing owned or review files were deleted. |
| Ownership cleanup | `MediaFiles/MediaFileTableCleanupService.cs` compares scoped TrackFiles with disk paths and removes missing records. | Recheck file absence and root health after writer admission, before removing the exact ownership row. This closes the race where a file reappears during the wait. |
| Sidecar ownership | `Extras/Files/ExtraFile.cs` and `ExtraFileService.cs` retain artist, album and exact TrackFileId relationships; deletion events remove linked extras. | Consolidating duplicates must rebind applicable sidecars to the retained exact row, rather than invoking deletion of their parent and losing its extras. |
| Rename collisions | `MediaFiles/RenameTrackFileService.cs` skips existing destinations and same filenames; successful renames trigger empty-subfolder cleanup. It does not resolve collisions using random suffixes or decoded-audio hashes. | Preserve collisions unless exact ownership, edition, quality and media evidence permit journaled consolidation. Count actual empty directories removed and stay within configured roots. |
| Upgrade replacement | `MediaFiles/TrackImport/ImportApprovedTracks.cs` can remove existing album files when upgrading. | Do not copy this policy wholesale: multiple editions, stereo and spatial files may coexist here. Equal decoded audio across different editions is not deletion authority. |
| Retag input | `MediaFiles/AudioTagService.cs` derives tags from the stored track/release/album/artist graph and local artwork. | Keep retagging on persisted canonical data and local assets. Discogenius's current apply path follows this boundary; an unused private enrichment helper remains a code-cleanup item, not an active retag dependency. |

The isolated app's manual Scan Library Files action registered three generated
FLACs: one unknown album, one loose stereo root file and one loose file in the
disabled spatial library. Activity reported three files added for review.
Discovery registered one and the common root inventory registered two, with
identities for all three roots and `complete=true`. A second manual run reported
no changes, kept all review row IDs and persisted a complete inventory again.
New-artist discovery remains one potentially long phase; this change removes the
alternate command execution path, not every repeated filesystem enumeration.
It also does not implement strict deletion or audio duplicate consolidation.

Forty-one focused tests passed in the Linux image, including empty-root
preservation, files reappearing while waiting for the writer, discovery restart
and failure, review-count accuracy and root traversal witnesses. Downloads on
the live 2.21.0 app remain paused. This candidate has not been deployed.

Final `yarn ci` passed: all 2,019 API tests and 186 frontend tests, lint,
typechecks and builds. There were no new failing test names against the previous
candidate; this run had no clone-deserialization retry. The scheduled-policy
RescanFolders test also completed with the same root witnesses and no additions.
Evidence is in the operator audit directory: `oct06-lidarr-shared-ci.log`,
`oct06-shared-native.log`, `oct06-shared-app-checkpoints.log` and
`oct06-shared-scan-ui.png`.

## October 6 verified audio consolidation candidate

Rename apply now distinguishes a verifiable same-edition stereo duplicate from
an ordinary collision. The candidate must have matching exact canonical track,
edition, recording, artist and library identities; those identities must agree
with the current catalogue graph. Local quality facts must agree. Both files
must probe as one lossless FLAC/ALAC stereo stream with matching codec, sample
rate and bit depth, and their complete decoded 32-bit PCM hashes must match.
Providers are not identity evidence. Different editions or spatial files are
not consolidated. Unsupported or ambiguous candidates remain conflicts.

Decoding happens outside database writer admission under both media-file locks.
The source is staged through FileMutationJournal. Exact source/destination row
snapshots and filesystem witnesses are checked again inside the transaction.
MetadataFiles, LyricFiles and ExtraFiles references transfer to the retained
TrackFiles ID before deleting the source row. Sidecar row IDs and library links
are preserved; the expanded rename selection then handles their physical moves.
The journal settles the staged deletion and empty-parent pruning counts actual
directories removed. A failed transaction restores the source and associations.

The rename preview now lets users select matching ownership candidates for
verification. Its message says the destination is kept only after equal audio
is proved; it does not label a candidate as an already proved duplicate. Ordinary
conflicts remain disabled. A frontend interaction test verifies selection and
the submitted ID, alongside active-schema tests for different editions, spatial
slots, missing identity, incompatible sample/bit-depth facts, different samples,
destination changes, transaction rollback and repeat behavior.

The rebuilt Linux image passed 50 rename/journal tests. Actual-app testing used
generated FLACs with equal audio and different comments plus a linked lyric. An
initial fixture ownership error refused hard links and preserved both files;
after correcting ownership to the app user, the UI queued and completed rename.
The destination retained TrackFiles ID 2, the lyric retained its row ID and moved
with track_file_id=2, the Imports folder disappeared, and the journal was empty.
A repeat rename preview had no changes. The app then retagged that retained file,
writing the fixture canonical identifiers and lyrics; ffprobe confirmed the
tags and a repeat preview had no changes. Its decoded PCM SHA-256 matched a
reproduced original fixture. Evidence: `oct06-audio-app-proof.log`,
`oct06-audio-retag-ui.png`, `oct06-audio-duplicate-final-native.log`.

These changes remain a candidate, not a live cleanup result. The seven verified
live duplicate pairs still require controlled deployment, fresh ownership
proof and consolidation; the two stale retained edition tags require retagging.
Strict unowned-file cleanup and full-library artwork acceptance remain open.

Robert's current goal additionally authorizes removing unresolved Unmapped media
at the final managed-library reconciliation, after identification has been
attempted and the complete inventory is validated. Treat this as an explicit
one-time disposition, separate from the ordinary strict setting that protects
Unmapped review media. Record exact paths and outcomes rather than silently
changing the default policy for future scans. The download queue may be cleared
and resumed only after cleanup, library-wide rename/retag and their acceptance
checks establish the requested clean live library.

Final full `yarn ci` passed with all 2,029 API tests and 187 frontend tests,
lint, typechecks and builds. No clone retries or failing test names occurred.
`oct06-audio-duplicate-final-ci.log` records this final source version; the
earlier CI log predates the preview action and is not its acceptance evidence.
