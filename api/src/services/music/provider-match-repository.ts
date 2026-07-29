import type Database from "better-sqlite3";
import {
  determineProviderReleaseRelation,
  type ProviderReleaseRelationResult,
} from "./provider-release-relation.js";

export type ProviderMatchState = "candidate" | "accepted" | "ambiguous" | "rejected";
export type ProviderDecisionSource = "automatic" | "manual";

export interface ProviderMatchDecision {
  matchState: ProviderMatchState;
  decisionSource: ProviderDecisionSource;
  confidence: number;
  method: string;
  evidence?: Record<string, unknown> | null;
  matcherVersion: number;
}

export interface ProviderTrackMatchInput extends ProviderMatchDecision {
  providerReleaseMemberId: number;
  trackId: number | null;
  recordingId: number;
  durationDeltaMs?: number | null;
  ambiguityMargin?: number | null;
}

function validateDecision(decision: ProviderMatchDecision): void {
  if (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
    throw new Error("Provider match confidence must be between 0 and 1");
  }
  if (!String(decision.method || "").trim()) throw new Error("Provider match method is required");
  if (!Number.isInteger(decision.matcherVersion) || decision.matcherVersion < 1) {
    throw new Error("Provider matcherVersion must be a positive integer");
  }
}

function boundedEvidence(value: Record<string, unknown> | null | undefined): string | null {
  if (!value) return null;
  const serialized = JSON.stringify(value);
  if (serialized.length > 8_192) throw new Error("Provider match evidence exceeds 8 KiB");
  return serialized;
}

export class ProviderMatchRepository {
  constructor(private readonly db: Database.Database) {}

  upsertArtistMatch(input: {
    providerArtistItemId: number;
    artistId: number;
    decision: ProviderMatchDecision;
  }): number {
    validateDecision(input.decision);
    if (input.decision.matchState === "accepted") {
      this.db.prepare(`
        UPDATE ProviderArtistMatches
        SET match_state = 'rejected',
            decision_source = ?,
            method = 'superseded',
            matcher_version = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE provider_artist_item_id = ?
          AND artist_id != ?
          AND match_state = 'accepted'
      `).run(
        input.decision.decisionSource,
        input.decision.matcherVersion,
        input.providerArtistItemId,
        input.artistId,
      );
    }
    const row = this.db.prepare(`
      INSERT INTO ProviderArtistMatches (
        provider_artist_item_id, artist_id, match_state, decision_source,
        confidence, method, evidence, matcher_version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(provider_artist_item_id, artist_id) DO UPDATE SET
        match_state = excluded.match_state,
        decision_source = excluded.decision_source,
        confidence = excluded.confidence,
        method = excluded.method,
        evidence = excluded.evidence,
        matcher_version = excluded.matcher_version,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `).get(
      input.providerArtistItemId,
      input.artistId,
      input.decision.matchState,
      input.decision.decisionSource,
      input.decision.confidence,
      input.decision.method,
      boundedEvidence(input.decision.evidence),
      input.decision.matcherVersion,
    ) as { id: number };
    return row.id;
  }

  upsertVideoMatch(input: {
    providerVideoItemId: number;
    recordingId: number;
    decision: ProviderMatchDecision;
  }): number {
    validateDecision(input.decision);
    if (input.decision.matchState === "accepted") {
      this.db.prepare(`
        UPDATE ProviderVideoMatches
        SET match_state = 'rejected',
            decision_source = ?,
            method = 'superseded',
            matcher_version = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE provider_video_item_id = ?
          AND recording_id != ?
          AND match_state = 'accepted'
      `).run(
        input.decision.decisionSource,
        input.decision.matcherVersion,
        input.providerVideoItemId,
        input.recordingId,
      );
    }
    const row = this.db.prepare(`
      INSERT INTO ProviderVideoMatches (
        provider_video_item_id, recording_id, match_state, decision_source,
        confidence, method, evidence, matcher_version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(provider_video_item_id, recording_id) DO UPDATE SET
        match_state = excluded.match_state,
        decision_source = excluded.decision_source,
        confidence = excluded.confidence,
        method = excluded.method,
        evidence = excluded.evidence,
        matcher_version = excluded.matcher_version,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `).get(
      input.providerVideoItemId,
      input.recordingId,
      input.decision.matchState,
      input.decision.decisionSource,
      input.decision.confidence,
      input.decision.method,
      boundedEvidence(input.decision.evidence),
      input.decision.matcherVersion,
    ) as { id: number };
    return row.id;
  }

  replaceReleaseMatch(input: {
    providerReleaseItemId: number;
    releaseId: number;
    decision: ProviderMatchDecision;
    targetTrackIds: ReadonlySet<number>;
    sourceMemberIds: ReadonlySet<number>;
    trackMatches: readonly ProviderTrackMatchInput[];
  }): { releaseMatchId: number; relation: ProviderReleaseRelationResult } {
    validateDecision(input.decision);
    for (const trackMatch of input.trackMatches) validateDecision(trackMatch);

    const acceptedAssignments = input.trackMatches
      .filter((match) => match.matchState === "accepted" && match.trackId != null)
      .map((match) => ({
        sourceMemberId: match.providerReleaseMemberId,
        targetTrackId: match.trackId!,
      }));
    const relation = determineProviderReleaseRelation({
      targetTrackIds: input.targetTrackIds,
      sourceMemberIds: input.sourceMemberIds,
      acceptedAssignments,
    });
    if (!relation.relation) throw new Error("Cannot persist a provider release match without accepted track overlap");

    return this.db.transaction(() => {
      const releaseMatch = this.db.prepare(`
        INSERT INTO ProviderReleaseMatches (
          provider_release_item_id, release_id, relation, match_state,
          decision_source, confidence, method, evidence, matcher_version,
          matched_track_count, source_track_count, target_track_count,
          source_coverage, target_coverage, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(provider_release_item_id, release_id) DO UPDATE SET
          relation = excluded.relation,
          match_state = excluded.match_state,
          decision_source = excluded.decision_source,
          confidence = excluded.confidence,
          method = excluded.method,
          evidence = excluded.evidence,
          matcher_version = excluded.matcher_version,
          matched_track_count = excluded.matched_track_count,
          source_track_count = excluded.source_track_count,
          target_track_count = excluded.target_track_count,
          source_coverage = excluded.source_coverage,
          target_coverage = excluded.target_coverage,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `).get(
        input.providerReleaseItemId,
        input.releaseId,
        relation.relation,
        input.decision.matchState,
        input.decision.decisionSource,
        input.decision.confidence,
        input.decision.method,
        boundedEvidence(input.decision.evidence),
        input.decision.matcherVersion,
        relation.matchedTrackCount,
        relation.sourceTrackCount,
        relation.targetTrackCount,
        relation.sourceCoverage,
        relation.targetCoverage,
      ) as { id: number };

      this.db.prepare("DELETE FROM ProviderTrackMatches WHERE provider_release_match_id = ?")
        .run(releaseMatch.id);
      const insertTrackMatch = this.db.prepare(`
        INSERT INTO ProviderTrackMatches (
          provider_release_member_id, provider_release_match_id, track_id,
          recording_id, match_state, decision_source, confidence, method,
          evidence, matcher_version, duration_delta_ms, ambiguity_margin,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);
      for (const match of input.trackMatches) {
        insertTrackMatch.run(
          match.providerReleaseMemberId,
          releaseMatch.id,
          match.trackId,
          match.recordingId,
          match.matchState,
          match.decisionSource,
          match.confidence,
          match.method,
          boundedEvidence(match.evidence),
          match.matcherVersion,
          match.durationDeltaMs ?? null,
          match.ambiguityMargin ?? null,
        );
      }
      return { releaseMatchId: releaseMatch.id, relation };
    })();
  }
}
