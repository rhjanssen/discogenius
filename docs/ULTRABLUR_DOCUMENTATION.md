# UltraBlur Background System

Last updated: 2026-03-13

## Scope and Ownership

This document covers the current UltraBlur implementation used across the Discogenius UI shell.

- Backend ownership: api/src/routes/ultrablur.ts
- Frontend ownership: app/src/ultrablur/* and app/src/providers/UltraBlurProvider.tsx

## Current Architecture

UltraBlur is a two-stage pipeline:

1. Backend extracts four representative colors from an artwork URL.
2. Frontend renders the blurred background image from those colors.

The backend endpoint is:

- GET /services/ultrablur/colors?url=<http(s) image url>

Reason for server extraction:

- TIDAL artwork URLs do not reliably allow browser-side pixel reads due to CORS.

## Backend Behavior

api/src/routes/ultrablur.ts:

- Accepts only http/https URLs.
- Fetches image with timeout and size cap.
- Decodes PNG/JPEG.
- Samples, filters, and clusters pixels in perceptual color space.
- Returns four corner colors:
  - topLeft
  - topRight
  - bottomLeft
  - bottomRight
- Uses API response caching (6 hours) to reduce repeated extraction work.

## Frontend Behavior

Core files:

- app/src/ultrablur/useUltraBlur.ts
  - Calls /services/ultrablur/colors
  - Maintains in-memory color cache
  - Falls back to defaults on extraction failure

- app/src/providers/UltraBlurProvider.tsx
  - Holds current artwork URL and published UltraBlur context
  - Uses extracted colors when artwork exists
  - Uses default colors when artwork is cleared

- app/src/ultrablur/renderUltraBlur.ts
  - Renders four-corner gradient + optional blob/noise/vignette layers

- app/src/ultrablur/UltraBlurBackground.tsx
  - Draws the generated background behind app content

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
