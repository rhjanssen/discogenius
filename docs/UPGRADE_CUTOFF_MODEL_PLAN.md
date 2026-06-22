# Upgrade aspect → Lidarr cutoff-model (remove `upgrade_queue`)

Status: **planned** (approved direction; implement as a focused pass)

## Goal

Adopt Lidarr's upgrade model: no materialized upgrade queue. Upgrades are computed
on demand from quality-profile **cutoffs**, decided by an **`UpgradableSpecification`**,
and flow through the normal download → import (replace-by-identity) pipeline.

## Current state (what we have)

- `UpgradableSpecification` already exists — `api/src/services/config/upgradable-specification.ts`
  (`buildEffectiveProfile`, `audioCutoff`/`videoCutoff`, `qualityCutoffNotMet`). This is
  Lidarr's spec; **keep it**.
- `UpgraderService.checkUpgrades()` (`api/src/services/mediafiles/upgrader.ts`) already:
  scans `TrackFiles` + `ProviderItems`, compares current file quality vs the provider's
  offered quality via `qualityCutoffNotMet`, and **queues download commands**
  (`CommandQueueManager`).
- `commands.name = 'CheckUpgrades'` triggers it; `config.ts` triggers it on quality change.
- `upgrade_queue` table is **not** the file-replacement engine — import replaces the
  existing `TrackFiles` row by canonical identity. `upgrade_queue` only:
  1. **dedup/skip state** — `status` (`pending`/`skipped`/`completed`) so a path the provider
     can't actually upgrade isn't re-queued every run (`upgrader.ts` reads `LEFT JOIN
     upgrade_queue uq`, line ~137/232; writes `INSERT/UPDATE`, ~248/287).
  2. **cleanup hooks** — `clearUpgradeQueue()` in
     `downloaded-tracks-import-service.ts` (~68, called ~286/420).

## The one real risk: re-download loops

Removing `upgrade_queue` removes the `skipped` memory. Loop case: provider metadata
advertises a higher tier, we queue a download, but the delivered file is the **same**
quality → next `checkUpgrades` run sees cutoff still unmet → re-queues forever.

Lidarr prevents this with grab-time spec + **history/blocklist**. We must preserve
equivalent loop-prevention without the queue. Recommended (lean) approach:

- **History-guard**: before queuing an upgrade download, skip if a completed
  `Download*`/`ImportDownload` command for the same canonical item exists within a cooldown
  window AND the resulting file quality did not improve. We already have command history
  (`commands` table, completed rows with payload). This replaces the `skipped` flag with a
  derived check (no new table) — matching Lidarr's "don't re-grab what didn't upgrade".
- Confirm command-queue dedup already blocks duplicate *pending* upgrades by `ref_id`+`name`
  (it does — `CommandQueueManager.push`), so only the post-failure loop needs the guard.

## Steps

1. **`upgrader.ts`**: drop the `LEFT JOIN upgrade_queue uq`, the `INSERT/UPDATE upgrade_queue`,
   and the `uq.status === 'skipped'` gate. Replace the skip gate with the history-guard above.
   Keep the cutoff scan + `CommandQueueManager` queuing.
2. **`downloaded-tracks-import-service.ts`**: remove `clearUpgradeQueue()` and its 2 call
   sites; confirm import still replaces the existing `TrackFiles` row by identity (it does).
3. **`database.ts`**: remove the `upgrade_queue` CREATE TABLE, `createUpgradeQueueProviderIdentityTable`,
   `ensureUpgradeQueueProviderIdentitySchema`, and the v27 re-key migration (no backwards-compat
   needed — test container only). Drop the table if present on boot.
4. **Tests**: `upgrader-canonical.test.ts` asserts on `upgrade_queue` rows — rewrite to assert
   on **queued download commands** (`SELECT … FROM commands WHERE name IN (Download…)`), which
   the test partly does already (`listDownloadJobs`). Add a loop-guard test: a completed
   no-improvement download is **not** re-queued.
5. **Naming alignment** (optional, while here): `CheckUpgrades` → keep (clear), but consider a
   `CutoffUnmet`-flavored description; ensure `UpgradableSpecification` is the single source of
   the upgrade decision used by both `checkUpgrades` and import.

## Verification

- `yarn --cwd api build`, `yarn test:api` (esp. `upgrader-canonical.test`), `yarn lint`.
- Manual: set a low audio cutoff, run `CheckUpgrades`, confirm download commands queued for
  cutoff-unmet items and **no** re-queue on a second run when nothing improved.
- Grep: no remaining `upgrade_queue` references in `api/src`.
