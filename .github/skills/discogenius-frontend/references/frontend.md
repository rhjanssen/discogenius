# Discogenius Frontend Reference

## Architecture
- Router: React Router v6 in app/src/App.tsx.
- UI library: Fluent UI React v9 (@fluentui/react-components).
- State and data: React Query (TanStack Query) via custom hooks in app/src/hooks/.
- API client: app/src/services/api.ts (singleton).
- Theme ownership: app/src/providers/FluentThemeProvider.tsx + app/src/providers/themeContext.ts.
- Dashboard queue/activity/manual-import surfaces live under app/src/pages/dashboard/.

## Design system rules
- Use tokens for spacing, colors, borders, radii, shadows, typography, and motion.
- Use px for element sizing (width, height, min, max, column widths).
- Do not hardcode standard colors (red, blue, green); use tokens or brand palette.
- Use Fluent v9 components (Button, Dialog, Input, Switch, etc.).
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

## Tidal images and video covers
Base URL patterns:
- Images: https://resources.tidal.com/images/{id-with-slashes}/{width}x{height}.jpg
- Video covers: https://resources.tidal.com/videos/{id-with-slashes}/{width}x{height}.mp4

Valid sizes:
- Artists (square): 160, 320, 480, 750
- Albums (square): 80, 160, 320, 640, 1280, 3000, origin
- Animated video covers (square): 80, 160, 320, 640, 1280, origin
- Videos (3:2): 160x107, 480x320, 750x500, 1080x720

Notes:
- Invalid sizes return HTTP 403. Always snap to a valid size.
- Helpers live in app/src/utils/tidalImages.ts and related UI components such as MediaCard.
- Album fields: picture, cover, videoCover (UUIDs, may be null).
