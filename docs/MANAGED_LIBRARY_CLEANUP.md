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

The native-container probe scanned a generated FLAC under the plain Bastille
folder, registered it for review and preserved its source. The app's Unmapped
row and Manual Import dialog were inspected. This does not establish complete
root discovery, album-group presentation or strict cleanup; those remain gates.

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
