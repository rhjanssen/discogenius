# Recording-centric matching, coverage & deduplication

Status: **per-edition set cover shipped** in
`api/src/services/music/acquisition-plan-optimizer.ts` (minimum set cover plus
dominance pruning). Artist-wide coverage (which release groups to keep) is still
open; see `docs/TASKS.md`.

Recording-centric matching, coverage, and dedup. This replaced ad-hoc
release-group matching plus bolted-on exceptions with one set-based method.


## 0. Why

Today matching is a three-stage pipeline that keeps accreting special cases:

1. **Match** provider albums → MusicBrainz release groups/releases (album-side,
   fuzzy special-cases baked in: version-awareness, shape-lock, title-expansion).
2. **Select** sources for a library edition (acquisition plan, not a
   stereo/spatial/video slot on the release group).
3. **Dedup** (`CurationService.findReleaseGroupsContainedByAlbums`) — already
   recording-centric greedy containment, but sorted **largest-release-first**,
   which can keep a compilation and drop the original album.

Each new edge case (the Bakermat remix, Servarr-mode-without-UPC, the Bastille
composite) has been a new branch. This document proposes **one methodology** that
makes those cases fall out for free.

## 1. The atoms (identical across every source)

| Concept | Identity key | Notes |
|---|---|---|
| **Recording** | **ISRC** (MB: recording MBID) | a unique master/performance of a song — the atom |
| **Release** | **UPC/barcode** (MB: release MBID) | an ordered list of tracks |
| **Track** | `(release, medium, position) → recording` | a recording appears on *many* tracks/releases |
| **Release group** (MB only) | — | the set of releases that are "the same album" |
| **Provider track id** | — | `(provider album, position) → recording`; one provider may carry several track ids sharing one ISRC |

**The only universal join keys are ISRC (recording) and UPC (release).** Everything
else is fuzzy. ISRC/UPC are present on TIDAL, Apple Music, Spotify, Deezer; absent
on YouTube Music (and stripped by Servarr/Skyhook on the MB side). So a fuzzy
fallback is mandatory, and *all* matching complexity should live in one fuzzy
scorer — nowhere else.

## 2. The pipeline

```
A. Identity resolution   provider track  ⇄  MB recording      (ISRC first, one Distance scorer as fallback)
B. Discography set       wanted recordings = filter(all artist recordings)   (type/explicit/availability filters)
C. Coverage assignment   each wanted recording → its best carrier (release, provider-offer)
D. Materialize           keep a release iff it is the chosen carrier for ≥1 recording
```

Matching, slot selection, redundancy, partial matches and the composite case are
all consequences of A–D. No stage-specific exceptions.

### A. Identity resolution — one scorer, Lidarr-style

Port Lidarr's `Distance` model (`.ref_lidarr/.../Identification/Distance.cs` +
`DistanceCalculator.cs`): a single normalized 0..1 distance accumulated from named
penalties, thresholded once.

- **Exact tier:** ISRC (recording) and UPC (release) short-circuit to distance 0.
- **Fuzzy tier (one function):** `recordingDistance(providerTrack, mbTrack)` =
  weighted blend of cleaned-title distance + duration + medium/position +
  version-compatibility. This *replaces* every ad-hoc title branch. One clean
  title normalizer feeds it (see §5).

### B. The discography set

`wanted = { recordings of the artist } ∩ filters`, where filters are the existing
curation config (`include_album/ep/single/compilation/live/remix/...`, explicit
preference, `require_provider_availability`). A recording is *wanted* if it appears
on at least one release group whose type passes the filters.

### C. Coverage assignment — the core

For each wanted recording `r`, choose the single best **carrier** = a
`(release, provider-offer)` pair that contains `r`, scored by:

```
carrierScore(r, release, offer) =
      canonicalScore(release, r)        // §3 — is this r's real home?
    + providerAvailability(offer)       // do we actually have a source?
    + qualityMatch(offer)               // hi-res / Atmos / explicit vs config
    + editionCompleteness(release)      // prefer the standard complete edition
```

`r` maps to exactly one carrier. Two different recordings may map to two different
releases of the *same* release group — that is fine and expected.

### D. Materialize

A release is **kept** iff it is the chosen carrier for ≥1 recording. Everything
else drops out:

- **Deduplication** is automatic: a recording is carried once, so a
  greatest-hits whose every recording is better-carried elsewhere is kept for
  *nothing* and therefore dropped.
- **Partial coverage** is automatic: if a provider only covers 1 of a release's 4
  recordings, the release is materialized as covering that 1 (and completed later
  if other offers cover the rest — the composite case).

## 3. Canonicalness — and greatest-hits vs real releases

"Canonicalness" answers *"is this release the recording's real home?"* It is a
score, driven mostly by **MusicBrainz release-group types**, which model exactly
the distinction you asked about:

- **Primary type:** `Album` > `EP` > `Single` > `Broadcast` > `Other`.
- **Secondary types are the greatest-hits signal.** A best-of is
  `primaryType=Album, secondaryTypes=[Compilation]`. `Compilation`, `Live`,
  `Remix`, `DJ-mix`, `Mixtape`, `Soundtrack` are **derivative** and score
  *negative* — they gather recordings that live elsewhere.
- **First appearance wins ties:** a recording's canonical home is the
  **earliest, non-derivative** release group it appears on. The original 2012
  single beats a 2019 anniversary reissue beats a 2021 greatest-hits.

```
canonicalScore(release, r) =
      primaryTypeWeight(rg)            // Album 100, EP 80, Single 60, ...
    − derivativePenalty(rg)           // Compilation/Live/Remix/DJ-mix: −80
    − reissueAge(rg, r)               // later first-release-date of the RG r sits in ⇒ small penalty
    + firstAppearanceBonus(rg, r)     // rg is the earliest non-derivative home of r
```

**Distinguishing a greatest-hits from a real release is therefore not a heuristic
on track count — it is the `Compilation` secondary type plus first-appearance.**
The greatest-hits only survives §2.D if it carries a recording that appears on
*no* non-derivative release (a comp-exclusive track), which is exactly when a
library *should* keep it. This also fixes today's "largest-release-first" dedup
sort, which wrongly favours the big compilation.

Provider `type` fields (`ALBUM/SINGLE/EP/COMPILATION`) corroborate the MB types
and are the fallback when the catalog lacks secondary types (Servarr mode).

## 4. Worked examples

### 4a. Bakermat "One Day (Vandaag)" — radio edit vs Oliver $ remix

MB release group `9aad95d9` contains, among others:

| release | tracks | key recording |
|---|---|---|
| `1bdcf41c` (1) | radio edit | `0bf10e9f` |
| `360ec8be` (2) | radio edit + original mix | |
| `122a8e2f` (4) | original mix + **Oliver $ remix** `1ed2fe8d` + Amine Edge + FlicFlac | |

Provider offers: `26891889` (radio-edit single, ISRC `…079` → `0bf10e9f`),
`33923839` (remix single, ISRC `…339` → `1ed2fe8d`; MB has **no** ISRC on
`1ed2fe8d`, so it links by version-aware title).

- **A.** radio-edit track → `0bf10e9f`; remix track → `1ed2fe8d`. Two different
  recordings.
- **C.** `0bf10e9f` → carrier `26891889` @ release `1bdcf41c`. `1ed2fe8d` →
  carrier `33923839` @ release `122a8e2f` (the release that actually contains the
  remix recording).
- **D.** Both singles kept, mapped to *different* releases.

**The remix and the radio edit never compete** — they cover different recordings
and land on different releases. The "wrong album wins" bug is *structurally
impossible* here, without the version-awareness / shape-lock / confidence-ceiling
patches we currently need. That is the whole point: the current code selects one
provider album *per release-group slot*, forcing the remix and radio edit to fight
over one slot; the recording-centric model never creates that fight.

(If remixes are excluded by filter, `1ed2fe8d` is simply not *wanted*, `33923839`
carries nothing, and it drops. Also automatic.)

### 4b. Bastille — 3 recordings across 2 provider albums → 1 MB release

MB release `fab7ff68` has 3 recordings. TIDAL splits them across albums
`290132977` and `287367980`.

- **A.** each of the 3 recordings ← its provider track by ISRC.
- **C.** all 3 → carriers on the *same* release `fab7ff68` (each recording's best
  carrier is the offer that contains it).
- **D.** `fab7ff68` materialized as covered by {`290132977`,`287367980`} — the
  composite. This is today's `strict_composite_track_coverage`, but it is no
  longer a special code path: it is just "several recordings of one release chose
  offers that happen to sit on two provider albums."

## 5. Title consolidation (do first — low risk)

Port Lidarr's "one cleaner + one distance" shape:

- **One** `cleanComparableTitle` (Lidarr `NormalizeTitle`): lowercase, strip
  `feat`, strip bracket/paren *content* and punctuation, drop filler words,
  collapse whitespace. Replaces the "normalize-that-only-strips-feat" and the
  video-word stripper.
- **One** `versionSignature` / `versionsCompatible` (already shared in
  `import-matching-utils`) for when the *version must agree* — this is the only
  reason we keep any version text at all, and it is why we don't need a separate
  "base match" and "base+version match": there is one match, plus a version gate.
- Drop `providerTrackComparableTitle`'s reattach-dance by normalizing the
  provider `version` field into the title **once at ingest**, not at compare time.
- `recordingDistance` (the §A scorer) is the single consumer.

Sequencing: (1) unify the normalizers structurally now behind the current numeric
behavior (tests stay green); (2) collapse to the single Lidarr cleaner as part of
the §A scorer work, gated by a golden-master test set captured from current output
so accuracy/perf don't regress.

## 6. Migration (not a big-bang rewrite)

The pieces already exist; this is consolidation:

1. **Title functions → one module** (§5). Immediate, self-contained.
2. **Extract a `recordingDistance` scorer** (ISRC/UPC exact + one fuzzy blend);
   route the existing track/album matchers through it. Golden-master guard.
3. **Introduce the coverage layer** (§C): `assignCarriers(wantedRecordings,
   offers) → Map<recording, carrier>`; have slot-selection *and* the redundancy
   filter read from it instead of each other. Flip the dedup objective from
   "largest release" to "most-canonical carrier per recording" (§3).
4. The album-side matcher becomes a thin producer of "which recordings does this
   offer cover," feeding the coverage layer.

Aligns with the 3.0 MB-local direction (already recording-centric there).

## 7. Open questions

- **Explicit vs clean:** are these one recording with two masters (different
  ISRCs) or the same recording? Treat as distinct atoms keyed by ISRC and let the
  explicit filter pick — needs a per-provider check (some expose an `explicit`
  flag but reuse the clean ISRC).
- **Provider capability matrix:** §A assumes ISRC/UPC where available; ISRC/UPC
  are present on TIDAL/Apple/Spotify/Deezer, absent on YouTube Music, and gated on
  Amazon, so they must always be optional inputs, never assumed present.
- **Cross-release-group dedup:** a recording on both a single and the album — keep
  both (user wants the single *and* the album) or dedup to the album? Make it a
  filter (`enable_redundancy_filter` already exists); the coverage model supports
  either by whether a single's recording is "already carried."
