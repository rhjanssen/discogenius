# Discogenius Roadmap

_Last updated: 2026-06-11_

This roadmap is intentionally short and forward-looking. Architecture
current-state detail lives in [ARCHITECTURE.md](ARCHITECTURE.md).

## 2.0 priorities

1. Stabilize the core library workflow:
   - all TIDAL downloads (audio, Atmos, video) through tiddl
   - queue, import, organize, and retry behavior
   - reliable MusicBrainz ↔ provider release matching
2. Tighten library management:
   - better rename and retag maintenance flows
   - clearer monitoring and lock behavior
   - stronger reconciliation between disk state and database state
3. Improve manual import quality:
   - better identification confidence and fallback paths
   - smoother review and mapping UX for unmapped files
4. Ship a clean public release:
   - concise docs
   - reliable Docker deployment story
   - versioned public releases and images

## Near-term product work

- Faster and more predictable artist, album, and dashboard pages while
  background jobs are running.
- Better activity visibility for queued maintenance, imports, and retries.
- More polish around mobile layouts and queue/status presentation.

## Longer-term direction

- Additional streaming providers (Qobuz, Deezer, Apple Music) behind the
  existing provider interface, using MusicBrainz release groups and
  ISRC/recording MBIDs as cross-provider matching keys.
- More robust import decision logic and fingerprint-assisted identification.
- Additional library-maintenance tooling once the 2.0 workflow is stable.
