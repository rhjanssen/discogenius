# Structure audit — Discogenius 2.6

Incremental findings only. No mass moves in this pass. Aligns with
`docs/TASKS.md` (2.6.0) and `docs/STREAMING_PROVIDER_PLUGIN_CONTRACT.md`
§ “2.6 modularity target”.

## Target shape (agreed direction)

| Area | Preferred layout | Today |
| --- | --- | --- |
| Streaming adapters | `api/src/providers/<id>/` + public `api/src/providers/` barrel (registry + types) | Implementations under `api/src/services/providers/<id>/`; phase-1 public surface now at `api/src/providers/` |
| Core library / queue / catalog | Stay under `api/src/services/` | Same |
| Catalog sources | `api/src/services/catalog/` (already a seam) | Same |
| Frontend | `app/src/` Fluent UI only | Same |
| Operator / design docs | `docs/` | Same |
| Runtime state | `config/` (never commit secrets) | Same |
| Reference checkouts | `.ref_*` (read-only) | Present |

## Phase 1 landed / in flight

- **Public provider surface:** `api/src/providers/` exports registry + shared
  types. Concrete adapters still live under `services/providers/<id>/` until
  per-provider moves.
- **Compat re-export:** `api/src/services/providers/index.ts` remains the
  historical import path so existing callers do not break mid-migration.
- **Pilot candidate:** SoundCloud (small, lossy-only, experimental) — physical
  move to `api/src/providers/soundcloud/` after hardening, not during sibling
  download/video/matcher work.

## Findings (confirm before moving)

### High value / low risk

1. **Root scratch junk** (do not commit; delete when idle):
   - `.tmp-amy-invest*.js`, `.tmp-wgm-insp.js`, `.tmp-covers/` — sibling
     investigation artifacts (Amy OST / WGM / cover probes). Leave until those
     threads finish.
   - `query_db.js`, `discogenius_test.db` — ad-hoc DB helpers; move under
     `scripts/` or delete when unused.
2. **`api/dist/`** — build output sometimes left untracked; ensure `.gitignore`
   covers it (do not commit).
3. **Provider-private imports from core** (boundary debt):
   - `commands/health.ts` → `providers/tidal/tiddl.js`
   - tidal-shaped `backends.tiddl` health projection
   - Replace with backend-id-keyed diagnostics from the provider contract.

### Medium — incremental PRs

4. **Large monoliths** already tracked in `docs/LIDARR_STRUCTURE_ALIGNMENT.md`
   (`organizer.ts`, remaining Settings surface, download processor). Split
   alongside feature work, not as a reorg-only PR.
5. **Shared provider helpers** (`provider-quality`, `provider-auth-support`,
   `provider-diagnostics`, `followed-artists-import`, `token-refresh`) stay
   shared under `services/providers/` or move to `api/src/providers/_shared/`
   once the public barrel is stable.
6. **yt-dlp binary helper** lives under YouTube Music today; SoundCloud (and
   future CLI backends) import it — extract to shared download tooling when a
   second consumer needs a clean import without coupling to YTM.

### Defer

7. Dynamic npm plugin loading / separate publishable packages per provider.
8. Moving TIDAL/`tiddl` while download-retry and tiddl-error siblings are active.
9. Frontend route/folder reshuffles unrelated to Settings/Catalog WIP.

## Proposed move order

1. Keep `api/src/providers/{index,registry,types}.ts` as the stable public API.
2. Point new core code at `@/` / `api/src/providers` imports (registry + types only).
3. Relocate SoundCloud folder → `api/src/providers/soundcloud/` with a thin
   re-export stub left behind if needed for one release.
4. Deezer (similar size) → same pattern.
5. Apple / YouTube / TIDAL last (largest + most core entanglement).
6. Delete leftover `services/providers/<id>/` stubs after grep is clean.

## Validation per move

- `yarn --cwd api build` and focused provider/registry tests.
- Auth page still lists the provider; download backend still registers.
- No new imports from `commands/` / `music/` into provider-private modules.
