import type Database from "better-sqlite3";
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

interface LibraryPolicyRow {
  id: number;
  release_type_policy: string;
  redundancy_enabled: number;
  require_provider_availability: number;
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
}

interface ReleaseTypePolicy {
  includePrimaryTypes?: string[];
  excludeSecondaryTypes?: string[];
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

function parsePolicy(value: string): ReleaseTypePolicy {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed as ReleaseTypePolicy : {};
  } catch {
    return {};
  }
}

function releaseIncluded(release: ReleaseRow, policy: ReleaseTypePolicy): boolean {
  const primary = String(release.primary_type || "album").trim().toLowerCase();
  const included = parseStringArray(policy.includePrimaryTypes);
  if (included.length > 0 && !included.includes(primary)) return false;
  const excludedSecondary = new Set(parseStringArray(policy.excludeSecondaryTypes));
  const secondary = parseStringArray(release.secondary_types);
  return !secondary.some((type) => excludedSecondary.has(type));
}

function mediumKind(value: string | null): CanonicalMediumKind {
  const media = String(value || "").toLowerCase();
  if (/digital|download|stream/.test(media)) return "digital";
  if (/\bcd\b|compact disc/.test(media)) return "cd";
  if (/vinyl|12"|10"|7"/.test(media)) return "vinyl";
  return "other";
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
        metadata.release_type_policy,
        metadata.redundancy_enabled,
        metadata.require_provider_availability,
        quality.allowed_source_formats
      FROM Libraries library
      JOIN MetadataProfiles metadata ON metadata.id = library.metadata_profile_id
      JOIN quality_profiles quality ON quality.id = library.quality_profile_id
      WHERE library.id = ? AND library.enabled = 1
    `).get(input.libraryId) as LibraryPolicyRow | undefined;
    if (!library) throw new Error(`Enabled library ${input.libraryId} was not found`);
    const requireProviderAvailability = Boolean(library.require_provider_availability);

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
        release.media
      FROM AlbumEditions release
      JOIN Albums release_group ON release_group.id = release.release_group_id
      ORDER BY release.release_group_id, release.id
    `).all() as ReleaseRow[];
    const policy = parsePolicy(library.release_type_policy);
    const allowedQualities = parseStringArray(library.allowed_source_formats);
    const qualityPlaceholders = allowedQualities.map(() => "?").join(",");
    // Editions automation may not drop: the user picked them, or their Album is
    // locked. The lock is read from LibraryAlbums — the one place it lives.
    const protectedReleaseIds = new Set(
      (this.db.prepare(`
        SELECT monitored_edition.edition_id
        FROM LibraryEditions monitored_edition
        JOIN AlbumEditions edition ON edition.id = monitored_edition.edition_id
        LEFT JOIN LibraryAlbums library_album
          ON library_album.library_id = monitored_edition.library_id
         AND library_album.release_group_id = edition.release_group_id
        WHERE monitored_edition.library_id = ?
          AND (COALESCE(library_album.locked, 0) = 1
               OR monitored_edition.selection_mode = 'manual')
      `).all(input.libraryId) as Array<{ edition_id: number }>).map(({ edition_id }) => edition_id),
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
            OR EXISTS (
              SELECT 1 FROM ProviderItemAudioVariants variant
              WHERE variant.provider_item_id = release_match.provider_edition_item_id
                AND variant.quality_class IN (${qualityPlaceholders})
                AND variant.availability NOT IN (
                  'unavailable', 'no_longer_available', 'geography_restricted',
                  'entitlement_restricted', 'explicit_policy_ineligible', 'quality_unavailable'
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
    // artist scope and allowed by the release-type policy. Provider coverage is
    // deliberately NOT a filter here — an Edition with no offer still has to be
    // evaluated, planned and offered, it just will not be picked automatically.
    const evaluatedEditions = releases.filter((release) =>
      releaseIncluded(release, policy)
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
    // The set curation is trying to cover. With provider availability required
    // it is what a provider can actually deliver; without it the canonical
    // Recording set is the target, because an Edition with no offer at all is
    // still a legitimate thing to monitor — it simply has nothing to execute.
    const canonicalByRelease = requireProviderAvailability
      ? null
      : this.canonicalRecordingIdsByEdition();
    const candidates: CurationReleaseCandidate[] = [];
    for (const release of evaluatedEditions) {
      const attainableRecordingIds = (canonicalByRelease ?? attainableByRelease)
        .get(release.edition_id) || new Set<number>();
      // With provider availability required, only an Edition a provider can
      // actually deliver is eligible for automatic monitoring. Without it, any
      // canonical Edition may be monitored and simply has no plan to execute.
      const eligible = requireProviderAvailability
        ? viableEditionIds.has(release.edition_id)
        : true;
      if (!eligible && !protectedReleaseIds.has(release.edition_id)) continue;
      candidates.push({
        releaseGroupId: release.release_group_id,
        editionId: release.edition_id,
        attainableRecordingIds,
        official: !release.status || release.status.toLowerCase() === "official",
        medium: mediumKind(release.media),
        preferredCountry: !release.country || ["xw", "us", "gb"].includes(release.country.toLowerCase()),
        mediaCount: Math.max(1, Number(release.media_count || 1)),
        releaseDate: release.date,
        protected: protectedReleaseIds.has(release.edition_id),
      });
    }

    const result = curateLibraryReleases(candidates, Boolean(library.redundancy_enabled));
    const releaseGroupIdByReleaseId = new Map(
      candidates.map((candidate) => [candidate.editionId, candidate.releaseGroupId]),
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
    return result;
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
