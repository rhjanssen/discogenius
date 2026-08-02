import type Database from "better-sqlite3";
import { emitLibraryUpdated } from "../commands/app-events.js";
import { getConfigSection } from "../config/config.js";
import {
  curateLibraryReleases,
  type CanonicalMediumKind,
  type CurationReleaseCandidate,
  type LibraryCurationResult,
} from "./library-curation-planner.js";
import {
  LibraryCurationRepository,
  type CreditedScope,
  type LibraryReleaseScopeInput,
  type LibraryScopeType,
} from "./library-curation-repository.js";
import { AcquisitionPlanningService } from "./acquisition-planning-service.js";
import {
  findUnreachableManualEditionChoices,
  type ManualEditionChoiceAlbum,
} from "./artist-coverage-optimizer.js";
import {
  buildRecordingCoverageUnitMap,
  editionExplicitLabelScore,
  editionExplicitPreferenceRank,
  mapRecordingsToCoverageUnits,
} from "./recording-coverage-units.js";
import { planExplicitPreferenceRank } from "./acquisition-plan-optimizer.js";
import {
  getMusicBrainzReleaseGroupIncludeDecision,
  parseMusicBrainzSecondaryTypes,
} from "../metadata/musicbrainz-release-group-filter.js";

interface LibraryPolicyRow {
  id: number;
  allowed_source_formats: string;
}

interface LibraryArtistRow {
  library_artist_id: number;
  artist_id: number;
  credited_scope: CreditedScope;
}

interface ReleaseRow {
  edition_id: number;
  release_group_id: number;
  primary_artist_id: number | null;
  primary_type: string | null;
  secondary_types: string | null;
  status: string | null;
  country: string | null;
  date: string | null;
  media_count: number | null;
  media: string | null;
  title: string | null;
  disambiguation: string | null;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

/**
 * Settings → Filters is the single authority for which release types enter
 * curation. MetadataProfiles.release_type_policy is not a second user-facing
 * config — libraries point at a profile for schema/FK reasons, but type toggles
 * live only under settings.filtering (same pattern as quality: Settings write
 * the profile row, users never edit two disconnected knobs).
 */
function releaseIncluded(release: ReleaseRow): boolean {
  return getMusicBrainzReleaseGroupIncludeDecision({
    primary_type: release.primary_type,
    secondary_types: release.secondary_types,
  }, getConfigSection("filtering")).include;
}

/**
 * Compilations / remix dumps / DJ mixes sort after normal albums so set-cover
 * prefers the studio products that already own the recordings.
 */
function secondaryTypeRankFor(secondaryTypes: string | null): number {
  const secondary = parseMusicBrainzSecondaryTypes(secondaryTypes);
  let rank = 0;
  if (secondary.includes("compilation")) rank = Math.max(rank, 3);
  if (secondary.includes("dj-mix") || secondary.includes("mixtape/street")) rank = Math.max(rank, 3);
  if (secondary.includes("remix")) rank = Math.max(rank, 2);
  if (secondary.includes("live") || secondary.includes("soundtrack")) rank = Math.max(rank, 1);
  return rank;
}

function mediumKind(value: string | null): CanonicalMediumKind {
  const media = String(value || "").toLowerCase();
  if (/digital|download|stream/.test(media)) return "digital";
  if (/\bcd\b|compact disc/.test(media)) return "cd";
  if (/vinyl|12"|10"|7"/.test(media)) return "vinyl";
  return "other";
}

/** True when the edition targets a preferred market (world / US / GB). */
function isPreferredCountry(country: string | null): boolean {
  const raw = String(country || "").trim();
  if (!raw) return true;
  let tokens: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    tokens = Array.isArray(parsed) ? parsed.map(String) : [raw];
  } catch {
    tokens = raw.split(/[;,]/);
  }
  const preferred = new Set(["xw", "xe", "us", "gb", "uk"]);
  return tokens.some((token) => preferred.has(token.trim().toLowerCase()));
}

export class LibraryCurationService {
  private readonly repository: LibraryCurationRepository;
  private readonly acquisitionPlanning: AcquisitionPlanningService;

  constructor(private readonly db: Database.Database) {
    this.repository = new LibraryCurationRepository(db);
    this.acquisitionPlanning = new AcquisitionPlanningService(db);
  }

  curateLibrary(input: {
    libraryId: number;
    curationVersion: number;
    acquisitionPlannerVersion: number;
    providerPriority: readonly string[];
  }): LibraryCurationResult {
    const library = this.db.prepare(`
      SELECT
        library.id,
        quality.allowed_source_formats
      FROM Libraries library
      JOIN quality_profiles quality ON quality.id = library.quality_profile_id
      WHERE library.id = ? AND library.enabled = 1
    `).get(input.libraryId) as LibraryPolicyRow | undefined;
    if (!library) throw new Error(`Enabled library ${input.libraryId} was not found`);
    // Settings → Filters owns these toggles (not MetadataProfiles columns).
    const filtering = getConfigSection("filtering");
    const requireProviderAvailability = filtering.require_provider_availability === true;

    const libraryArtists = this.db.prepare(`
      SELECT
        library_artist.id AS library_artist_id,
        managed.artist_id,
        library_artist.credited_scope
      FROM LibraryArtists library_artist
      JOIN ManagedArtists managed ON managed.id = library_artist.managed_artist_id
      WHERE library_artist.library_id = ? AND library_artist.monitored = 1
      ORDER BY library_artist.id
    `).all(input.libraryId) as LibraryArtistRow[];
    const releases = this.db.prepare(`
      SELECT
        release.id AS edition_id,
        release.release_group_id,
        release_group.artist_metadata_id AS primary_artist_id,
        release_group.primary_type,
        release_group.secondary_types,
        release.status,
        release.country,
        release.date,
        release.media_count,
        release.media,
        release.title,
        release.disambiguation
      FROM AlbumEditions release
      JOIN Albums release_group ON release_group.id = release.release_group_id
      ORDER BY release.release_group_id, release.id
    `).all() as ReleaseRow[];
    // Clean/explicit counterparts are distinct MusicBrainz recordings. Collapse
    // them to one coverage unit so prefer_explicit can keep one edition instead
    // of both twins for "full discography" coverage.
    const coverageUnitByRecording = buildRecordingCoverageUnitMap(
      (this.db.prepare(`
        SELECT recording_id AS recordingId, title, length_ms AS lengthMs
        FROM Tracks
        WHERE recording_id IS NOT NULL
      `).all() as Array<{ recordingId: number; title: string; lengthMs: number | null }>),
    );
    const preferExplicit = filtering.prefer_explicit !== false;
    const allowedQualities = parseStringArray(library.allowed_source_formats);
    const qualityPlaceholders = allowedQualities.map(() => "?").join(",");
    // Editions automation may not drop: the user picked them, or their Album is
    // locked. The lock is read from LibraryAlbums — the one place it lives.
    //
    // The two reasons are kept apart because they are not equally absolute. A
    // lock is unconditional. A manual edition choice is a preference, and it is
    // withdrawn in exactly one case: when honouring it would lose canonical
    // recordings the rest of the discography cannot supply (see
    // findUnreachableManualEditionChoices below).
    const protectionRows = this.db.prepare(`
      SELECT
        monitored_edition.edition_id,
        edition.release_group_id,
        COALESCE(library_album.locked, 0) AS locked,
        monitored_edition.selection_mode
      FROM LibraryEditions monitored_edition
      JOIN AlbumEditions edition ON edition.id = monitored_edition.edition_id
      LEFT JOIN LibraryAlbums library_album
        ON library_album.library_id = monitored_edition.library_id
       AND library_album.release_group_id = edition.release_group_id
      WHERE monitored_edition.library_id = ?
        AND (COALESCE(library_album.locked, 0) = 1
             OR monitored_edition.selection_mode = 'manual')
    `).all(input.libraryId) as Array<{
      edition_id: number;
      release_group_id: number;
      locked: number;
      selection_mode: string;
    }>;
    const protectedReleaseIds = new Set(protectionRows.map((row) => row.edition_id));
    // Manual choices that a lock is NOT already protecting — the only ones
    // coverage may overrule.
    const overrulableManualEditions = protectionRows.filter(
      (row) => row.locked === 0 && row.selection_mode === "manual",
    );
    const manualEditionIdsByAlbum = new Map<number, Set<number>>();
    for (const row of overrulableManualEditions) {
      const editionIds = manualEditionIdsByAlbum.get(row.release_group_id) || new Set<number>();
      editionIds.add(row.edition_id);
      manualEditionIdsByAlbum.set(row.release_group_id, editionIds);
    }

    const candidateScopes = new Map<number, LibraryReleaseScopeInput[]>();
    if (libraryArtists.length > 0) {
      const scopeRows = this.db.prepare(`
        SELECT DISTINCT
          release.id AS edition_id,
          library_artist.id AS library_artist_id,
          'primary' AS scope_type
        FROM LibraryArtists library_artist
        JOIN ManagedArtists managed ON managed.id = library_artist.managed_artist_id
        JOIN Albums release_group ON release_group.artist_metadata_id = managed.artist_id
        JOIN AlbumEditions release ON release.release_group_id = release_group.id
        WHERE library_artist.library_id = ? AND library_artist.monitored = 1

        UNION

        SELECT DISTINCT
          release.id,
          library_artist.id,
          'primary'
        FROM LibraryArtists library_artist
        JOIN ManagedArtists managed ON managed.id = library_artist.managed_artist_id
        JOIN ReleaseGroupArtistCredits credit
          ON credit.artist_id = managed.artist_id AND credit.ordinal = 0
        JOIN AlbumEditions release ON release.release_group_id = credit.release_group_id
        WHERE library_artist.library_id = ? AND library_artist.monitored = 1

        UNION

        SELECT DISTINCT
          credit.edition_id,
          library_artist.id,
          'release_credit'
        FROM LibraryArtists library_artist
        JOIN ManagedArtists managed ON managed.id = library_artist.managed_artist_id
        JOIN ReleaseArtistCredits credit ON credit.artist_id = managed.artist_id
        WHERE library_artist.library_id = ?
          AND library_artist.monitored = 1
          AND library_artist.credited_scope IN ('release_credit', 'release_and_track_credit')

        UNION

        SELECT DISTINCT
          track.album_edition_id,
          library_artist.id,
          'track_credit'
        FROM LibraryArtists library_artist
        JOIN ManagedArtists managed ON managed.id = library_artist.managed_artist_id
        JOIN TrackArtistCredits credit ON credit.artist_id = managed.artist_id
        JOIN Tracks track ON track.id = credit.track_id
        WHERE library_artist.library_id = ?
          AND library_artist.monitored = 1
          AND library_artist.credited_scope = 'release_and_track_credit'
      `).all(
        input.libraryId,
        input.libraryId,
        input.libraryId,
        input.libraryId,
      ) as Array<{
        edition_id: number;
        library_artist_id: number;
        scope_type: LibraryScopeType;
      }>;
      for (const row of scopeRows) {
        const scopes = candidateScopes.get(row.edition_id) || [];
        scopes.push({
          editionId: row.edition_id,
          libraryArtistId: row.library_artist_id,
          scopeType: row.scope_type,
          reason: `canonical_${row.scope_type}`,
        });
        candidateScopes.set(row.edition_id, scopes);
      }
    }

    const attainableByRelease = new Map<number, Set<number>>();
    if (allowedQualities.length > 0) {
      // Per-track quality only. A release-level spatial (Atmos) flag must not
      // make every member attainable — e.g. a stereo-only remix on a deluxe
      // that also has Atmos for the main tracks. That wrongly kept the deluxe
      // monitored in the Spatial library for a remix Atmos cannot deliver.
      // Release-level quality is used only when the track has no variants of its
      // own (providers that only declare quality on the album resource).
      const attainableRows = this.db.prepare(`
        SELECT DISTINCT release_match.edition_id, track_match.recording_id
        FROM ProviderEditionMatches release_match
        JOIN ProviderTrackMatches track_match
          ON track_match.provider_edition_match_id = release_match.id
         AND track_match.match_state = 'accepted'
         AND track_match.track_id IS NOT NULL
        JOIN ProviderEditionMembers member
          ON member.id = track_match.provider_edition_member_id
        WHERE release_match.match_state = 'accepted'
          AND (
            EXISTS (
              SELECT 1 FROM ProviderItemAudioVariants variant
              WHERE variant.provider_item_id = member.member_item_id
                AND variant.quality_class IN (${qualityPlaceholders})
                AND variant.availability NOT IN (
                  'unavailable', 'no_longer_available', 'geography_restricted',
                  'entitlement_restricted', 'explicit_policy_ineligible', 'quality_unavailable'
                )
            )
            OR (
              NOT EXISTS (
                SELECT 1 FROM ProviderItemAudioVariants any_track
                WHERE any_track.provider_item_id = member.member_item_id
              )
              AND EXISTS (
                SELECT 1 FROM ProviderItemAudioVariants variant
                WHERE variant.provider_item_id = release_match.provider_edition_item_id
                  AND variant.quality_class IN (${qualityPlaceholders})
                  AND variant.availability NOT IN (
                    'unavailable', 'no_longer_available', 'geography_restricted',
                    'entitlement_restricted', 'explicit_policy_ineligible', 'quality_unavailable'
                  )
              )
            )
          )
      `).all(...allowedQualities, ...allowedQualities) as Array<{
        edition_id: number;
        recording_id: number;
      }>;
      for (const row of attainableRows) {
        const recordingIds = attainableByRelease.get(row.edition_id) || new Set<number>();
        recordingIds.add(row.recording_id);
        attainableByRelease.set(row.edition_id, recordingIds);
      }
    }

    // Every canonical Edition this library could conceivably monitor: in an
    // artist scope and allowed by Settings → Filters. Provider coverage is
    // deliberately NOT a filter here — an Edition with no offer still has to be
    // evaluated, planned and offered, it just will not be picked automatically.
    const evaluatedEditions = releases.filter((release) =>
      releaseIncluded(release)
      && (candidateScopes.get(release.edition_id) || []).length > 0);

    // Plan BEFORE curating. Curation needs to weigh what a provider can actually
    // deliver, and the Album page needs offers under Editions curation passes
    // over, so plans cannot wait for the monitoring decision that follows them.
    for (const release of evaluatedEditions) {
      this.acquisitionPlanning.compute({
        libraryId: input.libraryId,
        editionId: release.edition_id,
        providerPriority: input.providerPriority,
        plannerVersion: input.acquisitionPlannerVersion,
      });
    }

    const viableEditionIds = this.viablePlanEditionIds(input.libraryId);
    // Best plan already computed above — use its explicitness so two equal-size
    // "explicit" editions (GMTF #348 vs #350) prefer the one whose provider
    // product is actually explicit rather than a full clean Atmos stream.
    const bestPlanByEdition = new Map<number, {
      explicit_content: string;
      coverage: number;
      quality_tier: string;
    }>();
    for (const row of this.db.prepare(`
      SELECT edition_id, explicit_content, coverage, quality_tier
      FROM AcquisitionPlans
      WHERE library_id = ? AND rank = 0
    `).all(input.libraryId) as Array<{
      edition_id: number;
      explicit_content: string;
      coverage: number;
      quality_tier: string;
    }>) {
      bestPlanByEdition.set(row.edition_id, row);
    }
    // The set curation is trying to cover. With provider availability required
    // it is what a provider can actually deliver; without it the canonical
    // Recording set is the target, because an Edition with no offer at all is
    // still a legitimate thing to monitor — it simply has nothing to execute.
    const canonicalByRelease = requireProviderAvailability
      ? null
      : this.canonicalRecordingIdsByEdition();
    const candidates: CurationReleaseCandidate[] = [];
    for (const release of evaluatedEditions) {
      const rawAttainable = (canonicalByRelease ?? attainableByRelease)
        .get(release.edition_id) || new Set<number>();
      const attainableRecordingIds = mapRecordingsToCoverageUnits(
        rawAttainable,
        coverageUnitByRecording,
      );
      // With provider availability required, only an Edition a provider can
      // actually deliver is eligible for automatic monitoring. Without it, any
      // canonical Edition may be monitored and simply has no plan to execute.
      const eligible = requireProviderAvailability
        ? viableEditionIds.has(release.edition_id)
        : true;
      if (!eligible && !protectedReleaseIds.has(release.edition_id)) continue;
      const labelScore = editionExplicitLabelScore(release.title, release.disambiguation);
      const labelRank = editionExplicitPreferenceRank(labelScore, preferExplicit);
      const bestPlan = bestPlanByEdition.get(release.edition_id);
      const planRank = bestPlan
        ? planExplicitPreferenceRank(
          bestPlan.explicit_content === "explicit" || bestPlan.explicit_content === "clean"
            || bestPlan.explicit_content === "unknown"
            ? bestPlan.explicit_content
            : "unknown",
          preferExplicit,
        )
        : 1;
      // Plan explicitness outranks the MusicBrainz disambiguation label when
      // both editions claim "explicit" but only one has an explicit provider plan.
      const explicitPreferenceRank = planRank * 3 + labelRank;
      candidates.push({
        releaseGroupId: release.release_group_id,
        editionId: release.edition_id,
        attainableRecordingIds,
        official: !release.status || release.status.toLowerCase() === "official",
        medium: mediumKind(release.media),
        preferredCountry: isPreferredCountry(release.country),
        mediaCount: Math.max(1, Number(release.media_count || 1)),
        releaseDate: release.date,
        explicitPreferenceRank,
        secondaryTypeRank: secondaryTypeRankFor(release.secondary_types),
        protected: protectedReleaseIds.has(release.edition_id),
      });
    }

    // A locked Album's edition set is the user's, so automation may not add to it
    // either: only its already-monitored editions stay in the running.
    const lockedAlbumIds = new Set(
      protectionRows.filter((row) => row.locked === 1).map((row) => row.release_group_id),
    );
    const monitoredEditionIds = new Set(protectionRows.map((row) => row.edition_id));
    const eligibleCandidates = candidates.filter((candidate) =>
      !lockedAlbumIds.has(candidate.releaseGroupId)
      || monitoredEditionIds.has(candidate.editionId));

    // A manual edition choice survives unless it costs the discography canonical
    // recordings nothing else supplies.
    const overruledReleaseGroupIds = this.overruledManualEditionAlbums({
      overrulableManualEditions,
      candidates: eligibleCandidates,
      coverageUnitByRecording,
    });
    // Where the choice stands, the editions the user declined leave the running
    // entirely. Otherwise the fewest-releases optimizer would reach for the
    // deluxe as a cheap cover and monitor it alongside the standard, which is
    // the outcome the preference exists to avoid — the point is that curation
    // goes and monitors the singles instead.
    const curatedCandidates = eligibleCandidates.filter((candidate) => {
      const manualEditionIds = manualEditionIdsByAlbum.get(candidate.releaseGroupId);
      if (!manualEditionIds) return true;
      if (overruledReleaseGroupIds.has(candidate.releaseGroupId)) return true;
      return manualEditionIds.has(candidate.editionId);
    });
    for (const candidate of curatedCandidates) {
      if (!overruledReleaseGroupIds.has(candidate.releaseGroupId)) continue;
      candidate.protected = false;
    }

    // Settings → "Hide redundant singles" is the only redundancy switch.
    const redundancyEnabled = filtering.enable_redundancy_filter !== false;
    const result = curateLibraryReleases(
      curatedCandidates,
      redundancyEnabled,
    );

    const releaseGroupIdByReleaseId = new Map(
      curatedCandidates.map((candidate) => [candidate.editionId, candidate.releaseGroupId]),
    );
    const selectedScopes = result.selectedReleaseIds.flatMap((editionId) =>
      candidateScopes.get(editionId) || []);
    // Curation is the only step that writes monitoring. Everything above it —
    // metadata refresh, provider matching, plan generation — left the Library
    // tables alone.
    this.repository.replaceAutomaticCuration({
      libraryId: input.libraryId,
      result,
      releaseGroupIdByReleaseId,
      scopes: selectedScopes,
      curationVersion: input.curationVersion,
      // Overruling a deliberate choice is never silent; the row says so.
      reasonByReleaseGroupId: new Map(
        [...overruledReleaseGroupIds].map((releaseGroupId) =>
          [releaseGroupId, "curation_override_unreachable_recordings"] as const),
      ),
    });

    // Newly monitored Editions had no row when they were planned, so nothing
    // recorded which plan they execute. Re-resolve the selection for those.
    for (const editionId of result.selectedReleaseIds) {
      this.acquisitionPlanning.compute({
        libraryId: input.libraryId,
        editionId,
        providerPriority: input.providerPriority,
        plannerVersion: input.acquisitionPlannerVersion,
      });
    }
    emitLibraryUpdated({
      reason: "library-curated",
      libraryIds: [input.libraryId],
    });
    return result;
  }

  /**
   * Albums whose manual edition choice automation may overrule.
   *
   * The question is *reachability*, not what a previous pass happened to pick:
   * could the rest of this artist's discography supply the recordings the
   * declined edition carries? Every eligible edition of every other album counts,
   * because curation is free to monitor those instead — and where it can, the
   * user's choice stands and curation goes and does exactly that.
   *
   * Comparison is by canonical Recording identity across the discography. Track
   * counts are never compared: two twelve-track editions carrying different
   * recordings are not interchangeable, and a numeric test would call them equal.
   */
  private overruledManualEditionAlbums(input: {
    overrulableManualEditions: ReadonlyArray<{ edition_id: number; release_group_id: number }>;
    candidates: readonly CurationReleaseCandidate[];
    coverageUnitByRecording: ReadonlyMap<number, number>;
  }): Set<number> {
    if (input.overrulableManualEditions.length === 0) return new Set();

    const canonicalByEdition = this.canonicalRecordingIdsByEdition();
    const unitsForEdition = (editionId: number): Set<number> =>
      mapRecordingsToCoverageUnits(
        canonicalByEdition.get(editionId) || new Set(),
        input.coverageUnitByRecording,
      );
    const manualEditionIdsByAlbum = new Map<number, Set<number>>();
    for (const row of input.overrulableManualEditions) {
      const editionIds = manualEditionIdsByAlbum.get(row.release_group_id) || new Set<number>();
      editionIds.add(row.edition_id);
      manualEditionIdsByAlbum.set(row.release_group_id, editionIds);
    }

    const candidatesByAlbum = new Map<number, CurationReleaseCandidate[]>();
    for (const candidate of input.candidates) {
      const list = candidatesByAlbum.get(candidate.releaseGroupId) || [];
      list.push(candidate);
      candidatesByAlbum.set(candidate.releaseGroupId, list);
    }

    const overruled = new Set<number>();
    for (const [releaseGroupId, manualEditionIds] of manualEditionIdsByAlbum) {
      const chosenRecordingIds = new Set<number>();
      for (const editionId of manualEditionIds) {
        for (const unitId of unitsForEdition(editionId)) {
          chosenRecordingIds.add(unitId);
        }
      }
      // Only editions curation considers eligible count as alternatives. One no
      // provider can deliver was never a choice that was passed over.
      const alternativeRecordingIds = new Set<number>();
      for (const candidate of candidatesByAlbum.get(releaseGroupId) || []) {
        if (manualEditionIds.has(candidate.editionId)) continue;
        for (const unitId of unitsForEdition(candidate.editionId)) {
          alternativeRecordingIds.add(unitId);
        }
      }
      // Everything the rest of the discography could supply. An album cannot
      // supply its own missing recordings, so it is excluded from its own test.
      const reachableRecordingIds = new Set<number>();
      for (const [otherAlbumId, otherCandidates] of candidatesByAlbum) {
        if (otherAlbumId === releaseGroupId) continue;
        for (const candidate of otherCandidates) {
          for (const unitId of unitsForEdition(candidate.editionId)) {
            reachableRecordingIds.add(unitId);
          }
        }
      }

      const [overrule] = findUnreachableManualEditionChoices({
        albums: [{ releaseGroupId, chosenRecordingIds, alternativeRecordingIds }],
        reachableRecordingIds,
      });
      if (!overrule) continue;
      overruled.add(overrule.releaseGroupId);
      console.warn(
        `[LibraryCuration] Overruling the manual edition choice for release group `
        + `${overrule.releaseGroupId}: ${overrule.unreachableRecordingIds.length} canonical `
        + `recording(s) are reachable through no other release in this discography `
        + `(${overrule.unreachableRecordingIds.slice(0, 10).join(", ")})`,
      );
    }
    return overruled;
  }

  /** The complete canonical Recording set of every Edition. */
  private canonicalRecordingIdsByEdition(): Map<number, Set<number>> {
    const byEdition = new Map<number, Set<number>>();
    for (const row of this.db.prepare(`
      SELECT album_edition_id, recording_id FROM Tracks
    `).all() as Array<{ album_edition_id: number; recording_id: number }>) {
      const recordingIds = byEdition.get(row.album_edition_id) || new Set<number>();
      recordingIds.add(row.recording_id);
      byEdition.set(row.album_edition_id, recordingIds);
    }
    return byEdition;
  }

  /**
   * Editions with at least one plan that delivers something.
   *
   * A single matched track is not a useful offer; requiring full coverage would
   * reject an otherwise perfect 19-of-20 deluxe. The line is drawn at a plan
   * that covers the whole canonical Edition, or is the best any provider can do
   * while still covering a majority of it.
   */
  private viablePlanEditionIds(libraryId: number): Set<number> {
    return new Set(
      (this.db.prepare(`
        SELECT DISTINCT edition_id
        FROM AcquisitionPlans
        WHERE library_id = ?
          AND state = 'current'
          AND target_track_count > 0
          AND coverage * 2 > target_track_count
      `).all(libraryId) as Array<{ edition_id: number }>).map(({ edition_id }) => edition_id),
    );
  }
}
