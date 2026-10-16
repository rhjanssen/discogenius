# Handoff from Codex to Grok Build (9 Oct 2026)

Codex hit its usage limit on 9 Oct 2026 at 09:44 (blocked until 14 Oct). You (Grok Build) take over this workstream. Robert writes in Dutch; reply to him in short, plain Dutch. He has very low vision, so keep status messages short and scannable.

## Robert's goal and deadline
- He wants to **re-enable downloads from this weekend (Sat 10 / Sun 11 Oct 2026)** to fetch all missing tracks.
- Before that, the existing library on the live server must be in a perfect state: no stray, untracked or unmapped files, correct names, tags and sidecars, all linked in the database, and from then on a working app that keeps downloading from the providers until the library is complete. He asked to "move fast and push through" (8 Oct).
- Also free a lot of disk space in the Discogenius **config folder**: the MediaCover cache must be cleaned and kept small. The config folder must not grow to tens or a hundred GB; full-res images already live in the library itself (8 Oct).

## Standing objective (verbatim from the Codex thread goal, last updated 9 Oct 09:20)
Proceed with fixing and improving. Overall goal: get Discogenius fully functional and bug free, then perform a folder scan on all artists in the live server library, remove any unmapped files or untracked files and folders so everything that remains has a link to an artist/album/track, then perform a library-wide rename and retag job (assuming that is fully working too), and if after that the whole library is in a clean state (properly named files and folders, all metadata tags correct, all sidecars where they should be, in the library root and the database), empty the current download queue, unpause the queue, and let Discogenius run so items get queued again through its scheduled tasks, just like Lidarr.

Rules carried over:
- Read `docs/TASKS.md` and `docs/MANAGED_LIBRARY_CLEANUP.md` and verify the current Git branch and deployed version before acting.
- Use the `.ref_*` directories (especially `.ref_lidarr`, also `.ref_jellyfin`) to inform design decisions. Don't reinvent the wheel; Robert explicitly wants Lidarr-like scan, file ownership, rename/retag, cleanup and duplicate handling.
- **Keep downloads paused** until the library is verified clean.
- Use the live API and authorized NAS SSH access. **Never open host SQLite while the container is running.**
- Test in local containers and through the actual app; publish/deploy only tested changes; record confirmed results and remaining work in the project docs.
- Robert authorized: a fresh library-wide rename followed by retag, then deletion of verified duplicate or strictly unowned files and pruning of their empty folders, once required fixes and a fresh complete inventory are validated. Preserve tracked files, Unmapped review media and their applicable sidecars; do not substitute remove-unmonitored cleanup for strict cleanup.
- Scan 15759 completed on 2.21.0 without filesystem identity witnesses and cannot authorize strict deletion. Investigate a-ha and Dirty Honey refresh failures carefully: selected TIDAL plans held by waiting DownloadQueue rows reference obsolete tracks, so do not delete their bindings blindly.
- Seven earlier audio conflict destinations are owned by TrackFiles with the same track/edition/stereo quality as their sources; reverify ownership, preserve sidecar links when consolidating duplicates, and repair the two destinations with outdated edition tags via retagging.
- Notify Robert only about meaningful failures, completion, material change or required input.

## Where Codex stopped
- Branch: `codex/managed-library-cleanup`. Last pushed commit: `df5b905e fix(scan): resolve artist ownership and bound album title selectors` (full CI passed, incl. 187 frontend tests). **Not yet deployed live.**
- Live: The Kinks task finished on its own; the temporary stall is a separate open item.
- **Uncommitted work in progress** (artwork cache retirement):
  - `api/src/services/metadata/media-cover-cache-retirement.ts`
  - `api/src/services/metadata/media-cover-cache-retirement.test.ts`
  New rules: an unused album original in the MediaCover cache may be removed when chosen edition or manual artwork covers the imported files; an uncovered edition, changed image, or source changed mid-run blocks removal. Three cleanup tests failed on the previous container and pass with the fix. Last edge case added: legacy file rows that have a canonical album ID but no internal edition ID must block deletion when their artwork coverage is unknown (regression test now passes). Review, finish, test and commit this.
- Still open before the library repair round on the server: artwork cleanup finished and deployed, the bounded cleanup planner and sidecar ownership reconciliation, then a fresh complete inventory, rename, retag, strict cleanup, verification, and finally emptying and unpausing the download queue.
- UI request still open (7 Oct): check-mark icons for finished tasks/downloads must be green, not monochrome.

## Order of work (suggested)
1. Verify branch, working tree and deployed version; finish and commit the artwork cache retirement change.
2. Complete remaining fixes needed for strict, inventory-first cleanup; test locally and through the app.
3. Deploy the tested build to the live server; clean the MediaCover cache so the config folder shrinks.
4. Fresh full scan, then rename, retag, strict cleanup of verified duplicates/unowned files and empty folders; verify.
5. Empty the download queue, unpause, and confirm scheduled tasks queue items again. Report to Robert in Dutch.
