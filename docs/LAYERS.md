# Facts, decisions, and search

Discogenius keeps drifting into the same failure, and it has one shape:
**intermediate search results get persisted as if they were facts.** Every
layer that computed possibilities was eventually given a table, and once a
possibility lives in a table something downstream reads it as a statement about
the world.

The concrete instance, measured 2026-08-05: one TIDAL album — `77661290`, the
11-track Hi-Res standard edition of *Back to Black* — carried **fourteen
`accepted` rows** in `ProviderEditionMatches`, one per canonical edition of the
release group (16, 18, 19, 22, 23 and 27 tracks), each marked `source_subset` or
`overlap`. It is not fourteen albums. It is one album that can *supply tracks
to* fourteen editions. Those are different statements, and only the first
belongs in a match table.

Everything that cost this project weeks descends from that single conflation:

| symptom | measured |
|---|---|
| provider albums accepted across >1 release group | 834 |
| provider tracks accepted against >1 recording | 24,359 |
| …of those, spanning incompatible coverage units | 8,738 |
| …traceable to a multi-release-group album match | 4,102 |
| coverage units welding unrelated songs (`Pompeii`+`Oblivion`) | 164 |

The coverage-identity resolver, the ambiguity quarantine and the album-page tab
leak are all downstream of it. Fixing them one at a time treats symptoms.

## The three kinds of row

Ask of every table, and every new column: **is this a fact, a decision, or a
search result?**

### 1. Facts — observed, never inferred

What the catalogue says and what a provider sells.

    Artists, Albums, AlbumEditions, Tracks, Recordings
    ProviderItems, ProviderEditionMembers, ProviderItemAudioVariants

Facts are replaced wholesale when re-fetched. They carry no opinion.

### 2. Decisions — one per question, with provenance

Each decision answers exactly one question, exactly once, and records why.

    ProviderEditionMatches    this provider album IS this canonical edition
    ProviderTrackMatches      this provider member IS this canonical track
    AcquisitionPlans          this is how we will acquire this edition
    LibraryAlbums/LibraryEditions   this is what the library monitors

The invariant that was missing: **a decision must be functional.** One provider
album resolves to one canonical edition. One provider member resolves to one
canonical track. Where the evidence does not support a single answer, the
honest state is `ambiguous` — not several `accepted` rows.

`relation` still earns its place: it describes how well the *one* accepted
identity fits (`exact`, `source_subset`, …). It must never mean "and also these
thirteen others".

### 3. Search results — computed, scoped, discarded

Candidate offers, composite combinations, coverage sets, redundancy analysis.

**None of these get a table.** They are derived on demand from facts and
decisions, scoped to the question being asked, and thrown away.

The rule that keeps it honest:

> If a row can be recomputed from other rows, it must not be authoritative.

A cache is fine. A cache that other code reads as truth is not a cache.

## Why strict matching loses nothing

The fear is that strict matching makes fewer things acquirable. It does the
opposite, because acquisition never needed the cross-links in the first place.

Strict matches produce an **offer index**, derived:

    provider member → canonical track → recording → coverage unit
    + that provider track's audio variants
    = offers, keyed by coverage unit

A plan for any target edition then asks one question — *which offers resolve to
this track's coverage unit?* — and that search is free to cross provider
releases, canonical releases, release groups and artists, because it is a
search and not an identity claim.

**Back to Black.** The Hi-Res standard TIDAL album matches one canonical
edition, strictly. The Lossless deluxe matches another, strictly. Planning the
19-track deluxe finds Max offers for units 1–11 (from the standard album's own
strict match) and High offers for 12–19, and builds an 11 Max + 8 High
composite. If a bonus track also exists as a Hi-Res single, that single's strict
match contributes a third source. Nothing cross-linking is stored; the plan is
the only persisted cross-product.

**Killing Me Softly.** The 3-track canonical edition has no direct provider
album at all. Its three coverage units still have offers — one from the strictly
matched Pompeii album, two from the strictly matched Killing Me Softly album —
so it plans at 3/3, and curation can then drop the Pompeii release group as
redundant. An edition with no provider match is not unattainable.

Both cases work *better* under strict matching, because the planner searches the
whole offer pool rather than only the provider releases someone pre-linked.

## When a direct plan exists

Finding one accepted identity stops further **identity** matching. It does not
stop further **plan** optimisation — otherwise Back to Black stays entirely
Lossless merely because the deluxe source already covers it.

The direct plan is a baseline, not a winner. A composite that raises the quality
histogram may dominate it; whether extra sources are worth it is acquisition
policy, expressed in the plan comparator, never in matching.

## Applying this

When adding anything, place it first:

- A new column on a match table that is not part of the identity decision → it
  belongs in the offer index or the plan.
- A table named after a relationship between two things that are both already
  stored → it is almost certainly a search result.
- A read model recomputing something a service already decided → it will
  eventually disagree; four copies of the plan-quality subquery disagreed twice.

Related: [`ARCHITECTURE.md`](ARCHITECTURE.md),
[`MATCHING_SET_COVER_DESIGN.md`](MATCHING_SET_COVER_DESIGN.md),
[`CURATION_DEDUPLICATION.md`](CURATION_DEDUPLICATION.md).
