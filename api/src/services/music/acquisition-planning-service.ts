import crypto from "node:crypto";
import type Database from "better-sqlite3";
import {
  optimizeAcquisitionPlan,
  type AcquisitionQualityProfile,
  type AcquisitionSourceCandidate,
  type NormalizedAudioQuality,
} from "./acquisition-plan-optimizer.js";
import { AcquisitionPlanRepository } from "./acquisition-plan-repository.js";

const QUALITY_VALUES = new Set<NormalizedAudioQuality>([
  "lossy",
  "lossless",
  "hires-lossless",
  "spatial",
]);

function parseQuality(value: unknown): NormalizedAudioQuality | null {
  const normalized = String(value || "").trim().toLowerCase() as NormalizedAudioQuality;
  return QUALITY_VALUES.has(normalized) ? normalized : null;
}

function parseQualityList(value: unknown): NormalizedAudioQuality[] {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseQuality).filter((quality): quality is NormalizedAudioQuality => quality != null);
  } catch {
    return [];
  }
}

function isAvailable(value: unknown): boolean {
  const availability = String(value || "unknown").trim().toLowerCase();
  return ![
    "unavailable",
    "no_longer_available",
    "geography_restricted",
    "entitlement_restricted",
    "explicit_policy_ineligible",
    "quality_unavailable",
  ].includes(availability);
}

interface PlanningContextRow {
  library_release_id: number;
  edition_id: number;
  quality_profile_id: number;
  allowed_source_formats: string;
  preference_order: string;
  cutoff: string;
  continue_upgrades: number;
}

interface CandidateRow {
  provider: string;
  provider_edition_match_id: number;
  relation: AcquisitionSourceCandidate["relation"];
  source_track_count: number;
  provider_edition_member_id: number;
  provider_track_match_id: number;
  track_id: number;
  track_variant_id: number | null;
  track_quality: string | null;
  track_availability: string | null;
  release_variant_id: number | null;
  release_quality: string | null;
  release_availability: string | null;
}

export class AcquisitionPlanningService {
  private readonly repository: AcquisitionPlanRepository;

  constructor(private readonly db: Database.Database) {
    this.repository = new AcquisitionPlanRepository(db);
  }

  compute(input: {
    libraryReleaseId: number;
    providerPriority: readonly string[];
    plannerVersion: number;
  }): number | null {
    const context = this.db.prepare(`
      SELECT
        library_release.id AS library_release_id,
        library_release.edition_id,
        library.quality_profile_id,
        profile.allowed_source_formats,
        profile.preference_order,
        profile.cutoff,
        profile.continue_upgrades
      FROM LibraryReleases library_release
      JOIN Libraries library ON library.id = library_release.library_id
      JOIN quality_profiles profile ON profile.id = library.quality_profile_id
      WHERE library_release.id = ?
    `).get(input.libraryReleaseId) as PlanningContextRow | undefined;
    if (!context) throw new Error(`Library release ${input.libraryReleaseId} was not found`);

    const orderedTrackIds = (this.db.prepare(`
      SELECT id
      FROM Tracks
      WHERE album_edition_id = ?
      ORDER BY medium_position, position, id
    `).all(context.edition_id) as Array<{ id: number }>).map(({ id }) => id);
    if (orderedTrackIds.length === 0) {
      this.repository.clear(input.libraryReleaseId);
      return null;
    }

    const allowedQualities = parseQualityList(context.allowed_source_formats);
    const preferenceOrder = parseQualityList(context.preference_order);
    const cutoff = parseQuality(context.cutoff);
    if (allowedQualities.length === 0 || preferenceOrder.length === 0 || !cutoff) {
      throw new Error(`Quality profile ${context.quality_profile_id} has invalid normalized policy`);
    }
    const profile: AcquisitionQualityProfile = {
      allowedQualities: new Set(allowedQualities),
      preferenceOrder,
      cutoff,
      continueUpgradesAfterCutoff: Boolean(context.continue_upgrades),
    };

    const rows = this.db.prepare(`
      SELECT
        release_item.provider,
        release_match.id AS provider_edition_match_id,
        release_match.relation,
        release_match.source_track_count,
        member.id AS provider_edition_member_id,
        track_match.id AS provider_track_match_id,
        track_match.track_id,
        track_variant.id AS track_variant_id,
        track_variant.quality_class AS track_quality,
        track_variant.availability AS track_availability,
        release_variant.id AS release_variant_id,
        release_variant.quality_class AS release_quality,
        release_variant.availability AS release_availability
      FROM ProviderEditionMatches release_match
      JOIN ProviderItems release_item
        ON release_item.id = release_match.provider_edition_item_id
      JOIN ProviderTrackMatches track_match
        ON track_match.provider_edition_match_id = release_match.id
       AND track_match.match_state = 'accepted'
       AND track_match.track_id IS NOT NULL
      JOIN ProviderEditionMembers member
        ON member.id = track_match.provider_edition_member_id
      LEFT JOIN ProviderItemAudioVariants track_variant
        ON track_variant.provider_item_id = member.member_item_id
      LEFT JOIN ProviderItemAudioVariants release_variant
        ON release_variant.provider_item_id = release_match.provider_edition_item_id
      WHERE release_match.edition_id = ?
        AND release_match.match_state = 'accepted'
        AND release_item.availability NOT IN (
          'unavailable', 'no_longer_available', 'geography_restricted',
          'entitlement_restricted', 'explicit_policy_ineligible', 'quality_unavailable'
        )
      ORDER BY release_match.id, track_match.id, track_variant.id, release_variant.id
    `).all(context.edition_id) as CandidateRow[];

    const sourceById = new Map<number, AcquisitionSourceCandidate>();
    const matchById = new Map<number, AcquisitionSourceCandidate["trackMatches"][number]>();
    for (const row of rows) {
      let source = sourceById.get(row.provider_edition_match_id);
      if (!source) {
        source = {
          provider: row.provider,
          providerReleaseMatchId: row.provider_edition_match_id,
          relation: row.relation,
          sourceTrackCount: row.source_track_count,
          albumDownloadSafe: row.relation === "exact",
          trackMatches: [],
        };
        sourceById.set(row.provider_edition_match_id, source);
      }
      let trackMatch = matchById.get(row.provider_track_match_id);
      if (!trackMatch) {
        trackMatch = {
          providerTrackMatchId: row.provider_track_match_id,
          providerReleaseMemberId: row.provider_edition_member_id,
          trackId: row.track_id,
          variants: [],
        };
        (source.trackMatches as Array<typeof trackMatch>).push(trackMatch);
        matchById.set(row.provider_track_match_id, trackMatch);
      }
      const trackQuality = parseQuality(row.track_quality);
      const releaseQuality = parseQuality(row.release_quality);
      const variant = trackQuality && row.track_variant_id != null
        ? {
          id: row.track_variant_id,
          quality: trackQuality,
          available: isAvailable(row.track_availability),
        }
        : releaseQuality && row.release_variant_id != null
          ? {
            id: row.release_variant_id,
            quality: releaseQuality,
            available: isAvailable(row.release_availability),
          }
          : null;
      if (
        variant
        && !trackMatch.variants.some((candidate) =>
          candidate.id === variant.id && candidate.quality === variant.quality)
      ) {
        (trackMatch.variants as Array<typeof variant>).push(variant);
      }
    }

    const policyHash = crypto.createHash("sha256").update(JSON.stringify({
      qualityProfileId: context.quality_profile_id,
      allowedQualities,
      preferenceOrder,
      cutoff,
      continueUpgradesAfterCutoff: profile.continueUpgradesAfterCutoff,
      providerPriority: input.providerPriority,
    })).digest("hex");
    const plan = optimizeAcquisitionPlan({
      orderedTrackIds,
      profile,
      sources: [...sourceById.values()],
      providerPriority: input.providerPriority,
    });
    if (!plan) {
      this.repository.clear(input.libraryReleaseId);
      return null;
    }
    return this.repository.replaceCurrentPlan({
      libraryReleaseId: input.libraryReleaseId,
      plan,
      plannerVersion: input.plannerVersion,
      policyHash,
    });
  }
}
