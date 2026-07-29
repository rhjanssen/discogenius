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
  scoreTrackMatch,
  TRACK_MATCH_THRESHOLD,
  type MatchProviderTrack,
  type MatchTargetTrack,
} from "../music/provider-track-matcher.js";

const MIN_AMBIGUITY_MARGIN = 0.1;

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

function providerTrack(item: ProviderItemFacts): MatchProviderTrack {
  return {
    mbid: null,
    isrc: item.isrc || null,
    title: item.title || "",
    version: item.version || null,
    trackNumber: null,
    volumeNumber: null,
    durationSec: item.durationMs == null ? null : item.durationMs / 1000,
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
    providerReleaseItemId: number;
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
      WHERE track.album_release_id = ? AND recording.is_video = 0
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
      const providerReleaseItemId = this.catalog.upsertItem(input.release);
      if (input.releaseAudioVariants) {
        this.catalog.replaceAudioVariants(providerReleaseItemId, input.releaseAudioVariants);
      }
      if (input.releaseCredits) {
        this.catalog.replaceCredits(
          providerReleaseItemId,
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
        providerReleaseItemId,
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
      const scores = audioSources.map(({ member }) =>
        targets.map((target) => scoreTrackMatch(target.target, providerTrack(member.item))));
      const sourceMargins = scores.map((sourceScores) => {
        const ranked = [...sourceScores].sort((left, right) => right - left);
        return (ranked[0] ?? 0) - (ranked[1] ?? 0);
      });
      const targetMargins = targets.map((_, targetIndex) => {
        const ranked = scores.map((sourceScores) => sourceScores[targetIndex] || 0)
          .sort((left, right) => right - left);
        return (ranked[0] ?? 0) - (ranked[1] ?? 0);
      });
      const edges = targets.map((target, targetIndex) =>
        audioSources.map((source, sourceIndex) => ({
          sourceKey: String(source.memberId),
          source: { ...source, sourceIndex },
          matchScore: scores[sourceIndex][targetIndex] || 0,
        }))
          .filter((edge) => {
            if (edge.matchScore < TRACK_MATCH_THRESHOLD) return false;
            if (edge.matchScore === 1) return true;
            return sourceMargins[edge.source.sourceIndex] >= MIN_AMBIGUITY_MARGIN
              && targetMargins[targetIndex] >= MIN_AMBIGUITY_MARGIN;
          })
          .sort((left, right) =>
            right.matchScore - left.matchScore
            || left.sourceKey.localeCompare(right.sourceKey)),
      );
      const accepted = assignRankedTrackMatches(edges);
      const acceptedSourceIndexes = new Set(
        [...accepted.values()].map((edge) => edge.source.sourceIndex),
      );
      const trackMatches: ProviderTrackMatchInput[] = [];
      for (const [targetIndex, edge] of accepted) {
        const target = targets[targetIndex];
        const durationMs = edge.source.member.item.durationMs;
        const targetDurationMs = target.target.durationSec == null
          ? null
          : target.target.durationSec * 1000;
        trackMatches.push({
          providerReleaseMemberId: edge.source.memberId,
          trackId: target.id,
          recordingId: target.recordingId,
          matchState: "accepted",
          decisionSource: input.decisionSource || "automatic",
          confidence: edge.matchScore,
          method: edge.matchScore === 1 ? "external_id" : "title_duration",
          evidence: { source: "normalized-provider-release-ingestion" },
          matcherVersion: input.matcherVersion,
          durationDeltaMs: durationMs == null || targetDurationMs == null
            ? null
            : Math.round(durationMs - targetDurationMs),
          ambiguityMargin: Math.min(
            sourceMargins[edge.source.sourceIndex],
            targetMargins[targetIndex],
          ),
        });
      }
      for (let sourceIndex = 0; sourceIndex < audioSources.length; sourceIndex += 1) {
        if (acceptedSourceIndexes.has(sourceIndex)) continue;
        const rankedTargets = targets
          .map((target, targetIndex) => ({
            target,
            score: scores[sourceIndex][targetIndex] || 0,
            targetIndex,
          }))
          .sort((left, right) => right.score - left.score || left.target.id - right.target.id);
        const best = rankedTargets[0];
        if (!best || best.score < TRACK_MATCH_THRESHOLD) continue;
        trackMatches.push({
          providerReleaseMemberId: audioSources[sourceIndex].memberId,
          trackId: null,
          recordingId: best.target.recordingId,
          matchState: "ambiguous",
          decisionSource: input.decisionSource || "automatic",
          confidence: best.score,
          method: "title_duration_ambiguous",
          evidence: { source: "normalized-provider-release-ingestion" },
          matcherVersion: input.matcherVersion,
          ambiguityMargin: Math.min(
            sourceMargins[sourceIndex],
            targetMargins[best.targetIndex],
          ),
        });
      }

      const acceptedTrackCount = trackMatches.filter((match) => match.matchState === "accepted").length;
      const ambiguousTrackCount = trackMatches.filter((match) => match.matchState === "ambiguous").length;
      if (acceptedTrackCount === 0) {
        return {
          providerReleaseItemId,
          releaseMatchId: null,
          acceptedTrackCount,
          ambiguousTrackCount,
        };
      }
      const result = this.matches.replaceReleaseMatch({
        providerReleaseItemId,
        releaseId: input.canonicalReleaseId,
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
        providerReleaseItemId,
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
