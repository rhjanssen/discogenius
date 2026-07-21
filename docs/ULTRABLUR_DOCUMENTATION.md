# UltraBlur Background System

## Scope and Ownership

This document covers the current UltraBlur implementation used across the Discogenius UI shell.

- **No backend.** There is no `api/src/routes/ultrablur.ts`, no `/services/ultrablur` mount in `api/src/server.ts`, and no Vite proxy for `/services/ultrablur`.
- Frontend ownership: `app/src/ultrablur/*` and `app/src/providers/UltraBlurProvider.tsx` / `UltraBlurContext.ts`.

## Current Architecture

UltraBlur is **entirely client-side**:

1. Detail pages resolve artwork with `mediaCoverSrc(...)` (preferring same-origin `/media-cover/...` URLs).
2. When the hero `<img>` is ready (`onLoad` **or** already `complete` from cache), the page calls `setArtworkFromImage(url, image)` via `useUltraBlurHero` so colours are sampled from the already-decoded bitmap (`crossOrigin="anonymous"` before `src`).
3. Four corner colours are extracted in the browser (`extractUltraBlurColorsFromImage`).
4. `renderUltraBlurDataUrl` bakes a soft four-corner falloff gradient (linear
   light, smoked-glass mix toward theme void/paper, faint noise) into a static
   PNG with blur already in the pixels — matching Plex UltraBlur GetImage
   (`noise=1`, four corner colours) without a backend round-trip. Bakes are
   memoised by palette + theme.
5. `UltraBlurBackground` displays that bitmap as a plain `background-image` and cross-fades layers. There is **no live CSS `filter: blur()`** on the displayed layer. Data-URL bakes skip an extra `Image.decode` wait.

CORS note: same-origin `/media-cover` URLs stay canvas-untainted when the hero sets `crossOrigin` before `src`. If a page only has a URL (no hero seed), `useUltraBlur` loads that **same** URL with `crossOrigin = "anonymous"` (no `cover-250` detour that could re-trigger slow on-the-fly artwork resolve).

## Frontend Behavior

### Core files

| File | Role |
|------|------|
| `app/src/utils/artwork.ts` | `mediaCoverSrc` / `renderableArtworkUrl` — pick a renderable cover URL |
| `app/src/providers/UltraBlurProvider.tsx` | Holds `artworkUrl`, exposes `setArtwork` / `setArtworkFromImage` |
| `app/src/providers/UltraBlurContext.ts` | Context + `useUltraBlurContext()` |
| `app/src/ultrablur/useUltraBlur.ts` | Client colour extraction + in-memory cache; `seedUltraBlurColorCache` |
| `app/src/ultrablur/extractColorsFromImage.ts` | Sample four corner regions from an `HTMLImageElement` |
| `app/src/ultrablur/renderUltraBlurBitmap.ts` | One-shot canvas bake → JPEG data URL (blur baked in) |
| `app/src/ultrablur/UltraBlurBackground.tsx` | Fixed full-viewport layers + theme overlay; opacity cross-fade only |
| `app/src/ultrablur/colors.ts` | Colour types and theme default corners |

### Navigation hold

Detail pages pass `artworkUrl` as:

- `string` — apply this cover
- `undefined` — entity still loading; **do not clear** ambience
- `null` — entity loaded with no cover; clear to theme defaults (`ownsAmbience`)

`useArtworkBrandColor` only calls `setArtwork(undefined)` on `null`, so artist → album keeps the artist ultrablur until the album cover is ready. `UltraBlurProvider` also holds the last good palette while `isLoading` is true after a URL change.


1. Resolve the cover: `const url = mediaCoverSrc(entity)` (uses `cover_art_url`, then legacy aliases; drops raw provider UUIDs).
2. Render the hero with that URL.
3. On `onLoad`, call:

```ts
const { setArtworkFromImage } = useUltraBlurContext();
// ...
<img
  src={url}
  onLoad={(e) => setArtworkFromImage(url, e.currentTarget)}
/>
```

`setArtworkFromImage`:

- Runs `extractUltraBlurColorsFromImage(image)` on the painted hero.
- Seeds `seedUltraBlurColorCache(url, colors)` so `useUltraBlur` does not decode again.
- Sets `artworkUrl` so the shell background updates immediately.

Used on artist / album / video detail heroes. Fallback `setArtwork(url)` still works when only a URL is available; the hook then loads and extracts once.

### Static baked bitmap (no live CSS filter)

`renderUltraBlurDataUrl(colors, isDarkMode)`:

- Samples dominant saturated colour per cover corner (not a flat quadrant mean).
- Builds a low-res IDW falloff (~2.0) so corners overlap in the centre instead of
  reading as four blobs.
- Mixes the field toward dark void / light paper (smoked glass) without grey
  desaturation that crushed chroma.
- Blurs once, crops the pad, returns PNG.

`UltraBlurBackground` uses that data URL as `background-image`. Display layers
intentionally avoid CSS blur and vignette overlays.

### Shell wiring

- `App.tsx` wraps the tree in `UltraBlurProvider`.
- `Layout.tsx` mounts `<UltraBlurBackground colors={...} isDarkMode={...} />` behind page content.

## What Was Removed

The previous server-rendered pipeline (`GET /services/ultrablur/colors`, `GET /services/ultrablur/image`, Sharp-based gradient PNG, Vite proxy to `/services/ultrablur`) is gone. Do not reintroduce backend UltraBlur endpoints unless CORS or pixel access makes client extraction impossible again for a required artwork source.
