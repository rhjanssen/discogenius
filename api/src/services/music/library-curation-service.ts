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
  allowed_source_formats: string;
}

interface LibraryArtistRow {
  library_artist_id: number;
  artist_id: number;
  credited_scope: CreditedScope;
}

interface ReleaseRow {
  release_id: number;
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
        quality.allowed_source_formats
      FROM Libraries library
      JOIN MetadataProfiles metadata ON metadata.id = library.metadata_profile_id
      JOIN quality_profiles quality ON quality.id = library.quality_profile_id
      WHERE library.id = ? AND library.enabled = 1
    `).get(input.libraryId) as LibraryPolicyRow | undefined;
    if (!library) throw new Error(`Enabled library ${input.libraryId} was not found`);

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
        release.id AS release_id,
        release.release_group_id,
        release_group.artist_metadata_id AS primary_artist_id,
        release_group.primary_type,
        release_group.secondary_types,
        release.status,
        release.country,
        release.date,
        release.media_count,
        release.media
      FROM AlbumReleases release
      JOIN Albums release_group ON release_group.id = release.release_group_id
      ORDER BY release.release_group_id, release.id
    `).all() as ReleaseRow[];
    const policy = parsePolicy(library.release_type_policy);
    const allowedQualities = parseStringArray(library.allowed_source_formats);
    const qualityPlaceholders = allowedQualities.map(() => "?").join(",");
    const protectedReleaseIds = new Set(
      (this.db.prepare(`
        SELECT release_id
        FROM LibraryReleases
        WHERE library_id = ? AND (locked = 1 OR selection_mode = 'manual')
      `).all(input.libraryId) as Array<{ release_id: number }>).map(({ release_id }) => release_id),
    );

    const candidateScopes = new Map<number, LibraryReleaseScopeInput[]>();
    if (libraryArtists.length > 0) {
      const scopeRows = this.db.prepare(`
        SELECT DISTINCT
          release.id AS release_id,
          library_artist.id AS library_artist_id,
          'primary' AS scope_type
        FROM LibraryArtists library_artist
        JOIN ManagedArtists managed ON managed.id = library_artist.managed_artist_id
        JOIN Albums release_group ON release_group.artist_metadata_id = managed.artist_id
        JOIN AlbumReleases release ON release.release_group_id = release_group.id
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
        JOIN AlbumReleases release ON release.release_group_id = credit.release_group_id
        WHERE library_artist.library_id = ? AND library_artist.monitored = 1

        UNION

        SELECT DISTINCT
          credit.release_id,
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
          track.album_release_id,
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
        release_id: number;
        library_artist_id: number;
        scope_type: LibraryScopeType;
      }>;
      for (const row of scopeRows) {
        const scopes = candidateScopes.get(row.release_id) || [];
        scopes.push({
          releaseId: row.release_id,
          libraryArtistId: row.library_artist_id,
          scopeType: row.scope_type,
          reason: `canonical_${row.scope_type}`,
        });
        candidateScopes.set(row.release_id, scopes);
      }
    }

    const attainableByRelease = new Map<number, Set<number>>();
    if (allowedQualities.length > 0) {
      const attainableRows = this.db.prepare(`
        SELECT DISTINCT release_match.release_id, track_match.recording_id
        FROM ProviderReleaseMatches release_match
        JOIN ProviderTrackMatches track_match
          ON track_match.provider_release_match_id = release_match.id
         AND track_match.match_state = 'accepted'
         AND track_match.track_id IS NOT NULL
        JOIN ProviderReleaseMembers member
          ON member.id = track_match.provider_release_member_id
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
              WHERE variant.provider_item_id = release_match.provider_release_item_id
                AND variant.quality_class IN (${qualityPlaceholders})
                AND variant.availability NOT IN (
                  'unavailable', 'no_longer_available', 'geography_restricted',
                  'entitlement_restricted', 'explicit_policy_ineligible', 'quality_unavailable'
                )
            )
          )
      `).all(...allowedQualities, ...allowedQualities) as Array<{
        release_id: number;
        recording_id: number;
      }>;
      for (const row of attainableRows) {
        const recordingIds = attainableByRelease.get(row.release_id) || new Set<number>();
        recordingIds.add(row.recording_id);
        attainableByRelease.set(row.release_id, recordingIds);
      }
    }

    const candidates: CurationReleaseCandidate[] = [];
    for (const release of releases) {
      if (!releaseIncluded(release, policy)) continue;
      const scopes = candidateScopes.get(release.release_id) || [];
      if (scopes.length === 0) continue;
      const attainableRecordingIds = attainableByRelease.get(release.release_id) || new Set<number>();
      if (attainableRecordingIds.size === 0 && !protectedReleaseIds.has(release.release_id)) continue;
      candidates.push({
        releaseGroupId: release.release_group_id,
        releaseId: release.release_id,
        attainableRecordingIds,
        official: !release.status || release.status.toLowerCase() === "official",
        medium: mediumKind(release.media),
        preferredCountry: !release.country || ["xw", "us", "gb"].includes(release.country.toLowerCase()),
        mediaCount: Math.max(1, Number(release.media_count || 1)),
        releaseDate: release.date,
        protected: protectedReleaseIds.has(release.release_id),
      });
    }

    const result = curateLibraryReleases(candidates, Boolean(library.redundancy_enabled));
    const releaseGroupIdByReleaseId = new Map(
      candidates.map((candidate) => [candidate.releaseId, candidate.releaseGroupId]),
    );
    const selectedScopes = result.selectedReleaseIds.flatMap((releaseId) =>
      candidateScopes.get(releaseId) || []);
    this.repository.replaceAutomaticCuration({
      libraryId: input.libraryId,
      result,
      releaseGroupIdByReleaseId,
      scopes: selectedScopes,
      curationVersion: input.curationVersion,
    });

    const selectedLibraryReleases = this.db.prepare(`
      SELECT id
      FROM LibraryReleases
      WHERE library_id = ? AND release_id IN (
        ${result.selectedReleaseIds.length > 0 ? result.selectedReleaseIds.map(() => "?").join(",") : "NULL"}
      )
      ORDER BY id
    `).all(input.libraryId, ...result.selectedReleaseIds) as Array<{ id: number }>;
    for (const libraryRelease of selectedLibraryReleases) {
      this.acquisitionPlanning.compute({
        libraryReleaseId: libraryRelease.id,
        providerPriority: input.providerPriority,
        plannerVersion: input.acquisitionPlannerVersion,
      });
    }
    return result;
  }
}
