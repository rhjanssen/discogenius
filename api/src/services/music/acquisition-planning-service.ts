import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { getConfigSection } from "../config/config.js";
import { createCurationPhaseTimer } from "./curation-profile.js";
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

    const planTimer = createCurationPhaseTimer();
    const rows = planTimer.phase(`plan:candidate-sql[ed${input.editionId}]`, () => this.db.prepare(`
      -- Which provider tracks may source this Edition's Tracks.
      --
      -- Anchored on the target Edition's Recordings, not on provider albums
      -- matched *to* this Edition. A provider album is one product with one
      -- canonical identity; whether it can supply a Track here is a question
      -- about the underlying performance, and asking it this way is what lets a
      -- Hi-Res standard edition source the first eleven Tracks of a deluxe one,
      -- or two provider albums jointly cover a canonical Edition neither of
      -- them matches.
      --
      -- Two tiers of positive evidence, deliberately no more. Anything weaker
      -- (bare title, title+duration) is NOT evidence of the same performance,
      -- and this decides what audio gets written to the user's library, so it
      -- fails closed.
      -- Every CTE below is MATERIALIZED and every join is a rowid or indexed
      -- lookup, both on purpose. Written the obvious way, SQLite drives the ISRC
      -- tier from the (provider, isrc) index and full-scans 76k provider items
      -- per edition: measured at 7.4s for this one release group versus 22ms
      -- without the tier. Shaped as below it is 10ms. Re-check EXPLAIN QUERY PLAN
      -- after editing — a stray SCAN here is a curation-wide regression.
      WITH target_track AS MATERIALIZED (
        SELECT track.id, track.recording_id
        FROM Tracks track
        JOIN Recordings recording
          ON recording.id = track.recording_id
         AND recording.is_video = 0
        WHERE track.album_edition_id = ?
          AND track.recording_id IS NOT NULL
      ),
      -- Tier 1: the same canonical Recording. Strongest and cheapest.
      source_by_recording AS MATERIALIZED (
        SELECT target.id AS track_id, track_match.id AS provider_track_match_id
        FROM target_track target
        JOIN Tracks source_track
          ON source_track.recording_id = target.recording_id
        JOIN ProviderTrackMatches track_match
          ON track_match.track_id = source_track.id
         AND track_match.match_state = 'accepted'
      ),
      -- Tier 2: two provider tracks carrying the SAME ISRC.
      --
      -- An ISRC identifies a recording, so this is a genuine identity claim, not
      -- a resemblance. It matters because MusicBrainz frequently splits one
      -- album programme into separate Recording rows per edition while the
      -- provider keeps one ISRC throughout — measured on Amy Winehouse's Frank,
      -- where the Japanese and UK Super Deluxe editions share zero Recordings
      -- and the Japanese Recordings carry zero canonical ISRCs, yet 12 of their
      -- 13 core tracks share a TIDAL ISRC with the UK edition and agree on
      -- duration to the second. (The two MusicBrainz durations that *do* differ,
      -- by ±38s across an adjacent pair, are a CD index-point difference: the
      -- provider durations for both are identical.) Without this tier the UK
      -- edition is stuck at LOSSLESS while the same audio sits in a Hi-Res
      -- sibling that the planner cannot see.
      --
      -- Two deliberate limits keep it honest and cheap:
      --   * same provider — two providers' ISRC metadata for one release can
      --     disagree, and this is the identity claim, so take the stricter read;
      --   * same release group — a compilation appearance of the same recording
      --     is a different product decision, not this Edition's material. Lift
      --     this only when a measured case needs it.
      --
      -- It establishes the musical slot, nothing else: explicitness, presentation
      -- and quality are gated downstream exactly as for tier 1.
      target_isrc AS MATERIALIZED (
        SELECT DISTINCT
          anchored.track_id AS track_id,
          anchor_item.provider AS provider,
          anchor_item.isrc AS isrc
        FROM source_by_recording anchored
        JOIN ProviderTrackMatches anchor_match
          ON anchor_match.id = anchored.provider_track_match_id
        -- NOT INDEXED: this is a primary-key lookup, but leaving the partial
        -- (provider, isrc) index eligible is exactly what tempts SQLite into
        -- scanning it instead.
        JOIN ProviderItems anchor_item NOT INDEXED
          ON anchor_item.id = anchor_match.provider_track_item_id
        WHERE anchor_item.isrc IS NOT NULL
          AND anchor_item.isrc <> ''
      ),
      -- Scope first, then compare: the provider tracks of every provider release
      -- matched to any edition of THIS release group. Bounded by the release
      -- group, so the ISRC comparison never sees the whole catalogue.
      sibling_track AS MATERIALIZED (
        SELECT DISTINCT
          sibling_item.provider AS provider,
          sibling_item.isrc AS isrc,
          sibling_match.id AS provider_track_match_id
        FROM AlbumEditions sibling_edition
        JOIN ProviderEditionMatches sibling_release_match
          ON sibling_release_match.edition_id = sibling_edition.id
         AND sibling_release_match.match_state = 'accepted'
        JOIN ProviderEditionMembers sibling_member
          ON sibling_member.provider_edition_item_id = sibling_release_match.provider_edition_item_id
        JOIN ProviderItems sibling_item NOT INDEXED
          ON sibling_item.id = sibling_member.member_item_id
        JOIN ProviderTrackMatches sibling_match
          ON sibling_match.provider_edition_member_id = sibling_member.id
         AND sibling_match.match_state = 'accepted'
        WHERE sibling_edition.release_group_id = (
          SELECT release_group_id FROM AlbumEditions WHERE id = ?
        )
          AND sibling_item.isrc IS NOT NULL
          AND sibling_item.isrc <> ''
      ),
      -- UNION, not UNION ALL: a source reached by both tiers is one candidate.
      candidate_source AS MATERIALIZED (
        SELECT track_id, provider_track_match_id FROM source_by_recording
        UNION
        SELECT anchor.track_id, sibling.provider_track_match_id
        FROM target_isrc anchor
        JOIN sibling_track sibling
          ON sibling.provider = anchor.provider
         AND sibling.isrc = anchor.isrc
      )
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
      FROM candidate_source source_link
      JOIN Tracks target_track
        ON target_track.id = source_link.track_id
      JOIN ProviderTrackMatches track_match
        ON track_match.id = source_link.provider_track_match_id
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
      WHERE release_item.availability NOT IN (
          'unavailable', 'no_longer_available', 'geography_restricted',
          'entitlement_restricted', 'explicit_policy_ineligible', 'quality_unavailable'
        )
      ORDER BY release_match.id, target_track.id, track_match.id, track_variant.id, release_variant.id
    `).all(input.editionId, input.editionId) as CandidateRow[]);

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

    /**
     * Fingerprint of everything this plan is derived from — the policy *and*
     * the provider evidence.
     *
     * Plans were recomputed for every evaluated Edition on every pass, which is
     * work proportional to the catalogue rather than to what changed: a refresh
     * that altered nothing still rebuilt every plan in the library. But they
     * cannot simply be computed less often either, because curation reads them
     * to decide what to monitor and a stale plan means a stale decision.
     *
     * Hashing the inputs settles both. The candidate rows above are exactly
     * what the planner reasons over — every accepted match, every audio variant
     * and their availability — so a digest of them plus the policy is complete
     * by construction: if the digest is unchanged, no reachable input changed,
     * and the plans that exist are the plans this pass would produce.
     */
    const candidateDigest = crypto.createHash("sha256");
    for (const row of rows) {
      candidateDigest.update([
        row.provider_edition_match_id, row.relation, row.source_track_count,
        row.release_explicit, row.provider_edition_member_id, row.provider_track_match_id,
        row.track_id, row.track_explicit,
        row.track_variant_id, row.track_quality, row.track_codec, row.track_bitrate,
        row.track_bit_depth, row.track_sample_rate, row.track_availability,
        row.release_variant_id, row.release_quality, row.release_codec, row.release_bitrate,
        row.release_bit_depth, row.release_sample_rate, row.release_availability,
      ].join(""));
      candidateDigest.update("");
    }
    const policyHash = crypto.createHash("sha256").update(JSON.stringify({
      candidates: candidateDigest.digest("hex"),
      trackIds: orderedTrackIds,
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

    // Nothing this plan is derived from has changed, so rebuilding it would
    // reproduce it exactly. Skipping is what makes a refresh cheap without
    // letting curation read a stale plan: an input that *did* change lands in
    // the digest and the plan is rebuilt on the spot.
    //
    // A caller steering the outcome (an explicit provider preference, an
    // exclusive-source lock) is asking for a decision rather than for the
    // cached one, so those always recompute.
    if (input.preferredProviderEditionMatchId == null && input.exclusiveSource !== true) {
      const unchanged = this.repository.plansMatchFingerprint({
        libraryId: input.libraryId,
        editionId: input.editionId,
        plannerVersion: input.plannerVersion,
        policyHash,
      });
      if (unchanged) {
        planTimer.report(`edition ${input.editionId} (unchanged)`);
        return unchanged.selectedPlanId;
      }
    }

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
    const plans = planTimer.phase(`plan:enumerate[ed${input.editionId}]`, () => enumerateAcquisitionPlans({
      orderedTrackIds,
      profile,
      sources,
      providerPriority: input.providerPriority,
      preferredProviderEditionMatchId,
      exclusive: input.exclusiveSource === true,
      preferExplicit: getConfigSection("filtering").prefer_explicit !== false,
    }));
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
    const result = planTimer.phase("plan:persist", () => this.repository.replacePlans({
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
    }));
    planTimer.report(`edition ${input.editionId} (${sources.length} source(s), ${orderedTrackIds.length} track(s))`);
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
