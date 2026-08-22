/**
 * The schema version this build creates and is willing to open.
 *
 * Its own module, with no imports, because the number had been copied into four
 * places — `database.ts`, the health check, the release-hardening generator and
 * its runner — and two of them open a database file directly rather than going
 * through `database.ts`. Bumping 42 → 43 left all four disagreeing, and the
 * copies that assert equality were asserting against a stale literal, which is
 * a check that passes for the wrong reason.
 *
 * There is no migration ladder: Discogenius is pre-1.0 and a version mismatch
 * is a reset, so this is a single number rather than a sequence.
 */
export const BASE_SCHEMA_VERSION = 44;
