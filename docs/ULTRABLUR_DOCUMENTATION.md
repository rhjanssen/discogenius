# UltraBlur Background System

Last updated: 2026-06-18

## Scope and Ownership

This document covers the current UltraBlur implementation used across the Discogenius UI shell.

- Backend ownership: api/src/routes/ultrablur.ts
- Frontend ownership: app/src/ultrablur/* and app/src/providers/UltraBlurProvider.tsx

## Current Architecture

UltraBlur is a server-rendered pipeline:

1. The backend extracts four representative colors from an artwork URL.
2. The backend renders a small four-corner gradient image from those colors.
3. The frontend displays that image, blurred and cross-faded, behind the UI.

Backend endpoints:

- GET /services/ultrablur/colors?url=<http(s) image url> — four corner colors.
- GET /services/ultrablur/image?topLeft=…&topRight=…&bottomLeft=…&bottomRight=…&width=…&height=… — a cacheable gradient PNG built from those colors.

Reason for server-side work:

- TIDAL artwork URLs do not reliably allow browser-side pixel reads due to CORS.

## Backend Behavior

api/src/routes/ultrablur.ts:

- Accepts only http/https URLs (colors endpoint).
- Fetches the image with a timeout and size cap, decodes PNG/JPEG, then samples,
  filters, and clusters pixels in a perceptual color space to pick four corners.
- Renders the gradient PNG (immutable cache headers) from the four colors.

## Frontend Behavior

Core files:

- app/src/ultrablur/useUltraBlur.ts — calls the colors endpoint, caches colors
  in memory, falls back to defaults on failure.
- app/src/providers/UltraBlurProvider.tsx — holds the current artwork URL and
  publishes the UltraBlur context (extracted colors, or defaults when cleared).
- app/src/ultrablur/UltraBlurBackground.tsx — requests a small gradient image for
  the current colors, blurs it (CSS `filter: blur`) and scales it to cover, and
  cross-fades between the previous and the next image once the new one decodes.

## Default Colors (No Artwork)

From app/src/ultrablur/colors.ts:

Dark defaults:

```ts
{
  topLeft: "#0a0c10",
  topRight: "#12141a",
  bottomLeft: "#08090c",
  bottomRight: "#15181e",
}
```

Light defaults:

```ts
{
  topLeft: "#e0e3e8",
  topRight: "#ebedf0",
  bottomLeft: "#d8dce2",
  bottomRight: "#f4f5f7",
}
```

## Operational Notes

- Pages set/clear artwork through useUltraBlurContext().
- If extraction fails, UI still renders with defaults (no blocking failure mode).
- Pre-caching helpers exist for list views:
  - precacheUltraBlurColors(imageUrls)
  - clearUltraBlurCache()

## Boundaries

- UltraBlur is a presentation system only; it does not own media metadata.
- Do not move artwork color extraction into browser-only code paths for TIDAL URLs.
- Keep route-level extraction concerns in api/src/routes/ultrablur.ts and rendering concerns in app/src/ultrablur/.
