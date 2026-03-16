---
name: discogenius-frontend
description: Frontend workflow for Discogenius (React + Vite) using Fluent UI v9, UltraBlur theming, and react-query. Use when building UI, pages, hooks, or API integrations, including TIDAL image/video display and responsive layouts.
---

# Discogenius Frontend

## UI + theming
- Use Fluent UI v9 components, `makeStyles`, and `tokens`.
- Avoid inline styles; keep styling in `makeStyles`.
- Maintain responsive layout with flex/grid and Fluent spacing tokens.
- Use the existing theme provider stack as the single source of truth for dark/light state. Do not duplicate theme detection in pages or layout components.
- Prefer the user-facing term `Curation` for the release-selection feature. Use `Manual Import` for the dashboard unmapped-file flow.

## Data fetching
- Use `@tanstack/react-query` for queries/mutations.
- Call the backend via the `api` service in `app/src/services/api.ts`.
- Show loading, empty, and error states consistently.

## Media rendering
- Use `getAlbumCover`, `getArtistPicture`, and `getVideoThumbnail` from `app/src/utils/tidalImages.ts`.
- Keep UltraBlur background in sync via `useUltraBlurContext`.
- Queue/activity/manual-import surfaces live under `app/src/pages/dashboard/` and should stay co-located there.

## UX standards
- Read the guidance from the urls below in full before implementation:
    - https://fluent2.microsoft.design/design-principles
    - https://fluent2.microsoft.design/color
    - https://fluent2.microsoft.design/elevation
    - https://fluent2.microsoft.design/iconography
    - https://fluent2.microsoft.design/layout
    - https://fluent2.microsoft.design/material
    - https://fluent2.microsoft.design/motion
    - https://fluent2.microsoft.design/shapes
    - https://fluent2.microsoft.design/typography
    - https://fluent2.microsoft.design/color-tokens
    - https://fluent2.microsoft.design/accessibility
    - https://fluent2.microsoft.design/content-design
    - https://fluent2.microsoft.design/design-tokens
    - https://fluent2.microsoft.design/handoffs
    - https://fluent2.microsoft.design/onboarding
    - https://fluent2.microsoft.design/wait-ux
- Use `Badge`, `Spinner`, and `Text` for status feedback.
- Keep action clusters grouped and clearly labeled.
- After frontend changes that affect packaging or assets, validate with `yarn --cwd app build`; if behavior could differ in-container, rebuild/run Docker too.
