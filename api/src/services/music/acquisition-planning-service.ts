import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { getConfigSection } from "../config/config.js";
import {
  enumerateAcquisitionPlans,
  type AcquisitionQualityProfile,
  type AcquisitionSourceCandidate,
  type NormalizedAudioQuality,
} from "./acquisition-plan-optimizer.js";
import { AcquisitionPlanRepository } from "./acquisition-plan-repository.js";
import {
  editionMixFormatWithRecordings,
  editionRendition,
  planEligibleForEdition,
  planEligibleForMixFormat,
} from "./rendition-policy.js";

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
  /** Null when this Edition is evaluated but not monitored — plans exist anyway. */
  library_edition_id: number | null;
  selection_mode: "auto" | "manual" | null;
  /** The Album lock, the single authority over both monitoring and planning. */
  locked: number;
  quality_profile_id: number;
  allowed_source_formats: string;
  preference_order: string;
  cutoff: string;
  continue_upgrades: number;
  preferred_plan_key: string | null;
  plan_selection_mode: "auto" | "manual" | null;
  current_primary_provider_edition_match_id: number | null;
  /** MusicBrainz labels some editions clean or explicit; both feed the gate. */
  edition_title: string | null;
  edition_disambiguation: string | null;
}

interface CandidateRow {
  provider: string;
  provider_edition_match_id: number;
  relation: AcquisitionSourceCandidate["relation"];
  source_track_count: number;
  release_explicit: number | null;
  provider_edition_member_id: number;
  provider_track_match_id: number;
  track_id: number;
  track_explicit: number | null;
  track_variant_id: number | null;
  track_quality: string | null;
  track_codec: string | null;
  track_bitrate: number | null;
  track_bit_depth: number | null;
  track_sample_rate: number | null;
  track_availability: string | null;
  release_variant_id: number | null;
  release_quality: string | null;
  release_codec: string | null;
  release_bitrate: number | null;
  release_bit_depth: number | null;
  release_sample_rate: number | null;
  release_availability: string | null;
}

/**
 * Drop plans whose rendition contradicts the Edition's own label.
 *
 * Demoting them was not enough: with only a conflicting plan available it would
 * still be rank 0, and rank 0 is what curation and the download path execute.
 * A specifically clean Edition filled with explicit audio is the wrong product,
 * and the explicit Edition exists to be monitored instead — so the honest
 * outcome when nothing compatible exists is no plan at all.
 */
export function eligiblePlansForEdition<
  T extends {
    explicitContent: "explicit" | "clean" | "unknown";
    qualityTier?: string | null;
  },
>(
  plans: readonly T[],
  editionTitle: string | null | undefined,
  editionDisambiguation: string | null | undefined,
  /**
   * Comments of the Edition's own Recordings. They settle the channel format
   * only when unanimous — see `editionMixFormatWithRecordings`.
   */
  recordingComments: ReadonlyArray<string | null | undefined> = [],
): T[] {
  const rendition = editionRendition(editionTitle, editionDisambiguation);
  const mixFormat = editionMixFormatWithRecordings(
    editionTitle, editionDisambiguation, recordingComments,
  );
  if (rendition === "unlabelled" && mixFormat === "unlabelled") return [...plans];
  return plans.filter((plan) =>
    planEligibleForEdition(plan.explicitContent, rendition)
    && planEligibleForMixFormat(plan.qualityTier, mixFormat));
}

export class AcquisitionPlanningService {
  private readonly repository: AcquisitionPlanRepository;

  constructor(private readonly db: Database.Database) {
    this.repository = new AcquisitionPlanRepository(db);
  }

  /**
   * Build every viable acquisition plan for one canonical Edition in one Library.
   *
   * Deliberately does not require a `LibraryEditions` row. Plans are generated
   * during the provider-matching phase, before curation decides what to monitor,
   * so that curation can weigh real provider availability and the Album page can
   * offer the alternatives sitting under Editions nobody monitors yet.
   *
   * Returns the id of the plan the monitored Edition ended up executing, or
   * null when there is no viable plan (or nothing monitored to record a choice
   * on).
   */
  compute(input: {
    libraryId: number;
    editionId: number;
    providerPriority: readonly string[];
    plannerVersion: number;
    preferredProviderEditionMatchId?: number;
    /** Explicit single-source lock. Never implied by a preference. */
    exclusiveSource?: boolean;
  }): number | null {
    const context = this.db.prepare(`
      SELECT
        monitored_edition.id AS library_edition_id,
        monitored_edition.selection_mode,
        COALESCE(library_album.locked, 0) AS locked,
        library.quality_profile_id,
        profile.allowed_source_formats,
        profile.preference_order,
        profile.cutoff,
        profile.continue_upgrades,
        monitored_edition.preferred_plan_key,
        monitored_edition.plan_selection_mode,
        primary_source.provider_edition_match_id AS current_primary_provider_edition_match_id,
        edition.title AS edition_title,
        edition.disambiguation AS edition_disambiguation
      FROM Libraries library
      JOIN AlbumEditions edition ON edition.id = ?
      JOIN quality_profiles profile ON profile.id = library.quality_profile_id
      LEFT JOIN LibraryAlbums library_album
        ON library_album.library_id = library.id
       AND library_album.release_group_id = edition.release_group_id
      LEFT JOIN LibraryEditions monitored_edition
        ON monitored_edition.library_id = library.id
       AND monitored_edition.edition_id = edition.id
      LEFT JOIN SelectedAcquisitionPlans current_plan
        ON current_plan.library_edition_id = monitored_edition.id
       AND current_plan.state = 'current'
      LEFT JOIN AcquisitionPlanSources primary_source
        ON primary_source.plan_id = current_plan.id
       AND primary_source.role = 'primary'
      WHERE library.id = ?
    `).get(input.editionId, input.libraryId) as PlanningContextRow | undefined;
    if (!context) {
      throw new Error(
        `Library ${input.libraryId} or edition ${input.editionId} was not found`,
      );
    }

    const orderedTrackIds = (this.db.prepare(`
      SELECT id
      FROM Tracks
      WHERE album_edition_id = ?
      ORDER BY medium_position, position, id
    `).all(input.editionId) as Array<{ id: number }>).map(({ id }) => id);
    if (orderedTrackIds.length === 0) {
      this.repository.clear(input.libraryId, input.editionId);
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
        release_item.explicit AS release_explicit,
        member.id AS provider_edition_member_id,
        track_match.id AS provider_track_match_id,
        target_track.id AS track_id,
        member_item.explicit AS track_explicit,
        track_variant.id AS track_variant_id,
        track_variant.quality_class AS track_quality,
        track_variant.codec AS track_codec,
        track_variant.bitrate AS track_bitrate,
        track_variant.bit_depth AS track_bit_depth,
        track_variant.sample_rate AS track_sample_rate,
        track_variant.availability AS track_availability,
        release_variant.id AS release_variant_id,
        release_variant.quality_class AS release_quality,
        release_variant.codec AS release_codec,
        release_variant.bitrate AS release_bitrate,
        release_variant.bit_depth AS release_bit_depth,
        release_variant.sample_rate AS release_sample_rate,
        release_variant.availability AS release_availability
      -- Anchored on the target Edition's Recordings, not on provider albums
      -- matched *to* this Edition. A provider album is one product with one
      -- canonical identity; whether it can supply a Track here is a question
      -- about Recordings, and asking it this way is what lets a Hi-Res standard
      -- edition source the first eleven Tracks of a deluxe one, or two provider
      -- albums jointly cover a canonical Edition neither of them matches.
      FROM Tracks target_track
      JOIN Recordings target_recording
        ON target_recording.id = target_track.recording_id
       AND target_recording.is_video = 0
      JOIN Tracks source_track
        ON source_track.recording_id = target_track.recording_id
      JOIN ProviderTrackMatches track_match
        ON track_match.track_id = source_track.id
       AND track_match.match_state = 'accepted'
      JOIN ProviderEditionMatches release_match
        ON release_match.id = track_match.provider_edition_match_id
       AND release_match.match_state = 'accepted'
      JOIN ProviderItems release_item
        ON release_item.id = release_match.provider_edition_item_id
      JOIN ProviderEditionMembers member
        ON member.id = track_match.provider_edition_member_id
      JOIN ProviderItems member_item
        ON member_item.id = member.member_item_id
      LEFT JOIN ProviderItemAudioVariants track_variant
        ON track_variant.provider_item_id = member.member_item_id
      LEFT JOIN ProviderItemAudioVariants release_variant
        ON release_variant.provider_item_id = release_match.provider_edition_item_id
      WHERE target_track.album_edition_id = ?
        AND target_track.recording_id IS NOT NULL
        AND release_item.availability NOT IN (
          'unavailable', 'no_longer_available', 'geography_restricted',
          'entitlement_restricted', 'explicit_policy_ineligible', 'quality_unavailable'
        )
      ORDER BY release_match.id, target_track.id, track_match.id, track_variant.id, release_variant.id
    `).all(input.editionId) as CandidateRow[];

    const sourceById = new Map<number, AcquisitionSourceCandidate>();
    const matchById = new Map<string, AcquisitionSourceCandidate["trackMatches"][number]>();
    for (const row of rows) {
      let source = sourceById.get(row.provider_edition_match_id);
      if (!source) {
        source = {
          provider: row.provider,
          providerEditionMatchId: row.provider_edition_match_id,
          relation: row.relation,
          sourceTrackCount: row.source_track_count,
          albumDownloadSafe: row.relation === "exact",
          releaseExplicit: row.release_explicit == null ? null : Boolean(row.release_explicit),
          trackMatches: [],
        };
        sourceById.set(row.provider_edition_match_id, source);
      }
      const trackMatchKey = `${row.provider_track_match_id}:${row.track_id}`;
      let trackMatch = matchById.get(trackMatchKey);
      if (!trackMatch) {
        trackMatch = {
          providerTrackMatchId: row.provider_track_match_id,
          providerEditionMemberId: row.provider_edition_member_id,
          trackId: row.track_id,
          explicit: row.track_explicit == null ? null : Boolean(row.track_explicit),
          variants: [],
        };
        (source.trackMatches as Array<typeof trackMatch>).push(trackMatch);
        matchById.set(trackMatchKey, trackMatch);
      }
      const trackQuality = parseQuality(row.track_quality);
      const releaseQuality = parseQuality(row.release_quality);
      // The delivered properties travel with the variant so the optimizer can
      // separate two offers of the same class — a provider tier alone cannot.
      const variant = trackQuality && row.track_variant_id != null
        ? {
          id: row.track_variant_id,
          quality: trackQuality,
          available: isAvailable(row.track_availability),
          codec: row.track_codec,
          bitrateKbps: row.track_bitrate,
          bitDepth: row.track_bit_depth,
          sampleRateHz: row.track_sample_rate,
        }
        : releaseQuality && row.release_variant_id != null
          ? {
            id: row.release_variant_id,
            quality: releaseQuality,
            available: isAvailable(row.release_availability),
            codec: row.release_codec,
            bitrateKbps: row.release_bitrate,
            bitDepth: row.release_bit_depth,
            sampleRateHz: row.release_sample_rate,
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
      preferredProviderEditionMatchId: input.preferredProviderEditionMatchId ?? (
        context.selection_mode === "manual" && context.locked
          ? context.current_primary_provider_edition_match_id
          : null
      ),
    })).digest("hex");
    const explicitPreference = input.preferredProviderEditionMatchId;
    const preservedManualPreference = context.selection_mode === "manual" && context.locked
      ? context.current_primary_provider_edition_match_id
      : null;
    const preferredProviderEditionMatchId = explicitPreference ?? preservedManualPreference;
    const sources = [...sourceById.values()];
    if (
      preferredProviderEditionMatchId != null
      && !sourceById.has(preferredProviderEditionMatchId)
      && explicitPreference != null
    ) {
      throw new Error("The selected provider offer has no accepted track matches for this edition");
    }
    // The preferred offer is the primary source, not an exclusive lock: the
    // optimizer may still cover missing canonical tracks from another accepted
    // Provider Edition of the same provider unless exclusivity was requested.
    const plans = enumerateAcquisitionPlans({
      orderedTrackIds,
      profile,
      sources,
      providerPriority: input.providerPriority,
      preferredProviderEditionMatchId,
      exclusive: input.exclusiveSource === true,
      preferExplicit: getConfigSection("filtering").prefer_explicit !== false,
    });
    if (plans.length === 0) {
      this.repository.clear(input.libraryId, input.editionId);
      return null;
    }
    // A specifically clean or explicit Edition takes only its own rendition.
    // Curation and the download path read rank 0 straight from
    // AcquisitionPlans, so this has to happen before ranking is persisted.
    // Some entirely-spatial Editions carry the marker only on their Recordings
    // (155 in the corpus); the comments settle it when unanimous.
    const recordingComments = (this.db.prepare(`
      SELECT recording.disambiguation
      FROM Tracks track
      JOIN Recordings recording ON recording.id = track.recording_id
      WHERE track.album_edition_id = ?
    `).all(input.editionId) as Array<{ disambiguation: string | null }>)
      .map(({ disambiguation }) => disambiguation);
    const rankedPlans = eligiblePlansForEdition(
      plans,
      context.edition_title,
      context.edition_disambiguation,
      recordingComments,
    );
    if (rankedPlans.length === 0) {
      // Every offer contradicts the Edition's rendition. Saying so is the
      // honest answer; the opposite-rendition Edition is the one to monitor.
      this.repository.clear(input.libraryId, input.editionId);
      return null;
    }
    // The library's standing plan choice outranks the planner's own ordering,
    // and survives replanning because it is keyed by plan shape, not row id.
    const result = this.repository.replacePlans({
      libraryId: input.libraryId,
      editionId: input.editionId,
      plans: rankedPlans,
      targetTrackCount: orderedTrackIds.length,
      preferredPlanKey: context.plan_selection_mode === "manual"
        ? context.preferred_plan_key
        : null,
      // The album lock covers the monitored state, the edition choice and the
      // provider/plan choice alike.
      lockPreference: Boolean(context.locked),
      plannerVersion: input.plannerVersion,
      policyHash,
    });
    if (!result) {
      this.repository.clear(input.libraryId, input.editionId);
      return null;
    }
    if (result.preferenceUnavailable) {
      console.warn(
        `[AcquisitionPlanning] Locked plan ${context.preferred_plan_key} for edition `
        + `${input.editionId} in library ${input.libraryId} is no longer offered; `
        + "keeping it selected and marked unavailable rather than substituting another",
      );
    } else if (context.plan_selection_mode === "manual" && !result.preferenceHonored) {
      // Either the chosen alternative no longer exists, or it still exists but
      // now covers fewer canonical tracks than the best plan. Both are grounds
      // to overrule the user; neither is grounds to do it silently. The row now
      // carries the best-ranked plan; only its provenance needs correcting.
      console.warn(
        `[AcquisitionPlanning] Preferred plan ${context.preferred_plan_key} for edition `
        + `${input.editionId} in library ${input.libraryId} `
        + (result.preferenceLostCoverage
          ? "no longer covers as many tracks as the best plan"
          : "is no longer available")
        + "; using the best-ranked plan",
      );
    }
    return result.selectedPlanId;
  }
}
