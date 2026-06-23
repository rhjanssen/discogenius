# Release-centric provider matching (remove the release-group constraint)

Status: **partially implemented; remaining matcher refactor is pending**

Current implemented state:
- ISRC-first composite track coverage (title/shape fallback for Servarr Metadata Server).
- Composite matches are now **first-class persisted `ProviderItemMatches` rows**
  (`persistCompositeReleaseMatches`), not a read-time recompute — the
  availability layer reads them and `appendStrictCompositeCoverage` is deleted.
- Slot selection picks the largest covered release per slot from the availability
  graph (direct + composite), covering core + collaborative release groups. This
  is still release-group scoped and is not yet the final artist-wide coverage
  optimizer.

Remaining:
- Refactor `provider-release-group-matcher` so a provider album matches an MB
  **release** directly (release group only as a fetch container).
- **External-link tier** (tier 1) via the local musicbrainz-docker DB.
- Optional: only re-persist composites for groups whose provider albums changed
  (today `persistCompositeReleaseMatchesForArtist` re-runs all groups per sync).
- Artist-wide release/recording coverage optimizer before final slot selection.

## The problem

Provider matching is currently **release-group-constrained**. `scoreAlbumAgainstReleaseGroup`
(`provider-release-group-matcher.ts`) pairs **one** provider album with **one** MB release
group's releases. Consequences:

- A provider album can only match releases in the group it was handed. Release groups don't
  exist at the provider level, so this constraint is artificial.
- A **composite** (a *set* of provider albums whose combined identity covers one MB release)
  cannot be expressed at the matching level. It's faked downstream in
  `provider-matches.ts › appendStrictCompositeCoverage` using title+duration only, purely for
  the availability/UI read — it never becomes a real match and never drives selection.
- Result: the 3-track MB release `fab7ff68` (coverable only by combining two TIDAL albums
  matched to two *different* groups) is never selected; curation keeps both smaller groups
  monitored instead of the one composite release. (A reconciliation "promotion" pass was
  prototyped and **reverted** — it papered over the constraint instead of removing it.)

## Target model: match provider album → MB release, directly

Matching iterates the artist's **MB releases** (release groups are only a fetch container).
For each provider album, score against every candidate release using these tiers, highest
priority first:

1. **External streaming links** — MB release `externalUrls` matching the provider resource id.
   Requires the local musicbrainz-docker integration to carry URL relations; Servarr Metadata Server strips
   them (see [[discogenius-matching-facts]]). Highest confidence when present.
2. **UPC / ISRC**
   - Direct: provider UPC == release barcode, or provider ISRC set ⊇ release ISRC set.
   - **Composite**: a set of provider albums whose **combined ISRC set is a 1:1 match** to the
     release's ISRC set → one composite match to that release.
3. **Title + shape** — release title/disambiguation vs provider title, plus track/volume shape.
   - **Composite**: a set of provider albums whose combined title/shape 1:1-covers the
     release's tracks (the existing `appendStrictCompositeCoverage` logic, promoted to a real
     match). This is the **only** tier available in servarr-metadata-proxy mode.

Each match (direct or composite) persists as `ProviderItemMatches` edges:
`musicbrainz_release_mbid` ← one provider album (direct) or a `;`-joined provider album set
(composite), with `method` recording the tier used.

## Selection & monitoring (release-centric)

Once matches are release-level, selection should be artist-wide rather than
purely release-group local:

- For each library slot, build the artist's matched MB releases from direct and
  composite `ProviderItemMatches`.
- Apply release-type, secondary-type, explicit/clean, spatial/video, and
  library-type settings before coverage solving, so excluded releases never
  become optimizer candidates.
- Compute recording coverage for each candidate release using MB recording MBID
  first, ISRC second, and title/duration/position shape only as a fallback.
- Choose the release set that covers the filtered artist discography with the
  fewest releases/provider downloads and the least redundant overlap.
- Within equivalent coverage, prefer better quality, explicit/clean preference,
  stronger evidence, and then larger/more complete editions.
- Write the resulting per-release-group `ReleaseGroupSlots` selections.

This makes the band-aid unnecessary: selection reads real matches, not a dynamic
recompute. It also avoids treating "largest track count inside each release
group" as the global objective.

Example target behavior: if a release group has a 20-track edition and a
25-track edition, but the 20-track edition plus one EP covers the artist's
recordings while the 25-track edition forces five singles or leaves recordings
unavailable, the optimizer should pick the 20-track edition plus the EP.

## Steps

1. **Matcher**: refactor `provider-release-group-matcher.ts` to score a provider album against
   the artist's candidate **releases** (flatten the group→releases container). Keep the tier
   functions; drop the per-group iteration unit.
2. **Composite matching**: add ISRC-set exact-cover and title/shape exact-cover composite
   detection over the artist's provider albums per release (reuse `findExactCover` /
   `chooseStrictComposites` from `provider-matches.ts`, but on ISRC first, title/shape
   fallback). Persist composites via `upsertProviderReleaseMatch` with a composite provider id.
3. **Drop** the dynamic `appendStrictCompositeCoverage` recompute once composites are real
   matches (or keep it only as a Servarr Metadata Server-mode fallback).
4. **Selection**: replace per-group `selectReleaseMbidForCandidate` with
   artist-wide release selection from persisted matches. Apply user filters
   before solving coverage. Track count should be a tie-breaker after
   coverage/cost, not the first global objective.
5. **Tests**: ISRC-composite, title/shape-composite, external-link priority, the
   least-releases curation outcome (the Bastille MTV Unplugged case:
   `b1b81699`→`fab7ff68`, `ac94d434` dropped), and a regression where the
   largest edition in one release group produces worse artist-wide recording
   coverage than a smaller edition plus one EP.

## Local-MB integration note

Tier 1 (external links) and richer ISRC/UPC depend on the musicbrainz-docker DB (port per
`.ref_musicbrainz-docker`; the UI on `:5000` is the web front, the DB is a different port).
