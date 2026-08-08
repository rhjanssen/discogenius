import type Database from "better-sqlite3";
import { emitLibraryUpdated } from "../commands/app-events.js";
import { getConfigSection } from "../config/config.js";
import {
  comparePrimaryEditionCandidates,
  curateLibraryReleases,
  type CanonicalMediumKind,
  type CurationEditionCandidate,
  type CurationEditionDecision,
  type CurationEditionRole,
  type CurationSelectionReason,
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
import { loadCoverageUnitsForRecordings } from "./coverage-identity-repository.js";
import { createCurationPhaseTimer } from "./curation-profile.js";
import type { QuarantinedProviderLink } from "./coverage-identity.js";
import { editionRendition, renditionPreferenceRank } from "./rendition-policy.js";
import { mapRecordingsToCoverageUnits } from "./recording-coverage-units.js";
import {
  planExplicitPreferenceRank,
  type PlanExplicitContent,
} from "./acquisition-plan-optimizer.js";
import {
  getMusicBrainzReleaseGroupIncludeDecision,
  isReleaseStatusIncluded,
  parseMusicBrainzSecondaryTypes,
  releaseStatusPreferenceRank,
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
  primary_artist_id: number;
  primary_type: string | null;
  secondary_types: string | null;
  status: string | null;
  country: string | null;
  date: string | null;
  media_count: number | null;
  media: string | null;
  title: string;
  disambiguation: string | null;
}

interface ScopedCurationSelection {
  libraryArtistId: number;
  editionId: number;
  releaseGroupId: number;
  role: CurationEditionRole;
  reason: CurationSelectionReason;
  contributedUnitIds: number[];
  scopeTypes: LibraryScopeType[];
}

/**
 * Split ids into batches small enough for SQLite's parameter limit (999 by
 * default). Scoped passes bind their edition set into `IN (…)` lists, and a
 * library with a few thousand candidate editions would otherwise fail on the
 * bind rather than on anything meaningful.
 */
function chunked<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

function emptyCurationResult(): LibraryCurationResult {
  return {
    representativeEditionIdByReleaseGroup: new Map(),
    supplementalEditionIds: [],
    selectedEditionIds: [],
    selectedReleaseGroupIds: [],
    attainableUnitIds: new Set(),
    decisions: [],
  };
}

function releaseTypeRankFor(primaryType: string | null): number {
  switch (String(primaryType || "").trim().toLowerCase()) {
    case "album":
      return 0;
    case "ep":
      return 1;
    case "single":
      return 2;
    case "broadcast":
      return 3;
    default:
      return 4;
  }
}

export class LibraryCurationService {
  private readonly repository: LibraryCurationRepository;

  constructor(
    private readonly db: Database.Database,
    private readonly acquisitionPlanning: AcquisitionPlanningService = new AcquisitionPlanningService(db),
  ) {
    this.repository = new LibraryCurationRepository(db);
  }

  /**
   * Curate a library, either whole or for named artists.
   *
   * Curation is a *library* decision — selecting one Edition of an album can
   * make a whole other Release Group redundant — but the optimiser has always
   * run once per LibraryArtist over that artist's own candidates, so an
   * artist's decisions never depended on another artist's. Everything before
   * the optimiser was library-wide anyway: it read every AlbumEdition in the
   * database and re-planned every one of them.
   *
   * That is why "curate this artist" cost the same as curating everything.
   * Three CurateArtist commands sat at 10% for twenty-five minutes with the
   * oldest heartbeat 294s into a 300s lease, and one of them was a
   * single-album artist. The work was never proportional to the artist.
   *
   * `scope` narrows the inputs to the same set the optimiser was going to use.
   * Unscoped is unchanged: every monitored artist in the library, which is what
   * ApplyCuration and the settings-change rebuild still want.
   */
  curateLibrary(input: {
    libraryId: number;
    providerPriority: string[];
    acquisitionPlannerVersion: number;
    curationVersion: number;
    /** Curate only these LibraryArtists. Omit for the whole library. */
    scope?: { libraryArtistIds: readonly number[] };
  }): LibraryCurationResult {
    const library = this.db.prepare(`
      SELECT library.id, quality.allowed_source_formats
      FROM Libraries library
      LEFT JOIN quality_profiles quality ON quality.id = library.quality_profile_id
      WHERE library.id = ?
    `).get(input.libraryId) as LibraryPolicyRow | undefined;
    if (!library) throw new Error(`Library ${input.libraryId} does not exist`);
    const timer = createCurationPhaseTimer();

    const filtering = getConfigSection("filtering");
    const requireProviderAvailability = filtering.require_provider_availability !== false;
    const releaseIncluded = (release: ReleaseRow): boolean => {
      const decision = getMusicBrainzReleaseGroupIncludeDecision(
        { primary_type: release.primary_type, secondary_types: release.secondary_types },
        filtering,
      );
      return decision.include;
    };

    const scopedArtistIds = input.scope
      ? [...new Set(input.scope.libraryArtistIds)].sort((a, b) => a - b)
      : null;
    if (scopedArtistIds && scopedArtistIds.length === 0) {
      return emptyCurationResult();
    }
    const artistFilterSql = scopedArtistIds
      ? ` AND library_artist.id IN (${scopedArtistIds.map(() => "?").join(",")})`
      : "";
    const artistFilterParams = scopedArtistIds ?? [];

    const libraryArtists = this.db.prepare(`
      SELECT
        library_artist.id AS library_artist_id,
        managed.artist_id,
        library_artist.credited_scope
      FROM LibraryArtists library_artist
      JOIN ManagedArtists managed ON managed.id = library_artist.managed_artist_id
      WHERE library_artist.library_id = ? AND library_artist.monitored = 1${artistFilterSql}
      ORDER BY library_artist.id
    `).all(input.libraryId, ...artistFilterParams) as LibraryArtistRow[];

    const preferExplicit = filtering.prefer_explicit !== false;

    const protectionRows = this.db.prepare(`
      SELECT
        monitored_edition.edition_id,
        edition.release_group_id,
        COALESCE(library_album.locked, 0) AS locked,
        monitored_edition.selection_mode,
        monitored_edition.representative
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
      representative: number;
    }>;

    const lockedEditionIds = new Set(
      protectionRows.filter((row) => row.locked === 1).map((row) => row.edition_id),
    );
    const manualEditionIds = new Set(
      protectionRows.filter((row) => row.locked === 0 && row.selection_mode === "manual").map((row) => row.edition_id),
    );
    const existingRepresentativeEditionIdByReleaseGroup = new Map<number, number>();
    for (const row of protectionRows) {
      if (row.representative === 1) {
        existingRepresentativeEditionIdByReleaseGroup.set(row.release_group_id, row.edition_id);
      }
    }

    const overrulableManualEditions = protectionRows.filter(
      (row) => row.locked === 0 && row.selection_mode === "manual",
    );

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
        WHERE library_artist.library_id = ? AND library_artist.monitored = 1${artistFilterSql}

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
        WHERE library_artist.library_id = ? AND library_artist.monitored = 1${artistFilterSql}

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
          AND library_artist.credited_scope IN ('release_credit', 'release_and_track_credit')${artistFilterSql}

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
          AND library_artist.credited_scope = 'release_and_track_credit'${artistFilterSql}
      `).all(
        input.libraryId, ...artistFilterParams,
        input.libraryId, ...artistFilterParams,
        input.libraryId, ...artistFilterParams,
        input.libraryId, ...artistFilterParams,
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

    // Only editions that are somebody's candidate can be selected, so those are
    // the only ones worth reading. This used to load every AlbumEdition in the
    // database on every pass, including editions of artists no library monitors.
    const candidateEditionIds = [...candidateScopes.keys()];
    const releases = candidateEditionIds.length === 0
      ? []
      : (chunked(candidateEditionIds, 800).flatMap((chunk) => this.db.prepare(`
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
          WHERE release.id IN (${chunk.map(() => "?").join(",")})
        `).all(...chunk) as ReleaseRow[]))
        .sort((left, right) =>
          left.release_group_id - right.release_group_id || left.edition_id - right.edition_id);

    const evaluatedEditions = releases.filter(releaseIncluded);

    for (const release of evaluatedEditions) {
      timer.phase(`acquisition-plan[lib${input.libraryId}/ed${release.edition_id}]`, () => this.acquisitionPlanning.compute({
        libraryId: input.libraryId,
        editionId: release.edition_id,
        providerPriority: input.providerPriority,
        plannerVersion: input.acquisitionPlannerVersion,
      }));
    }

    // Plan-derived inputs, read for the editions this pass evaluates. Reading
    // them per library instead made a one-artist pass carry the whole library's
    // plans, which is the cost this scoping exists to remove.
    const evaluatedEditionIds = evaluatedEditions.map((release) => release.edition_id);
    const viableEditionIds = timer.phase("viable-plans",
      () => this.viablePlanEditionIds(input.libraryId, evaluatedEditionIds));
    const bestPlanByEdition = new Map<number, {
      explicit_content: string;
      coverage: number;
      quality_tier: string;
    }>();
    for (const chunk of chunked(evaluatedEditionIds, 800)) {
      for (const row of this.db.prepare(`
        SELECT edition_id, explicit_content, coverage, quality_tier
        FROM AcquisitionPlans
        WHERE library_id = ? AND rank = 0
          AND edition_id IN (${chunk.map(() => "?").join(",")})
      `).all(input.libraryId, ...chunk) as Array<{
        edition_id: number;
        explicit_content: string;
        coverage: number;
        quality_tier: string;
      }>) {
        bestPlanByEdition.set(row.edition_id, row);
      }
    }

    /**
     * What each Edition can actually be acquired — read off the acquisition
     * plans just computed above, which is why this runs after that loop and not
     * with the other candidate inputs.
     *
     * It used to be derived from provider releases matched *to* the Edition,
     * and that disagreed with the planner in both directions. It undercounted,
     * because a composite plan sources tracks from provider albums matched to
     * sibling Editions: the 3-track Killing Me Softly (MTV Unplugged) Edition
     * has a full 3/3 hi-res composite plan and measured **zero** attainable
     * recordings, so curation preferred its 1-track sibling — the richer
     * Edition looked like it could deliver nothing. And it overcounted, because
     * a superset provider album contributed the recordings of tracks this
     * Edition does not contain at all.
     *
     * Reading the plans removes both. Coverage now means what acquisition will
     * actually deliver, which is the only definition under which curation and
     * acquisition can agree. Measured on the live library: 9,463 of 12,342
     * planned Editions gain attainable recordings and none lose any.
     *
     * Quality is not re-filtered here: a plan only exists for qualities the
     * profile allows, so the gate is already applied upstream.
     */
    const attainableByRelease = new Map<number, Set<number>>();
    for (const chunk of chunked(evaluatedEditionIds, 800)) {
      for (const row of this.db.prepare(`
        SELECT DISTINCT plan.edition_id, track.recording_id
        FROM AcquisitionPlans plan
        JOIN AcquisitionPlanTracks plan_track
          ON plan_track.plan_id = plan.id
        JOIN Tracks track
          ON track.id = plan_track.track_id
        WHERE plan.library_id = ?
          AND plan.state = 'current'
          AND track.recording_id IS NOT NULL
          AND plan.edition_id IN (${chunk.map(() => "?").join(",")})
      `).all(input.libraryId, ...chunk) as Array<{ edition_id: number; recording_id: number }>) {
        const recordingIds = attainableByRelease.get(row.edition_id) || new Set<number>();
        recordingIds.add(row.recording_id);
        attainableByRelease.set(row.edition_id, recordingIds);
      }
    }

    const canonicalByRelease = requireProviderAvailability
      ? null
      : this.canonicalRecordingIdsByEdition(evaluatedEditionIds);

    // Coverage identity is resolved over the Recordings this scope actually
    // evaluates — the LibraryArtist candidate scope — not the whole catalogue.
    // Recordings belonging to artists this pass never considers cannot change
    // which Editions it selects.
    const scopeRecordingIds = new Set<number>();
    for (const release of evaluatedEditions) {
      const recordingIds = (canonicalByRelease ?? attainableByRelease)
        .get(release.edition_id);
      for (const recordingId of recordingIds ?? []) scopeRecordingIds.add(recordingId);
    }
    const { unitByRecording: coverageUnitByRecording, quarantinedProviderLinks } =
      timer.phase("coverage-identity", () => loadCoverageUnitsForRecordings(this.db, scopeRecordingIds));
    if (quarantinedProviderLinks.length > 0) {
      // Ambiguous provider matches are a matching-data defect, not evidence.
      // They are excluded from equivalence and named so they can be fixed.
      console.warn(
        `[LibraryCuration] ${quarantinedProviderLinks.length} provider track item(s) ` +
        "matched incompatible recordings and were excluded from coverage equivalence: " +
        quarantinedProviderLinks
          .slice(0, 5)
          .map((link: QuarantinedProviderLink) => `${link.provider}:${link.providerTrackItemId}`)
          .join(", "),
      );
    }

    const allCandidates: CurationEditionCandidate[] = [];
    for (const release of evaluatedEditions) {
      const rawAttainable = (canonicalByRelease ?? attainableByRelease)
        .get(release.edition_id) || new Set<number>();
      const attainableUnitIds = mapRecordingsToCoverageUnits(
        rawAttainable,
        coverageUnitByRecording,
      );
      // Release status is Edition eligibility for *automatic* curation only.
      // An excluded Edition is skipped as a candidate here and nowhere else: it
      // stays in the database, stays on the Album page, and stays usable as
      // matching evidence — and `isProtected` below lets a manual or locked
      // selection keep it, exactly as it already overrides availability.
      const statusEligible = isReleaseStatusIncluded(release.status, filtering);
      const eligible = statusEligible && (requireProviderAvailability
        ? viableEditionIds.has(release.edition_id)
        : true);
      const isProtected = lockedEditionIds.has(release.edition_id) || manualEditionIds.has(release.edition_id);
      if (!eligible && !isProtected) continue;

      const editionPreferenceRank = renditionPreferenceRank(
        editionRendition(release.title, release.disambiguation),
        preferExplicit,
      );
      const bestPlan = bestPlanByEdition.get(release.edition_id);
      const hasUsablePlan = bestPlan != null;
      const planPreferenceRank = bestPlan
        ? planExplicitPreferenceRank(
            normalizePlanExplicitContent(bestPlan.explicit_content),
            preferExplicit,
          )
        : 0;

      const isExistingRep = existingRepresentativeEditionIdByReleaseGroup.get(release.release_group_id) === release.edition_id;
      let protectedReason: "manual_selection" | "locked_selection" | undefined;
      if (lockedEditionIds.has(release.edition_id)) {
        protectedReason = "locked_selection";
      } else if (manualEditionIds.has(release.edition_id)) {
        protectedReason = "manual_selection";
      }

      allCandidates.push({
        releaseGroupId: release.release_group_id,
        editionId: release.edition_id,
        attainableUnitIds,
        statusRank: releaseStatusPreferenceRank(release.status),
        medium: mediumKind(release.media),
        preferredCountry: isPreferredCountry(release.country),
        mediaCount: Math.max(1, Number(release.media_count || 1)),
        releaseDate: release.date,
        releaseTypeRank: releaseTypeRankFor(release.primary_type),
        secondaryTypeRank: secondaryTypeRankFor(release.secondary_types),
        hasUsablePlan,
        planExplicitPreferenceRank: planPreferenceRank,
        editionExplicitPreferenceRank: editionPreferenceRank,
        protected: isProtected,
        existingRepresentative: isExistingRep,
        protectedReason,
      });
    }

    const allScopedSelections: ScopedCurationSelection[] = [];
    const proposedRepresentativesByReleaseGroup = new Map<number, Map<number, CurationEditionCandidate>>();
    const overruledReleaseGroupIds = new Set<number>();
    const redundancyEnabled = filtering.enable_redundancy_filter !== false;

    for (const libraryArtist of libraryArtists) {
      const scopedCandidates = allCandidates
        .filter((candidate) =>
          (candidateScopes.get(candidate.editionId) || [])
            .some((scope) => scope.libraryArtistId === libraryArtist.library_artist_id),
        )
        .map((candidate) => ({ ...candidate }));

      if (scopedCandidates.length === 0) continue;

      const lockedAlbumIdsInScope = new Set(
        protectionRows.filter((row) => row.locked === 1).map((row) => row.release_group_id),
      );
      const monitoredEditionIdsInScope = new Set(protectionRows.map((row) => row.edition_id));
      const eligibleCandidatesInScope = scopedCandidates.filter((candidate) =>
        !lockedAlbumIdsInScope.has(candidate.releaseGroupId)
        || monitoredEditionIdsInScope.has(candidate.editionId));

      const scopeOverrulableManual = overrulableManualEditions.filter((row) =>
        eligibleCandidatesInScope.some((c) => c.editionId === row.edition_id));

      const scopeOverruledRgs = this.overruledManualEditionAlbums({
        overrulableManualEditions: scopeOverrulableManual,
        candidates: eligibleCandidatesInScope,
        coverageUnitByRecording,
      });
      for (const rgId of scopeOverruledRgs) {
        overruledReleaseGroupIds.add(rgId);
      }

      const scopeManualIdsByAlbum = new Map<number, Set<number>>();
      for (const row of scopeOverrulableManual) {
        const editionIds = scopeManualIdsByAlbum.get(row.release_group_id) || new Set<number>();
        editionIds.add(row.edition_id);
        scopeManualIdsByAlbum.set(row.release_group_id, editionIds);
      }

      const curatedCandidatesInScope = eligibleCandidatesInScope.filter((candidate) => {
        const manualIds = scopeManualIdsByAlbum.get(candidate.releaseGroupId);
        if (!manualIds) return true;
        if (scopeOverruledRgs.has(candidate.releaseGroupId)) return true;
        return manualIds.has(candidate.editionId);
      });
      for (const candidate of curatedCandidatesInScope) {
        if (scopeOverruledRgs.has(candidate.releaseGroupId)) {
          candidate.protected = false;
          candidate.protectedReason = undefined;
        }
      }

      const scopedResult = timer.phase("cover-optimisation",
        () => curateLibraryReleases(curatedCandidatesInScope, redundancyEnabled));

      for (const [rgId, repEditionId] of scopedResult.representativeEditionIdByReleaseGroup) {
        const repCand = curatedCandidatesInScope.find((c) => c.editionId === repEditionId);
        if (repCand) {
          const mapForRg = proposedRepresentativesByReleaseGroup.get(rgId) || new Map<number, CurationEditionCandidate>();
          mapForRg.set(libraryArtist.library_artist_id, repCand);
          proposedRepresentativesByReleaseGroup.set(rgId, mapForRg);
        }
      }

      for (const decision of scopedResult.decisions) {
        const artistScopes = (candidateScopes.get(decision.editionId) || [])
          .filter((scope) => scope.libraryArtistId === libraryArtist.library_artist_id)
          .map((scope) => scope.scopeType);

        allScopedSelections.push({
          libraryArtistId: libraryArtist.library_artist_id,
          editionId: decision.editionId,
          releaseGroupId: decision.releaseGroupId,
          role: decision.role,
          reason: decision.reason,
          contributedUnitIds: decision.contributedUnitIds,
          scopeTypes: artistScopes,
        });
      }
    }

    const selectedEditionIdsSet = new Set(allScopedSelections.map((s) => s.editionId));
    const selectedReleaseGroupIdsSet = new Set(allScopedSelections.map((s) => s.releaseGroupId));

    const reconciledRepresentativeMap = new Map<number, number>();
    for (const rgId of selectedReleaseGroupIdsSet) {
      const proposedMap = proposedRepresentativesByReleaseGroup.get(rgId) || new Map<number, CurationEditionCandidate>();
      const proposedCandidates = [...proposedMap.values()].filter((c) => selectedEditionIdsSet.has(c.editionId));

      let chosenRep: CurationEditionCandidate | undefined;

      chosenRep = proposedCandidates.find(
        (c) => c.protected && c.protectedReason === "locked_selection" && c.existingRepresentative,
      );

      if (!chosenRep) {
        chosenRep = proposedCandidates.find(
          (c) => c.protected && c.protectedReason === "manual_selection" && c.existingRepresentative,
        );
      }

      if (!chosenRep && proposedCandidates.length > 0) {
        const firstId = proposedCandidates[0].editionId;
        const unanimous = proposedCandidates.every((c) => c.editionId === firstId);
        if (unanimous) {
          chosenRep = proposedCandidates[0];
        }
      }

      if (!chosenRep && proposedCandidates.length > 0) {
        const sorted = [...proposedCandidates].sort((left, right) =>
          comparePrimaryEditionCandidates(left, right) || left.editionId - right.editionId);
        chosenRep = sorted[0];
      }

      if (!chosenRep) {
        const candidatesInRg = allCandidates.filter(
          (c) => c.releaseGroupId === rgId && selectedEditionIdsSet.has(c.editionId),
        ).sort((left, right) =>
          comparePrimaryEditionCandidates(left, right) || left.editionId - right.editionId);
        chosenRep = candidatesInRg[0];
      }

      if (chosenRep) {
        reconciledRepresentativeMap.set(rgId, chosenRep.editionId);
      }
    }

    const selectedEditionIds = [...selectedEditionIdsSet].sort((a, b) => a - b);
    const selectedReleaseGroupIds = [...selectedReleaseGroupIdsSet].sort((a, b) => a - b);
    const supplementalEditionIds = selectedEditionIds.filter(
      (id) => !new Set(reconciledRepresentativeMap.values()).has(id),
    );

    const mergedDecisions: CurationEditionDecision[] = [];
    const reasonByEditionId = new Map<number, string>();

    const reasonStrength: Record<CurationSelectionReason, number> = {
      locked_selection: 4,
      manual_selection: 3,
      discography_gap_fill: 2,
      release_group_primary: 1,
    };

    for (const editionId of selectedEditionIds) {
      const selections = allScopedSelections.filter((s) => s.editionId === editionId);
      const rgId = selections[0]?.releaseGroupId ?? allCandidates.find((c) => c.editionId === editionId)!.releaseGroupId;
      const isRep = reconciledRepresentativeMap.get(rgId) === editionId;
      const role: CurationEditionRole = isRep ? "representative" : "supplemental";

      const contributedUnitsSet = new Set<number>();
      for (const s of selections) {
        for (const u of s.contributedUnitIds) contributedUnitsSet.add(u);
      }

      let strongestReason: CurationSelectionReason = isRep ? "release_group_primary" : "discography_gap_fill";
      for (const s of selections) {
        if (reasonStrength[s.reason] > reasonStrength[strongestReason]) {
          strongestReason = s.reason;
        }
      }

      if (overruledReleaseGroupIds.has(rgId) && strongestReason === "manual_selection") {
        strongestReason = isRep ? "release_group_primary" : "discography_gap_fill";
      }

      mergedDecisions.push({
        editionId,
        releaseGroupId: rgId,
        role,
        reason: strongestReason,
        contributedUnitIds: [...contributedUnitsSet].sort((a, b) => a - b),
      });

      const repoReason = overruledReleaseGroupIds.has(rgId)
        ? "curation_override_unreachable_recordings"
        : (strongestReason === "locked_selection"
            ? "locked_selection"
            : strongestReason === "manual_selection"
              ? "manual_selection"
              : isRep
                ? "curation_primary"
                : "curation_gap_fill");
      reasonByEditionId.set(editionId, repoReason);
    }

    const attainableUnitIdsSet = new Set<number>();
    for (const candidate of allCandidates) {
      if (selectedEditionIdsSet.has(candidate.editionId)) {
        for (const u of candidate.attainableUnitIds) attainableUnitIdsSet.add(u);
      }
    }

    const combinedResult: LibraryCurationResult = {
      representativeEditionIdByReleaseGroup: reconciledRepresentativeMap,
      supplementalEditionIds,
      selectedEditionIds,
      selectedReleaseGroupIds,
      attainableUnitIds: attainableUnitIdsSet,
      decisions: mergedDecisions,
    };

    const selectedScopes: LibraryReleaseScopeInput[] = [];
    const scopeKeySet = new Set<string>();

    for (const s of allScopedSelections) {
      if (!selectedEditionIdsSet.has(s.editionId)) continue;
      for (const st of s.scopeTypes) {
        const key = `${s.editionId}:${s.libraryArtistId}:${st}`;
        if (!scopeKeySet.has(key)) {
          scopeKeySet.add(key);
          selectedScopes.push({
            editionId: s.editionId,
            libraryArtistId: s.libraryArtistId,
            scopeType: st,
            reason: s.reason,
          });
        }
      }
    }

    const releaseGroupIdByReleaseId = new Map(
      allCandidates.map((candidate) => [candidate.editionId, candidate.releaseGroupId]),
    );

    timer.phase("persist", () => this.repository.replaceAutomaticCuration({
      libraryId: input.libraryId,
      result: combinedResult,
      releaseGroupIdByReleaseId,
      scopes: selectedScopes,
      curationVersion: input.curationVersion,
      reasonByReleaseGroupId: new Map(
        [...overruledReleaseGroupIds].map((releaseGroupId) =>
          [releaseGroupId, "curation_override_unreachable_recordings"] as const),
      ),
      reasonByEditionId,
      scopedLibraryArtistIds: scopedArtistIds ?? undefined,
    }));

    for (const editionId of combinedResult.selectedEditionIds) {
      timer.phase("replan-selected", () => this.acquisitionPlanning.compute({
        libraryId: input.libraryId,
        editionId,
        providerPriority: input.providerPriority,
        plannerVersion: input.acquisitionPlannerVersion,
      }));
    }
    timer.report(`library ${input.libraryId}: ${evaluatedEditions.length} edition(s)`);

    emitLibraryUpdated({
      reason: "library-curated",
      libraryIds: [input.libraryId],
    });

    return combinedResult;
  }

  private overruledManualEditionAlbums(input: {
    overrulableManualEditions: ReadonlyArray<{ edition_id: number; release_group_id: number }>;
    candidates: readonly CurationEditionCandidate[];
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

    const candidatesByAlbum = new Map<number, CurationEditionCandidate[]>();
    for (const candidate of input.candidates) {
      const list = candidatesByAlbum.get(candidate.releaseGroupId) || [];
      list.push(candidate);
      candidatesByAlbum.set(candidate.releaseGroupId, list);
    }

    const overruled = new Set<number>();
    for (const [releaseGroupId, manualEditionIds] of manualEditionIdsByAlbum) {
      const chosenUnitIds = new Set<number>();
      for (const editionId of manualEditionIds) {
        for (const unitId of unitsForEdition(editionId)) {
          chosenUnitIds.add(unitId);
        }
      }
      const alternativeUnitIds = new Set<number>();
      for (const candidate of candidatesByAlbum.get(releaseGroupId) || []) {
        if (manualEditionIds.has(candidate.editionId)) continue;
        for (const unitId of unitsForEdition(candidate.editionId)) {
          alternativeUnitIds.add(unitId);
        }
      }
      const reachableUnitIds = new Set<number>();
      for (const [otherAlbumId, otherCandidates] of candidatesByAlbum) {
        if (otherAlbumId === releaseGroupId) continue;
        for (const candidate of otherCandidates) {
          for (const unitId of unitsForEdition(candidate.editionId)) {
            reachableUnitIds.add(unitId);
          }
        }
      }

      const [overrule] = findUnreachableManualEditionChoices({
        albums: [{ releaseGroupId, chosenUnitIds, alternativeUnitIds }],
        reachableUnitIds,
      });
      if (!overrule) continue;
      overruled.add(overrule.releaseGroupId);
      console.warn(
        `[LibraryCuration] Overruling the manual edition choice for release group `
        + `${overrule.releaseGroupId}: ${overrule.unreachableUnitIds.length} canonical `
        + `recording(s) are reachable through no other release in this discography `
        + `(${overrule.unreachableUnitIds.slice(0, 10).join(", ")})`,
      );
    }
    return overruled;
  }

  /** Canonical recordings per edition; `editionIds` omitted means every edition. */
  private canonicalRecordingIdsByEdition(editionIds?: readonly number[]): Map<number, Set<number>> {
    const byEdition = new Map<number, Set<number>>();
    const rows = editionIds === undefined
      ? this.db.prepare("SELECT album_edition_id, recording_id FROM Tracks").all() as Array<{ album_edition_id: number; recording_id: number }>
      : chunked(editionIds, 800).flatMap((chunk) => this.db.prepare(`
          SELECT album_edition_id, recording_id FROM Tracks
          WHERE album_edition_id IN (${chunk.map(() => "?").join(",")})
        `).all(...chunk) as Array<{ album_edition_id: number; recording_id: number }>);
    for (const row of rows) {
      const recordingIds = byEdition.get(row.album_edition_id) || new Set<number>();
      recordingIds.add(row.recording_id);
      byEdition.set(row.album_edition_id, recordingIds);
    }
    return byEdition;
  }

  private viablePlanEditionIds(libraryId: number, editionIds?: readonly number[]): Set<number> {
    const VIABLE = `
        SELECT DISTINCT edition_id
        FROM AcquisitionPlans
        WHERE library_id = ?
          AND state = 'current'
          AND target_track_count > 0
          AND coverage * 2 > target_track_count`;
    const rows = editionIds === undefined
      ? this.db.prepare(VIABLE).all(libraryId) as Array<{ edition_id: number }>
      : chunked(editionIds, 800).flatMap((chunk) => this.db.prepare(
          `${VIABLE} AND edition_id IN (${chunk.map(() => "?").join(",")})`,
        ).all(libraryId, ...chunk) as Array<{ edition_id: number }>);
    return new Set(rows.map(({ edition_id }) => edition_id));
  }
}

function normalizePlanExplicitContent(content: string): PlanExplicitContent {
  if (content === "explicit" || content === "clean") return content;
  return "unknown";
}

function mediumKind(raw: string | null): CanonicalMediumKind {
  const value = String(raw || "").toLowerCase();
  if (value.includes("digital") || value.includes("download") || value.includes("stream")) return "digital";
  if (value.includes("cd")) return "cd";
  if (value.includes("vinyl") || value.includes("12\"") || value.includes("7\"") || value.includes("lp")) return "vinyl";
  return "other";
}

function isPreferredCountry(country: string | null): boolean {
  if (!country) return false;
  const upper = country.toUpperCase();
  return upper === "US" || upper === "GB" || upper === "XW";
}

function secondaryTypeRankFor(raw: string | null): number {
  const types = parseMusicBrainzSecondaryTypes(raw);
  if (types.includes("compilation") || types.includes("mixtape/streetware") || types.includes("dj-mix")) return 3;
  if (types.includes("remix")) return 2;
  if (types.includes("live") || types.includes("soundtrack")) return 1;
  return 0;
}

function parseStringArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}
