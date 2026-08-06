import type Database from "better-sqlite3";
import {
  ProviderCatalogRepository,
  type ProviderAudioVariantInput,
  type ProviderCreditInput,
  type ProviderItemFacts,
} from "./provider-catalog-repository.js";
import {
  ProviderMatchRepository,
  type ProviderMatchDecision,
  type ProviderTrackMatchInput,
} from "../music/provider-match-repository.js";
import {
  assignRankedTrackMatches,
  describeTrackMatch,
  trackMatchMethodRank,
  TRACK_MATCH_THRESHOLD,
  type MatchProviderTrack,
  type MatchTargetTrack,
  type TrackMatchEvidence,
} from "../music/provider-track-matcher.js";

const MIN_AMBIGUITY_MARGIN = 0.1;

/** Same digit-strip rules as provider-release-group-matcher (UPC identity). */
function normalizeBarcodeDigits(value?: string | null): string {
  const digits = String(value || "").replace(/\D+/g, "");
  if (!digits) return "";
  const stripped = digits.replace(/^0+/, "");
  return stripped || "0";
}

/**
 * Ambiguity is judged *within an evidence tier*. A rival supported by weaker
 * evidence cannot cast doubt on a stronger match however close its score: an
 * ISRC match is not made doubtful by a title coincidence, and a proven
 * medium+position+duration slot is not made doubtful by a same-title track
 * sitting elsewhere on the release. Comparing raw scores across tiers is what
 * used to reject structurally certain matches and leave canonical tracks
 * uncovered.
 */
function marginWithinTier(
  best: TrackMatchEvidence,
  rivals: readonly TrackMatchEvidence[],
): number {
  const bestRank = trackMatchMethodRank(best.method);
  let strongestRival = Number.NEGATIVE_INFINITY;
  for (const rival of rivals) {
    if (trackMatchMethodRank(rival.method) > bestRank) continue;
    if (rival.score > strongestRival) strongestRival = rival.score;
  }
  return strongestRival === Number.NEGATIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : best.score - strongestRival;
}

/** The best evidence in a list, strongest tier first then highest score. */
function bestEvidence(evidence: readonly TrackMatchEvidence[]): TrackMatchEvidence {
  let best: TrackMatchEvidence = { score: 0, method: "none" };
  for (const candidate of evidence) {
    const better = trackMatchMethodRank(candidate.method) < trackMatchMethodRank(best.method)
      || (trackMatchMethodRank(candidate.method) === trackMatchMethodRank(best.method)
        && candidate.score > best.score);
    if (better) best = candidate;
  }
  return best;
}

/**
 * Persisted margins are score differences, so they live in 0..1. "No rival at
 * this tier" is maximal confidence, recorded as 1 rather than Infinity, which
 * SQLite cannot store.
 */
function persistableMargin(margin: number): number {
  return Number.isFinite(margin) ? Math.max(0, Math.min(1, margin)) : 1;
}

/**
 * Margin of the best evidence in a list against the strongest rival of at least
 * the same tier, excluding the best entry itself.
 */
function tierAwareMargin(evidence: readonly TrackMatchEvidence[]): number {
  const best = bestEvidence(evidence);
  const rivals: TrackMatchEvidence[] = [];
  let skippedBest = false;
  for (const candidate of evidence) {
    if (!skippedBest && candidate === best) {
      skippedBest = true;
      continue;
    }
    rivals.push(candidate);
  }
  return marginWithinTier(best, rivals);
}

export interface ProviderArtistCreditFacts {
  providerId: string;
  name: string;
  ordinal: number;
  joinPhrase?: string;
  normalizedRole?: ProviderCreditInput["normalizedRole"];
  providerRole?: string | null;
}

export interface ProviderReleaseMemberFacts {
  item: ProviderItemFacts & { entityType: "track" | "video" };
  mediumPosition: number;
  position: number;
  number?: string | null;
  contextualTitle?: string | null;
  contextualDurationMs?: number | null;
  credits?: readonly ProviderArtistCreditFacts[];
  audioVariants?: readonly ProviderAudioVariantInput[];
}

export interface ProviderReleaseIngestionInput {
  release: ProviderItemFacts & { entityType: "release" };
  canonicalReleaseId: number;
  releaseCredits?: readonly ProviderArtistCreditFacts[];
  releaseAudioVariants?: readonly ProviderAudioVariantInput[];
  members: readonly ProviderReleaseMemberFacts[];
  matcherVersion: number;
  decisionSource?: ProviderMatchDecision["decisionSource"];
}

interface CanonicalTrack {
  id: number;
  recordingId: number;
  target: MatchTargetTrack;
}

type AudioSource = {
  member: ProviderReleaseMemberFacts;
  memberId: number;
};

function normalizeIsrcs(value: string | null): Set<string> {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return new Set(
      (Array.isArray(parsed) ? parsed : [])
        .map((isrc) => String(isrc || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, ""))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function normalizeProviderIsrc(value: string | null | undefined): string {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Adapt a provider edition member into the shared matcher's shape.
 *
 * The member row — not the item — carries this release's structure: an item is
 * one provider track identity that can appear on several releases at different
 * positions, so medium/position/contextual title/duration only mean anything in
 * membership context. Feeding the matcher nulls for them threw away the exact
 * evidence it is built around and left it guessing from the title alone, which
 * is how "Distorted Light Beam (reprise)" on disc 2 went unmatched while the
 * provider had it at precisely disc 2 track 4 with an identical runtime.
 *
 * Contextual fields win when present: a release can retitle or edit a track
 * relative to the standalone item.
 */
function providerTrack(member: ProviderReleaseMemberFacts): MatchProviderTrack {
  const { item } = member;
  const durationMs = member.contextualDurationMs ?? item.durationMs;
  return {
    mbid: null,
    isrc: item.isrc || null,
    title: member.contextualTitle || item.title || "",
    version: item.version || null,
    trackNumber: member.position,
    volumeNumber: member.mediumPosition,
    durationSec: durationMs == null ? null : durationMs / 1000,
  };
}

export class ProviderReleaseIngestionService {
  private readonly catalog: ProviderCatalogRepository;
  private readonly matches: ProviderMatchRepository;

  constructor(private readonly db: Database.Database) {
    this.catalog = new ProviderCatalogRepository(db);
    this.matches = new ProviderMatchRepository(db);
  }

  /**
   * Persist a provider release and publish typed matches against the editions
   * it is allowed to cover.
   *
   * **Identity exclusivity (local-MB / rich metadata):**
   * When the provider release has a UPC that matches one or more
   * `AlbumEditions.barcode` values, only those editions receive matches — no
   * soft title/duration fan-out to other siblings (the Frank Japan problem).
   * Multiple UPC hits are all kept. Track-level ISRC hits similarly lock that
   * provider track to identity targets only (see {@link matchAgainstEdition}).
   *
   * **Soft path (Servarr / no UPC):** primary edition plus fan-out to siblings
   * and same-artist subset hosts, with Munkres-style title/duration assignment.
   *
   * Planning still runs per edition later; this only decides which
   * ProviderEditionMatches rows exist.
   *
   * Return stats describe the caller's primary edition for a stable contract.
   */
  ingest(input: ProviderReleaseIngestionInput): {
    providerEditionItemId: number;
    releaseMatchId: number | null;
    acceptedTrackCount: number;
    ambiguousTrackCount: number;
  } {
    return this.db.transaction(() => {
      const providerEditionItemId = this.catalog.upsertItem(input.release);
      this.clearDependentAcquisitionPlans(providerEditionItemId);
      if (input.releaseAudioVariants) {
        this.catalog.replaceAudioVariants(providerEditionItemId, input.releaseAudioVariants);
      }
      if (input.releaseCredits) {
        this.catalog.replaceCredits(
          providerEditionItemId,
          this.materializeCredits(input.release.provider, input.releaseCredits),
        );
      }

      const memberRows = input.members.map((member) => {
        const memberItemId = this.catalog.upsertItem({
          ...member.item,
          provider: input.release.provider,
        });
        if (member.credits) {
          this.catalog.replaceCredits(
            memberItemId,
            this.materializeCredits(input.release.provider, member.credits),
          );
        }
        if (member.audioVariants) {
          this.catalog.replaceAudioVariants(memberItemId, member.audioVariants);
        }
        return { member, memberItemId };
      });
      const memberIds = this.catalog.replaceReleaseMembers(
        providerEditionItemId,
        memberRows.map(({ member, memberItemId }) => ({
          memberItemId,
          mediumPosition: member.mediumPosition,
          position: member.position,
          number: member.number,
          contextualTitle: member.contextualTitle,
          contextualDurationMs: member.contextualDurationMs,
        })),
      );

      const audioSources: AudioSource[] = memberRows
        .map(({ member }, index) => ({ member, memberId: memberIds[index] }))
        .filter(({ member }) => member.item.entityType === "track");

      const decisionSource = input.decisionSource || "automatic";
      const upcNorm = normalizeBarcodeDigits(input.release.upc);
      const upcEditionIds = upcNorm ? this.findEditionIdsByBarcode(upcNorm) : [];
      const identityMode = upcEditionIds.length > 0;

      const matchOne = (editionId: number) => this.matchAgainstEdition({
        providerEditionItemId,
        editionId,
        audioSources,
        matcherVersion: input.matcherVersion,
        decisionSource,
      });

      const matchedEditionIds = new Set<number>();
      const identityRecordings = new Set<number>();
      let primaryStats = {
        releaseMatchId: null as number | null,
        acceptedTrackCount: 0,
        ambiguousTrackCount: 0,
        acceptedRecordingIds: [] as number[],
      };

      const runMatch = (editionId: number): void => {
        if (matchedEditionIds.has(editionId)) return;
        matchedEditionIds.add(editionId);
        const result = matchOne(editionId);
        for (const id of result.identityRecordingIds) identityRecordings.add(id);
        if (editionId === input.canonicalReleaseId) {
          primaryStats = {
            releaseMatchId: result.releaseMatchId,
            acceptedTrackCount: result.acceptedTrackCount,
            ambiguousTrackCount: result.ambiguousTrackCount,
            acceptedRecordingIds: result.acceptedRecordingIds,
          };
        }
      };

      if (identityMode) {
        // UPC claims the product: match every barcode-tied edition only.
        for (const editionId of upcEditionIds) runMatch(editionId);
        // Caller stats: if preferred edition was not UPC-tied, leave counts at 0
        // (no soft match to non-UPC primary).
        if (!matchedEditionIds.has(input.canonicalReleaseId) && upcEditionIds.length > 0) {
          // Report the first UPC match as accepted coverage for callers that
          // only check acceptedTrackCount > 0.
          const first = this.db.prepare(`
            SELECT matched_track_count FROM ProviderEditionMatches
            WHERE provider_edition_item_id = ? AND edition_id = ? AND match_state = 'accepted'
          `).get(providerEditionItemId, upcEditionIds[0]) as { matched_track_count: number } | undefined;
          if (first && primaryStats.acceptedTrackCount === 0) {
            primaryStats.acceptedTrackCount = first.matched_track_count;
          }
        }
      } else {
        // Soft / Servarr path: the one edition this provider release is.
        runMatch(input.canonicalReleaseId);
      }

      return {
        providerEditionItemId,
        releaseMatchId: primaryStats.releaseMatchId,
        acceptedTrackCount: primaryStats.acceptedTrackCount,
        ambiguousTrackCount: primaryStats.ambiguousTrackCount,
      };
    })();
  }

  /** Editions whose barcode equals the provider UPC (after digit normalize). */
  private findEditionIdsByBarcode(normalizedUpc: string): number[] {
    if (!normalizedUpc) return [];
    const rows = this.db.prepare(`
      SELECT id, barcode FROM AlbumEditions
      WHERE barcode IS NOT NULL AND TRIM(barcode) != ''
    `).all() as Array<{ id: number; barcode: string }>;
    return rows
      .filter((row) => normalizeBarcodeDigits(row.barcode) === normalizedUpc)
      .map((row) => row.id);
  }

  private releaseGroupIdOf(editionId: number): number | null {
    const row = this.db.prepare(`
      SELECT release_group_id FROM AlbumEditions WHERE id = ?
    `).get(editionId) as { release_group_id: number } | undefined;
    return row?.release_group_id ?? null;
  }

  /**
   * Drop a fan-out match that we decided after the fact should not exist.
   * Track matches cascade from the edition match row.
   */
  private clearEditionMatch(providerEditionItemId: number, editionId: number): void {
    this.db.prepare(`
      DELETE FROM ProviderEditionMatches
      WHERE provider_edition_item_id = ?
        AND edition_id = ?
        AND decision_source != 'manual'
    `).run(providerEditionItemId, editionId);
  }

  private loadCanonicalTracks(editionId: number): CanonicalTrack[] {
    const canonicalTracks = this.db.prepare(`
      SELECT
        track.id,
        track.recording_id,
        recording.mbid AS recording_mbid,
        recording.isrcs,
        track.title,
        track.length_ms,
        track.position,
        track.medium_position
      FROM Tracks track
      JOIN Recordings recording ON recording.id = track.recording_id
      WHERE track.album_edition_id = ? AND recording.is_video = 0
      ORDER BY track.medium_position, track.position, track.id
    `).all(editionId) as Array<{
      id: number;
      recording_id: number;
      recording_mbid: string;
      isrcs: string | null;
      title: string;
      length_ms: number | null;
      position: number;
      medium_position: number;
    }>;
    return canonicalTracks.map((track) => ({
      id: track.id,
      recordingId: track.recording_id,
      target: {
        recordingMbid: track.recording_mbid,
        isrcs: normalizeIsrcs(track.isrcs),
        title: track.title,
        trackNumber: track.position,
        volumeNumber: track.medium_position,
        durationSec: track.length_ms == null ? null : track.length_ms / 1000,
      },
    }));
  }

  private matchAgainstEdition(input: {
    providerEditionItemId: number;
    editionId: number;
    audioSources: readonly AudioSource[];
    matcherVersion: number;
    decisionSource: ProviderMatchDecision["decisionSource"];
  }): {
    releaseMatchId: number | null;
    acceptedTrackCount: number;
    ambiguousTrackCount: number;
    acceptedRecordingIds: number[];
    /** Recordings accepted via ISRC/MBID identity (not soft title/duration). */
    identityRecordingIds: number[];
    relation: string | null;
  } {
    const targets = this.loadCanonicalTracks(input.editionId);
    if (targets.length === 0 || input.audioSources.length === 0) {
      return {
        releaseMatchId: null,
        acceptedTrackCount: 0,
        ambiguousTrackCount: 0,
        acceptedRecordingIds: [],
        identityRecordingIds: [],
        relation: null,
      };
    }

    const audioSources = input.audioSources.map((source, sourceIndex) => ({
      ...source,
      sourceIndex,
    }));
    const evidence = audioSources.map(({ member }) =>
      targets.map((target) => describeTrackMatch(target.target, providerTrack(member))));

    // Identity exclusivity per provider track: if any target hits via ISRC/MBID
    // (external_id), drop soft edges for that source so Munkres cannot also
    // assign the same track to a different recording by title/duration.
    for (let sourceIndex = 0; sourceIndex < evidence.length; sourceIndex += 1) {
      const hasIdentity = evidence[sourceIndex].some(
        (row) => row.method === "external_id" && row.score >= TRACK_MATCH_THRESHOLD,
      );
      if (!hasIdentity) continue;
      for (let targetIndex = 0; targetIndex < evidence[sourceIndex].length; targetIndex += 1) {
        if (evidence[sourceIndex][targetIndex].method !== "external_id") {
          evidence[sourceIndex][targetIndex] = { score: 0, method: "none" };
        }
      }
    }

    const sourceMargins = evidence.map((sourceEvidence) => tierAwareMargin(sourceEvidence));
    const targetMargins = targets.map((_, targetIndex) =>
      tierAwareMargin(evidence.map((sourceEvidence) => sourceEvidence[targetIndex])));
    const edges = targets.map((_target, targetIndex) =>
      audioSources.map((source) => ({
        sourceKey: String(source.memberId),
        source,
        matchScore: evidence[source.sourceIndex][targetIndex].score || 0,
        method: evidence[source.sourceIndex][targetIndex].method,
      }))
        .filter((edge) => {
          if (edge.matchScore < TRACK_MATCH_THRESHOLD) return false;
          if (edge.matchScore === 1) return true;
          return sourceMargins[edge.source.sourceIndex] >= MIN_AMBIGUITY_MARGIN
            && targetMargins[targetIndex] >= MIN_AMBIGUITY_MARGIN;
        })
        .sort((left, right) =>
          trackMatchMethodRank(left.method) - trackMatchMethodRank(right.method)
          || right.matchScore - left.matchScore
          || left.sourceKey.localeCompare(right.sourceKey)),
    );
    const accepted = assignRankedTrackMatches(edges);
    const acceptedSourceIndexes = new Set(
      [...accepted.values()].map((edge) => edge.source.sourceIndex),
    );
    const trackMatches: ProviderTrackMatchInput[] = [];
    const acceptedRecordingIds: number[] = [];
    const identityRecordingIds: number[] = [];
    for (const [targetIndex, edge] of accepted) {
      const target = targets[targetIndex];
      const durationMs = edge.source.member.contextualDurationMs
        ?? edge.source.member.item.durationMs;
      const targetDurationMs = target.target.durationSec == null
        ? null
        : target.target.durationSec * 1000;
      acceptedRecordingIds.push(target.recordingId);
      if (edge.method === "external_id") {
        identityRecordingIds.push(target.recordingId);
      }
      trackMatches.push({
        providerEditionMemberId: edge.source.memberId,
        trackId: target.id,
        recordingId: target.recordingId,
        matchState: "accepted",
        decisionSource: input.decisionSource,
        confidence: edge.matchScore,
        method: edge.method,
        evidence: { source: "normalized-provider-release-ingestion" },
        matcherVersion: input.matcherVersion,
        durationDeltaMs: durationMs == null || targetDurationMs == null
          ? null
          : Math.round(durationMs - targetDurationMs),
        ambiguityMargin: persistableMargin(Math.min(
          sourceMargins[edge.source.sourceIndex],
          targetMargins[targetIndex],
        )),
      });
    }
    for (let sourceIndex = 0; sourceIndex < audioSources.length; sourceIndex += 1) {
      if (acceptedSourceIndexes.has(sourceIndex)) continue;
      const rankedTargets = targets
        .map((target, targetIndex) => ({
          target,
          score: evidence[sourceIndex][targetIndex].score || 0,
          method: evidence[sourceIndex][targetIndex].method,
          targetIndex,
        }))
        .sort((left, right) =>
          trackMatchMethodRank(left.method) - trackMatchMethodRank(right.method)
          || right.score - left.score
          || left.target.id - right.target.id);
      const best = rankedTargets[0];
      if (!best || best.score < TRACK_MATCH_THRESHOLD) continue;
      trackMatches.push({
        providerEditionMemberId: audioSources[sourceIndex].memberId,
        trackId: null,
        recordingId: best.target.recordingId,
        matchState: "ambiguous",
        decisionSource: input.decisionSource,
        confidence: best.score,
        method: "ambiguous",
        evidence: { source: "normalized-provider-release-ingestion" },
        matcherVersion: input.matcherVersion,
        ambiguityMargin: persistableMargin(Math.min(
          sourceMargins[sourceIndex],
          targetMargins[best.targetIndex],
        )),
      });
    }

    const acceptedTrackCount = trackMatches.filter((match) => match.matchState === "accepted").length;
    const ambiguousTrackCount = trackMatches.filter((match) => match.matchState === "ambiguous").length;
    if (acceptedTrackCount === 0) {
      return {
        releaseMatchId: null,
        acceptedTrackCount,
        ambiguousTrackCount,
        acceptedRecordingIds: [],
        identityRecordingIds: [],
        relation: null,
      };
    }
    const result = this.matches.replaceReleaseMatch({
      providerEditionItemId: input.providerEditionItemId,
      editionId: input.editionId,
      decision: {
        matchState: "accepted",
        decisionSource: input.decisionSource,
        confidence: acceptedTrackCount / Math.max(targets.length, audioSources.length, 1),
        method: "normalized_track_assignment",
        evidence: { ambiguousTrackCount },
        matcherVersion: input.matcherVersion,
      },
      targetTrackIds: new Set(targets.map((target) => target.id)),
      sourceMemberIds: new Set(audioSources.map((source) => source.memberId)),
      trackMatches,
    });
    return {
      releaseMatchId: result.releaseMatchId,
      acceptedTrackCount,
      ambiguousTrackCount,
      acceptedRecordingIds,
      identityRecordingIds,
      relation: result.relation.relation,
    };
  }

  /**
   * Drop the acquisition plans built on this provider release before its rows
   * are rewritten.
 *
   * Plan tracks point at both the track match and the exact audio variant they
   * would download, and neither reference carries an ON DELETE clause. Re-
   * ingesting replaces both, so a release that had ever been planned could not
   * be re-ingested at all: it failed on a foreign-key error. That is what froze
   * matching for an established catalog and kept a matcher fix from ever
   * reaching it.
   *
   * This has to run before any replace, not alongside the match rewrite — the
   * audio variants are replaced first.
   *
   * Plans are derived state, so the planner rebuilds them. The operator's
   * choice survives because a selection is remembered by stable plan_key on
   * LibraryEditions, not by plan row id. Composites are caught too: a composite
   * that draws on this release records it as one of its sources.
   */
  private clearDependentAcquisitionPlans(providerEditionItemId: number): void {
    // Plans reference this release three ways, and none of the track-level
    // foreign keys cascade: sources point at the edition match, plan tracks
    // point at individual track matches, and plan tracks also pin the exact
    // audio variant they would download. Replacing members or variants without
    // clearing all three leaves dangling FKs and aborts re-ingest mid-flight —
    // which is how a rematch of Bastille's MAX release (and many siblings)
    // failed with "FOREIGN KEY constraint failed" after fan-out had already
    // created plans against the new matches.
    this.db.prepare(`
      DELETE FROM AcquisitionPlans
      WHERE id IN (
        SELECT source.plan_id
        FROM AcquisitionPlanSources source
        JOIN ProviderEditionMatches edition_match
          ON edition_match.id = source.provider_edition_match_id
        WHERE edition_match.provider_edition_item_id = ?
        UNION
        SELECT plan_track.plan_id
        FROM AcquisitionPlanTracks plan_track
        JOIN ProviderTrackMatches track_match
          ON track_match.id = plan_track.provider_track_match_id
        JOIN ProviderEditionMatches edition_match
          ON edition_match.id = track_match.provider_edition_match_id
        WHERE edition_match.provider_edition_item_id = ?
        UNION
        SELECT plan_track.plan_id
        FROM AcquisitionPlanTracks plan_track
        JOIN ProviderItemAudioVariants variant
          ON variant.id = plan_track.provider_audio_variant_id
        WHERE variant.provider_item_id = ?
           OR variant.provider_item_id IN (
             SELECT member.member_item_id
             FROM ProviderEditionMembers member
             WHERE member.provider_edition_item_id = ?
           )
      )
    `).run(
      providerEditionItemId,
      providerEditionItemId,
      providerEditionItemId,
      providerEditionItemId,
    );
  }

  private materializeCredits(
    provider: string,
    credits: readonly ProviderArtistCreditFacts[],
  ): ProviderCreditInput[] {
    return [...credits]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((credit) => {
        const artistItemId = this.catalog.upsertItem({
          provider,
          entityType: "artist",
          providerId: credit.providerId,
          title: credit.name,
          availability: "unknown",
        });
        return {
          artistItemId,
          ordinal: credit.ordinal,
          creditedName: credit.name,
          joinPhrase: credit.joinPhrase || "",
          normalizedRole: credit.normalizedRole || "other",
          providerRole: credit.providerRole,
        };
      });
  }
}
