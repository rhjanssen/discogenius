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

  ingest(input: ProviderReleaseIngestionInput): {
    providerEditionItemId: number;
    releaseMatchId: number | null;
    acceptedTrackCount: number;
    ambiguousTrackCount: number;
  } {
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
    `).all(input.canonicalReleaseId) as Array<{
      id: number;
      recording_id: number;
      recording_mbid: string;
      isrcs: string | null;
      title: string;
      length_ms: number | null;
      position: number;
      medium_position: number;
    }>;
    const targets: CanonicalTrack[] = canonicalTracks.map((track) => ({
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

    return this.db.transaction(() => {
      const providerEditionItemId = this.catalog.upsertItem(input.release);
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

      const audioSources = memberRows
        .map(({ member }, index) => ({ member, memberId: memberIds[index] }))
        .filter(({ member }) => member.item.entityType === "track");
      const evidence = audioSources.map(({ member }) =>
        targets.map((target) => describeTrackMatch(target.target, providerTrack(member))));
      const sourceMargins = evidence.map((sourceEvidence) => tierAwareMargin(sourceEvidence));
      const targetMargins = targets.map((_, targetIndex) =>
        tierAwareMargin(evidence.map((sourceEvidence) => sourceEvidence[targetIndex])));
      const edges = targets.map((target, targetIndex) =>
        audioSources.map((source, sourceIndex) => ({
          sourceKey: String(source.memberId),
          source: { ...source, sourceIndex },
          matchScore: evidence[sourceIndex][targetIndex].score || 0,
          method: evidence[sourceIndex][targetIndex].method,
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
      for (const [targetIndex, edge] of accepted) {
        const target = targets[targetIndex];
        const durationMs = edge.source.member.contextualDurationMs
          ?? edge.source.member.item.durationMs;
        const targetDurationMs = target.target.durationSec == null
          ? null
          : target.target.durationSec * 1000;
        trackMatches.push({
          providerEditionMemberId: edge.source.memberId,
          trackId: target.id,
          recordingId: target.recordingId,
          matchState: "accepted",
          decisionSource: input.decisionSource || "automatic",
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
          decisionSource: input.decisionSource || "automatic",
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
          providerEditionItemId,
          releaseMatchId: null,
          acceptedTrackCount,
          ambiguousTrackCount,
        };
      }
      const result = this.matches.replaceReleaseMatch({
        providerEditionItemId,
        editionId: input.canonicalReleaseId,
        decision: {
          matchState: "accepted",
          decisionSource: input.decisionSource || "automatic",
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
        providerEditionItemId,
        releaseMatchId: result.releaseMatchId,
        acceptedTrackCount,
        ambiguousTrackCount,
      };
    })();
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
