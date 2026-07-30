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
    const manualAccepted = input.decision.decisionSource === "automatic"
      && input.decision.matchState === "accepted"
      ? this.db.prepare(`
          SELECT id
          FROM ProviderArtistMatches
          WHERE provider_artist_item_id = ?
            AND artist_id != ?
            AND match_state = 'accepted'
            AND decision_source = 'manual'
          LIMIT 1
        `).get(input.providerArtistItemId, input.artistId) as { id: number } | undefined
      : undefined;
    const decision = manualAccepted
      ? {
          ...input.decision,
          matchState: "candidate" as const,
          method: `${input.decision.method}:blocked_by_manual`,
        }
      : input.decision;
    if (decision.matchState === "accepted") {
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
          AND (? = 'manual' OR decision_source != 'manual')
      `).run(
        decision.decisionSource,
        decision.matcherVersion,
        input.providerArtistItemId,
        input.artistId,
        decision.decisionSource,
      );
    }
    const row = this.db.prepare(`
      INSERT INTO ProviderArtistMatches (
        provider_artist_item_id, artist_id, match_state, decision_source,
        confidence, method, evidence, matcher_version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(provider_artist_item_id, artist_id) DO UPDATE SET
        match_state = CASE WHEN ProviderArtistMatches.decision_source = 'manual'
          AND excluded.decision_source = 'automatic'
          THEN ProviderArtistMatches.match_state ELSE excluded.match_state END,
        decision_source = CASE WHEN ProviderArtistMatches.decision_source = 'manual'
          AND excluded.decision_source = 'automatic'
          THEN ProviderArtistMatches.decision_source ELSE excluded.decision_source END,
        confidence = CASE WHEN ProviderArtistMatches.decision_source = 'manual'
          AND excluded.decision_source = 'automatic'
          THEN ProviderArtistMatches.confidence ELSE excluded.confidence END,
        method = CASE WHEN ProviderArtistMatches.decision_source = 'manual'
          AND excluded.decision_source = 'automatic'
          THEN ProviderArtistMatches.method ELSE excluded.method END,
        evidence = CASE WHEN ProviderArtistMatches.decision_source = 'manual'
          AND excluded.decision_source = 'automatic'
          THEN ProviderArtistMatches.evidence ELSE excluded.evidence END,
        matcher_version = CASE WHEN ProviderArtistMatches.decision_source = 'manual'
          AND excluded.decision_source = 'automatic'
          THEN ProviderArtistMatches.matcher_version ELSE excluded.matcher_version END,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `).get(
      input.providerArtistItemId,
      input.artistId,
      decision.matchState,
      decision.decisionSource,
      decision.confidence,
      decision.method,
      boundedEvidence(decision.evidence),
      decision.matcherVersion,
    ) as { id: number };
    return row.id;
  }

  upsertVideoMatch(input: {
    providerVideoItemId: number;
    recordingId: number;
    decision: ProviderMatchDecision;
  }): number {
    validateDecision(input.decision);
    const manualAccepted = input.decision.decisionSource === "automatic"
      && input.decision.matchState === "accepted"
      ? this.db.prepare(`
          SELECT id
          FROM ProviderVideoMatches
          WHERE provider_video_item_id = ?
            AND recording_id != ?
            AND match_state = 'accepted'
            AND decision_source = 'manual'
          LIMIT 1
        `).get(input.providerVideoItemId, input.recordingId) as { id: number } | undefined
      : undefined;
    const decision = manualAccepted
      ? {
          ...input.decision,
          matchState: "candidate" as const,
          method: `${input.decision.method}:blocked_by_manual`,
        }
      : input.decision;
    if (decision.matchState === "accepted") {
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
          AND (? = 'manual' OR decision_source != 'manual')
      `).run(
        decision.decisionSource,
        decision.matcherVersion,
        input.providerVideoItemId,
        input.recordingId,
        decision.decisionSource,
      );
    }
    const row = this.db.prepare(`
      INSERT INTO ProviderVideoMatches (
        provider_video_item_id, recording_id, match_state, decision_source,
        confidence, method, evidence, matcher_version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(provider_video_item_id, recording_id) DO UPDATE SET
        match_state = CASE WHEN ProviderVideoMatches.decision_source = 'manual'
          AND excluded.decision_source = 'automatic'
          THEN ProviderVideoMatches.match_state ELSE excluded.match_state END,
        decision_source = CASE WHEN ProviderVideoMatches.decision_source = 'manual'
          AND excluded.decision_source = 'automatic'
          THEN ProviderVideoMatches.decision_source ELSE excluded.decision_source END,
        confidence = CASE WHEN ProviderVideoMatches.decision_source = 'manual'
          AND excluded.decision_source = 'automatic'
          THEN ProviderVideoMatches.confidence ELSE excluded.confidence END,
        method = CASE WHEN ProviderVideoMatches.decision_source = 'manual'
          AND excluded.decision_source = 'automatic'
          THEN ProviderVideoMatches.method ELSE excluded.method END,
        evidence = CASE WHEN ProviderVideoMatches.decision_source = 'manual'
          AND excluded.decision_source = 'automatic'
          THEN ProviderVideoMatches.evidence ELSE excluded.evidence END,
        matcher_version = CASE WHEN ProviderVideoMatches.decision_source = 'manual'
          AND excluded.decision_source = 'automatic'
          THEN ProviderVideoMatches.matcher_version ELSE excluded.matcher_version END,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `).get(
      input.providerVideoItemId,
      input.recordingId,
      decision.matchState,
      decision.decisionSource,
      decision.confidence,
      decision.method,
      boundedEvidence(decision.evidence),
      decision.matcherVersion,
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
        INSERT INTO ProviderEditionMatches (
          provider_edition_item_id, edition_id, relation, match_state,
          decision_source, confidence, method, evidence, matcher_version,
          matched_track_count, source_track_count, target_track_count,
          source_coverage, target_coverage, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(provider_edition_item_id, edition_id) DO UPDATE SET
          relation = excluded.relation,
          match_state = CASE
            WHEN ProviderEditionMatches.decision_source = 'manual'
             AND excluded.decision_source = 'automatic'
              THEN ProviderEditionMatches.match_state
            ELSE excluded.match_state
          END,
          decision_source = CASE
            WHEN ProviderEditionMatches.decision_source = 'manual'
             AND excluded.decision_source = 'automatic'
              THEN ProviderEditionMatches.decision_source
            ELSE excluded.decision_source
          END,
          confidence = CASE
            WHEN ProviderEditionMatches.decision_source = 'manual'
             AND excluded.decision_source = 'automatic'
              THEN ProviderEditionMatches.confidence
            ELSE excluded.confidence
          END,
          method = CASE
            WHEN ProviderEditionMatches.decision_source = 'manual'
             AND excluded.decision_source = 'automatic'
              THEN ProviderEditionMatches.method
            ELSE excluded.method
          END,
          evidence = CASE
            WHEN ProviderEditionMatches.decision_source = 'manual'
             AND excluded.decision_source = 'automatic'
              THEN ProviderEditionMatches.evidence
            ELSE excluded.evidence
          END,
          matcher_version = CASE
            WHEN ProviderEditionMatches.decision_source = 'manual'
             AND excluded.decision_source = 'automatic'
              THEN ProviderEditionMatches.matcher_version
            ELSE excluded.matcher_version
          END,
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

      const preservedManual = input.decision.decisionSource === "automatic"
        ? this.db.prepare(`
            SELECT provider_edition_member_id, track_id, recording_id, match_state
            FROM ProviderTrackMatches
            WHERE provider_edition_match_id = ? AND decision_source = 'manual'
          `).all(releaseMatch.id) as Array<{
            provider_edition_member_id: number;
            track_id: number | null;
            recording_id: number;
            match_state: ProviderMatchState;
          }>
        : [];
      if (input.decision.decisionSource === "automatic") {
        this.db.prepare(`
          DELETE FROM ProviderTrackMatches
          WHERE provider_edition_match_id = ? AND decision_source != 'manual'
        `).run(releaseMatch.id);
      } else {
        this.db.prepare("DELETE FROM ProviderTrackMatches WHERE provider_edition_match_id = ?")
          .run(releaseMatch.id);
      }
      const manualSourceIds = new Set(
        preservedManual.map((match) => match.provider_edition_member_id),
      );
      const manualTargetTrackIds = new Set(
        preservedManual
          .filter((match) => match.match_state === "accepted" && match.track_id != null)
          .map((match) => match.track_id as number),
      );
      const manualRecordingIds = new Set(
        preservedManual
          .filter((match) => match.match_state === "accepted")
          .map((match) => match.recording_id),
      );
      const insertTrackMatch = this.db.prepare(`
        INSERT INTO ProviderTrackMatches (
          provider_edition_member_id, provider_edition_match_id, track_id,
          recording_id, match_state, decision_source, confidence, method,
          evidence, matcher_version, duration_delta_ms, ambiguity_margin,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);
      for (const match of input.trackMatches) {
        if (
          match.decisionSource === "automatic"
          && (
            manualSourceIds.has(match.providerReleaseMemberId)
            || (match.trackId != null && manualTargetTrackIds.has(match.trackId))
            || manualRecordingIds.has(match.recordingId)
          )
        ) {
          continue;
        }
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
