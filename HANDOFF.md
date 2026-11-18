# Session Handoff

- **Branch**: `agent/issue-147` / `agent/issue-146` (PR #147 for Issue #146)
- **What is done**:
  - **Rebased onto current `main`** (`b2c08aa6` / `cb02eb58`, v2.26.5), cleanly integrating #148/#149 upgrade offer identity with the album-level winner upgrade policy (#146).
  - **Maintained #148 offer attachment and validation intact**:
    - Whenever `acquisitionPlanId` is set, album and per-track upgrade payloads carry the winning plan's `trackOffers` (and MBIDs) via `buildAcquisitionDownloadCommand`.
    - Upgrades skip before queuing if no matching offer exists or if provider/edition diverges from the plan.
    - Memoized plan commands in `planCommandCache` per run to avoid redundant allocations.
  - **Album-level winner quality upgrade policy (#146)**:
    1. **Album-level winner**: Upgrades planned against winning album acquisition plan only (Lidarr-style). Resolved by priority: `SelectedAcquisitionPlans` -> `AcquisitionPlans` (current) -> accepted `ProviderEditionMatches` -> file provider item membership/snapshot.
    2. **Spatial library**: Tracks that winning plan only has in stereo (interludes) stay in that album and are not re-queued to Atmos while the plan has no Atmos version.
    3. **Stereo-only track later gains Atmos**: Upgraded once Atmos becomes available in the winning plan.
    4. **Stereo library, Atmos-only file**: Replaced as soon as a real stereo version exists in the winning plan into the stereo slot.
    5. **Genuine stereo upgrade in spatial album**: Stereo tracks in spatial albums can receive genuine better stereo upgrades within the winning plan.
    6. **Review fixes**:
       - Stereo fallback loop prevention: falls back to album-level stereo only when winning track has no variants at all (`variants.length === 0`), never when it has a spatial variant.
       - No provider mixing inside albums: standalone per-track upgrades never mix providers or releases with existing files; whole-album replacement cleanly replaces when album threshold (>=50% or >=3 tracks) is met.
       - Strict cross-edition scoping: `resolveWinningTrack` strictly confines resolution inside `providerEditionItemId` when known.
       - Deterministic release fallback: prefers releases with accepted `ProviderEditionMatches`.
  - **Tests**:
    - Kept all #149 tests passing unchanged in `upgrader-canonical.test.ts` and `import-operation-identity.test.ts` (28/28 tests passing).
    - Kept all canonical tests from PR #147 passing (27/27 tests in `upgrader-canonical.test.ts`).
    - Added test `checkUpgrades album upgrade enqueued from new winning plan carries that winning plan's trackOffers` verifying that when a new provider wins, the queued payload's `trackOffers` come from the new winner.
- **What is half-done**:
  - None.
- **What was verified against running container**:
  - Active SQLite schema fixture matching production schema 46; verified queries use index lookups without full table scans.
- **Open questions for PO**:
  - None. Rebase and conflict resolution complete, all #148/#149 behaviors preserved, full `yarn ci` clean.
