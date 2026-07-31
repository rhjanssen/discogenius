# Test suite audit

Audit date: 2026-07-31
Re-verified: 2026-07-31 against the checkout at `565c94d`

## Verified baseline at 565c94d

The counts below were re-measured by running the suite, not carried over from a
commit message.

| Measure | Value |
| --- | ---: |
| Tests reported by the runner | 977 |
| Passing | 967 |
| Failing | 3 |
| Skipped | 7 |

The suite at `565c94d` was **not** green, and the "989/989 passing" figure in the
Codex commit message does not match either the runner or this document. The
three failures were:

- `deleteReleaseGroupLibraryFiles removes disk files and TrackFiles rows`
- `resolve expands candidates from provider release evidence when artist search
  misses the right MB artist`
- `video-query-service.test.ts` — order-dependent; passes on the runner's
  isolated retry

All three are resolved by the follow-up commits on this branch, and the suite has
since grown to 1011 tests with the Library-safe deletion, provider-preference,
shared-extra ownership, and unknown-quality regressions added.

Do not restate a headline count without running the suite that produced it.

## Outcome

The API suite has grown substantially, but the current evidence does not support
deleting tests simply to reduce the headline count.

- The current full runner reports 977 passing tests across 156 `*.test.ts`
  files.
- A broad static scan finds 988 `test()` / `it()` call sites. The difference
  comes from helper/generated call sites that do not each become one runtime
  test.
- There are no duplicate literal test names.
- There are no exact duplicate test bodies after parsing TypeScript and
  normalizing whitespace.
- The clone-flake retry in `api/scripts/run-tests.mjs` does not normally inflate
  the count. It only appends an isolated retry after Node reports
  `Unable to deserialize cloned data`.

The safe conclusion is that the count is mostly real coverage, not the same
suite accidentally running several times.

## Growth

| Ref | Date | Test files | Static test calls |
| --- | --- | ---: | ---: |
| v2.0.0 | 2026-06-11 | 58 | 279 |
| v2.1.0 | 2026-07-02 | 78 | 415 |
| v2.2.0 | 2026-07-05 | 82 | 447 |
| v2.3.0 | 2026-07-09 | 82 | 456 |
| v2.3.4 | 2026-07-15 | 88 | 500 |
| v2.4.0 | 2026-07-20 | 108 | 660 |
| v2.5.0 | 2026-07-21 | 112 | 705 |
| v2.6.0 | 2026-07-22 | 121 | 794 |
| v2.6.4 | 2026-07-23 | 123 | 861 |
| HEAD before this audit | 2026-07-31 | 151 | 948 |
| Working tree after targeted consolidation | 2026-07-31 | 156 | 988 |

Growth from v2.0.0 to HEAD is concentrated in areas that changed materially:

| Area | v2.0.0 | HEAD | Growth |
| --- | ---: | ---: | ---: |
| Provider adapters and contracts | 11 | 194 | +183 |
| Music matching, curation, and acquisition | 77 | 214 | +137 |
| Import and file management | 53 | 177 | +124 |
| Metadata and artwork | 32 | 124 | +92 |
| Command queue | 0 | 43 | +43 |
| Download workflows | 6 | 43 | +37 |
| Canonical catalog providers | 0 | 32 | +32 |

Those seven areas account for nearly all growth and correspond to the
MusicBrainz-first, typed-match, command-queue, multi-provider, and exact-file
identity refactors.

## Higher-risk finding: wrong schema authority

The suite has a more important problem than raw size. These production-service
tests still create the aspirational `domain-v41` schema rather than the active
runtime schema:

- `services/catalog/canonical-catalog-repository.test.ts`
- `services/metadata/media-cover-selection-repository.test.ts`
- `services/music/acquisition-plan-repository.test.ts`
- `services/music/acquisition-planning-service.test.ts`
- `services/music/library-curation-repository.test.ts`
- `services/music/library-curation-service.test.ts`
- `services/music/provider-match-repository.test.ts`
- `services/providers/provider-catalog-repository.test.ts`
- `services/providers/provider-release-ingestion-service.test.ts`

`database-schema-v41.test.ts` also uses `domain-v41`, but correctly: it is the
schema contract test rather than a production-service test.

Re-verified at `565c94d`: this list of nine is accurate and unchanged. Three
further files mention `domain-v41` only in comments explaining why they do *not*
use it (`canonical-manual-import-active-schema.test.ts`,
`canonical-manual-import-service.test.ts`, `import-operation-identity.test.ts`).
The conversions remain outstanding.

The release/provider selection regression test was converted to
`active-schema-fixture.ts` during this audit. The remaining suites should be
converted one table family at a time and gated with TypeScript plus failing-test
name comparison.

## Large suites worth restructuring, not deleting

The largest files are expensive to review because fixtures and behavior are
interleaved:

- `mediafiles/library-files.test.ts` — 1,820 lines / 30 tests
- `metadata/media-cover-service.test.ts` — 1,669 lines / 34 tests
- `mediafiles/rename-track-file-service.test.ts` — 1,332 lines / 22 tests
- `mediafiles/organizer-canonical.test.ts` — 1,031 lines / 14 tests

Shared active-schema fixture builders can reduce their maintenance surface
without deleting distinct behavioral assertions.

The first targeted consolidation reduced
`music/refresh-video-service.test.ts` from 1,287 lines / 26 tests to 558 lines /
11 tests. Detailed title, duration, and variant-scoring assertions already live
in `video-match.test.ts`, `video-variant.test.ts`, and
`refresh-video-support.test.ts`; the service suite now concentrates on
canonical authority, ambiguity, supplement-only updates, active-schema
enforcement, legacy repair, exact-file preservation/rehoming, relations, and
quality facts. The consolidation itself introduced no failures, but note the
verified baseline above: the gate was 967/977 at `565c94d`, not 977/977.

## Policy

1. Do not use a target test count.
2. Remove a test only when its behavior, boundary, and schema authority are all
   covered by another test.
3. Prefer extending an existing focused test over adding a parallel regression
   file. This audit extended the library release-selection test in place.
4. Production services use `active-schema-fixture.ts`; `domain-v41` is reserved
   for schema/domain contract tests.
5. Compare failing test names before and after consolidation, not counts.
