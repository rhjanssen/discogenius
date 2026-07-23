# Frontend Development (app/)

Use this skill when writing or changing UI under `app/src/` — pages, components,
hooks, theming, or data fetching.

Stack: **React + Vite + Fluent UI v9 (`@fluentui/react-components`) + TanStack
Query**. The frontend stays **pure Fluent UI** — this is a hard product mandate.
Conventions below adapt **Fluent UI's own agent guidance** (`.ref_fluentui/AGENTS.md`,
`.ref_fluentui/docs/`). As that file itself says: *the instructions are the
source of truth, not existing code.* Our app carries some early-alpha patterns
(e.g. a few `React.FC` and ad-hoc styles) — don't copy them into new work.

## Layout

- `pages/` — route screens (`ArtistPage`, `AlbumPage`, `Library`, `SettingsPage`, …)
- `components/` — shared UI (incl. `DataGrid/`, `Layout`, `GlobalSearch`)
- `hooks/` — data + view-state hooks (`useAlbumPage`, `useArtists`, …)
- `providers/` — React context providers (auth, theme, queue status, UltraBlur)
- `services/api.ts` — the single API client
- `theme/` — Fluent theme (`theme.ts`, `fluentThemeDesigner`)
- `utils/`, `ultrablur/`, `types/`

## Critical Fluent rules (never violate)

1. **Never hardcode colors, spacing, radius, or typography.** Always use design
   tokens from `@fluentui/react-components` (`tokens.colorNeutralForeground1`,
   `tokens.spacingHorizontalM`, …). Hardcoded values break light/dark theming and
   the dynamic brand palette.
2. **Style with Griffel `makeStyles` + `mergeClasses`.** No inline `style={{…}}`
   for anything themeable, no `mergeStyles`/`mergeStyleSets`/`IStyle` (those are
   v8). When merging, **user `className` goes last** so callers can override.
   ```tsx
   const useStyles = makeStyles({
     root: { color: tokens.colorNeutralForeground1, padding: tokens.spacingHorizontalM },
   });
   // …
   const classes = useStyles();
   <div className={mergeClasses(classes.root, className)} />
   ```
3. **Only `@fluentui/react-components` (v9).** Never import from `@fluentui/react`
   (v8) for new work. Use Fluent primitives (`Button`, `Menu`, `Dialog`,
   `Field`, `Spinner`, `DataGrid`, …) before hand-rolling.
4. **Theme through `FluentProvider`.** Respect the existing theme/brand providers;
   don't reach around them with global CSS.
5. **Don't reach into `window`/`document`** in ways that break portals/SSR. Use
   Fluent's positioning/portal primitives; guard any direct DOM access.

For a genuinely reusable component that must forward a ref, follow Fluent's
`ForwardRefComponent` + `React.forwardRef` pattern rather than `React.FC`.
(Page-level screens that never forward a ref don't need it.)

## Data fetching (TanStack Query)

- Server state lives in **React Query**, not `useEffect` + `useState` fetch
  loops. Co-locate query hooks under `hooks/` (`useAlbums`, `useArtistPage`, …)
  and go through `services/api.ts`.
- **Beware the identity-loop bug family**: a fresh-but-deep-equal dependency
  (query key, options object, or callback) re-runs effects/queries forever. The
  network signature is repeated abort→200 refetches. Stabilise keys, memoise
  option objects, and ref-through callbacks rather than re-creating them each render.
- Never flip a user-locked monitor/lock control from an automated effect — locks
  are user intent.

## Verify UI changes in the browser (don't ask the user to check)

When a change is observable, use the preview/browser tools:
1. `preview_start` the dev server (never run it via a raw shell).
2. Reload, then check `read_console_messages` / `read_network_requests` for errors.
3. `read_page` to confirm content/structure; `resize_window` for responsive + dark
   mode; screenshot the result as proof.
Prefer the **Bastille**/**Bakermat** artists for realistic data.

## Validation before you claim done

- `yarn --cwd app build` after frontend changes, and `yarn --cwd app typecheck`
  — the Vite build alone tolerates type errors, so typecheck explicitly.
- `yarn lint` (Fluent/token lint rules live in the eslint config).
- Full `yarn ci` before a release.

## Reference conventions (`.ref_fluentui`)

- `AGENTS.md` — tokens over hardcoded values, Griffel `makeStyles`, `mergeClasses`
  className-last, v9-not-v8, no direct `window`/`document`.
- `docs/` + `specs/makeStyles.md` — styling architecture and design-token layers.
- The meta-lesson: encode conventions and **don't trust legacy code** as the
  pattern — verify against the rules.
