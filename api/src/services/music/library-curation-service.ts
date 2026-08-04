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
  type CurationReleaseCandidate,
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
import {
  editionExplicitLabelScore,
  editionExplicitPreferenceRank,
  loadAcquisitionUnitMapFromDb,
  mapRecordingsToCoverageUnits,
} from "./recording-coverage-units.js";
import {
  planExplicitPreferenceRank,
  type PlanExplicitContent,
} from "./acquisition-plan-optimizer.js";
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

  curateLibrary(input: {
    libraryId: number;
    providerPriority: string[];
    acquisitionPlannerVersion: number;
    curationVersion: number;
  }): LibraryCurationResult {
    const library = this.db.prepare(`
      SELECT library.id, quality.allowed_source_formats
      FROM Libraries library
      LEFT JOIN quality_profiles quality ON quality.id = library.quality_profile_id
      WHERE library.id = ?
    `).get(input.libraryId) as LibraryPolicyRow | undefined;
    if (!library) throw new Error(`Library ${input.libraryId} does not exist`);

    const filtering = getConfigSection("filtering");
    const requireProviderAvailability = filtering.require_provider_availability !== false;
    const releaseIncluded = (release: ReleaseRow): boolean => {
      const decision = getMusicBrainzReleaseGroupIncludeDecision(
        { primary_type: release.primary_type, secondary_types: release.secondary_types },
        filtering,
      );
      return decision.include;
    };

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

    const coverageUnitByRecording = loadAcquisitionUnitMapFromDb(this.db);
    const preferExplicit = filtering.prefer_explicit !== false;
    const allowedQualities = parseStringArray(library.allowed_source_formats);
    const qualityPlaceholders = allowedQualities.map(() => "?").join(",");

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

    const evaluatedEditions = releases.filter((release) =>
      releaseIncluded(release)
      && (candidateScopes.get(release.edition_id) || []).length > 0);

    for (const release of evaluatedEditions) {
      this.acquisitionPlanning.compute({
        libraryId: input.libraryId,
        editionId: release.edition_id,
        providerPriority: input.providerPriority,
        plannerVersion: input.acquisitionPlannerVersion,
      });
    }

    const viableEditionIds = this.viablePlanEditionIds(input.libraryId);
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

    const canonicalByRelease = requireProviderAvailability
      ? null
      : this.canonicalRecordingIdsByEdition();

    const allCandidates: CurationEditionCandidate[] = [];
    for (const release of evaluatedEditions) {
      const rawAttainable = (canonicalByRelease ?? attainableByRelease)
        .get(release.edition_id) || new Set<number>();
      const attainableUnitIds = mapRecordingsToCoverageUnits(
        rawAttainable,
        coverageUnitByRecording,
      );
      const eligible = requireProviderAvailability
        ? viableEditionIds.has(release.edition_id)
        : true;
      const isProtected = lockedEditionIds.has(release.edition_id) || manualEditionIds.has(release.edition_id);
      if (!eligible && !isProtected) continue;

      const labelScore = editionExplicitLabelScore(release.title, release.disambiguation);
      const editionPreferenceRank = editionExplicitPreferenceRank(labelScore, preferExplicit);
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
        official: !release.status || release.status.toLowerCase() === "official",
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

      const scopedResult = curateLibraryReleases(curatedCandidatesInScope, redundancyEnabled);

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
      selectedReleaseIds: selectedEditionIds,
      baselineReleaseIds: selectedEditionIds,
      attainableRecordingIds: attainableUnitIdsSet,
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

    this.repository.replaceAutomaticCuration({
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
    });

    for (const editionId of combinedResult.selectedEditionIds) {
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
