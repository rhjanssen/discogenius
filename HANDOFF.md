# Session Handoff

- **Branch**: `agent/issue-148` (PR for Issue #148)
- **What is done**:
  - **Issue #148**: Fixed quality upgrade import failure where commands organized files and then failed with `[ImportDownload] Acquisition plan <id> imported tracks without exact provider offer identity`:
    1. **Upgrader enqueue identity (`UpgraderService`)**:
       - Enqueue payloads for both `DownloadAlbum` and `DownloadTrack` upgrades now carry `trackOffers` (and `acquisitionMode` where appropriate) whenever `acquisitionPlanId` is set, matching the winning plan's assignments (`providerTrackItemId`, `providerAudioVariantId`, canonical MBIDs, edition IDs) built via `buildAcquisitionDownloadCommand`.
       - If matching offers cannot be built or a provider/edition mismatch is detected against the winning plan, upgrade enqueue is skipped closed rather than enqueued without identity.
       - Enqueue now selects from `SelectedAcquisitionPlans` (winning plan) with in-memory memoization per plan ID during the check pass.
       - Added `trackOffers?: DownloadTrackOffer[];` to `DownloadTrackCommand` in `command-bodies.ts`.
    2. **Import-phase offer reconstruction & pre-organize guard (`downloaded-tracks-import-service.ts`)**:
       - Added `reconstructPlanTrackOffers(planId, expectedProvider?, expectedReleaseMbid?)` using `evaluateAcquisitionDownload(db, planId, { allowUnverifiedProjection: true })`.
       - `DownloadedTracksImportService.process`: Refuses to organize files into the library if `acquisitionPlanId` is set, `trackOffers` is empty, and offers cannot be reconstructed from the plan, failing closed before any library mutation.
       - `persistDownloadedProviderProvenance`: If `trackOffers` is empty and `acquisitionPlanId` is set, reconstructs offers from the current acquisition plan to stamp `provider_item_id` and `source_audio_variant_id` on `TrackFiles` without throwing.
    3. **Tests**:
       - `upgrader-canonical.test.ts`: Added unit tests verifying `checkUpgrades` enqueues album-level upgrades with `trackOffers` and `acquisitionMode`, single-track upgrades with that specific track offer, and refuses offers when provider or edition diverges from winning plan.
       - `import-operation-identity.test.ts`: Added unit tests verifying provenance stamping with plan payload, plan offer reconstruction for current-main payloads, rejection when plan does not exist, provider/edition mismatch rejection, and failing closed before organizing files.
  - **Verification**:
    - Full `yarn ci` passed (`yarn lint`, `yarn typecheck`, `yarn test:api` [2758/2758 passing], `yarn test:app` [201/201 passing], `yarn build`).
- **What is half-done**:
  - None. All acceptance criteria for Issue #148 are met.
- **What was verified against running container**:
  - Validated database and download pipeline against active schema (user_version 46).
- **Open questions for PO**:
  - None. PR #147 remains compatible with this enqueue and import contract.
