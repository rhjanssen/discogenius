import type Database from "better-sqlite3";
import { invalidateAcquisitionPlans } from "../music/acquisition-plan-ownership.js";
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
import { replanMonitoredEditions, type MonitoredEditionRef } from "../music/acquisition-planning-service.js";
import { PROVIDER_TRACK_MATCHER_VERSION } from "../music/provider-track-matcher.js";
import { jsonList, SQL_JSON_LIST } from "../../utils/sql-id-list.js";

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

export interface StoredReplayDecision {
  editionId: number;
  acceptedTrackCount: number;
  ambiguousTrackCount: number;
  write: {
    decision: ProviderMatchDecision;
    targetTrackIds: number[];
    sourceMemberIds: number[];
    trackMatches: ProviderTrackMatchInput[];
  } | null;
}

export interface StoredReplayPlan {
  providerEditionItemId: number;
  matcherVersion: number;
  decisions: StoredReplayDecision[];
  acceptedTrackCount: number;
  ambiguousTrackCount: number;
}

export interface StoredReplayCommit {
  acceptedTrackCount: number;
  ambiguousTrackCount: number;
  retired: number;
  replan: MonitoredEditionRef[];
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

/** Same tolerance the matcher grants one recording measured twice. */
const SHARED_ITEM_DURATION_GRACE_MS = 10_000;

function normalizedContextTitle(member: ProviderReleaseMemberFacts): string {
  return String(member.contextualTitle || member.item.title || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Sources whose provider item fills several slots of this release that
 * describe different content.
 *
 * YouTube Music substitutes one official music video for every slot it has no
 * audio track for, so its "Everlasting" single lists xBbOVxfFuMc as both
 * "Everlasting" (2:38) and "Everlasting (Extended Mix)" (4:25). Each slot's
 * contextual title and runtime match a different canonical track perfectly,
 * but the item has one piece of audio, which is at most one of them. Matching
 * each slot on its own facts promised two recordings from one download, and the
 * import then rightly refused the file as ambiguous provenance.
 *
 * Which slot the audio really is cannot be read from the listing, so none of
 * them is accepted: the canonical tracks stay open for another provider. A
 * provider listing the same audio twice under the same title and runtime is
 * not a conflict when only one canonical track can claim it. When that same
 * listing is a viable match for two canonical tracks, {@link sharedItemSourcesToDrop}
 * refuses every slot: one download is still one recording.
 */
function sourcesWithConflictingSharedItem(audioSources: readonly AudioSource[]): Set<number> {
  const byItem = new Map<string, number[]>();
  audioSources.forEach((source, sourceIndex) => {
    const key = `${source.member.item.provider}:${source.member.item.providerId}`;
    const indexes = byItem.get(key) ?? [];
    indexes.push(sourceIndex);
    byItem.set(key, indexes);
  });
  const conflicted = new Set<number>();
  for (const indexes of byItem.values()) {
    if (indexes.length < 2) continue;
    const members = indexes.map((index) => audioSources[index].member);
    const titles = new Set(members.map(normalizedContextTitle));
    const durations = members
      .map((member) => member.contextualDurationMs ?? member.item.durationMs)
      .filter((value): value is number => value != null);
    const durationSpread = durations.length > 1
      ? Math.max(...durations) - Math.min(...durations)
      : 0;
    if (titles.size > 1 || durationSpread > SHARED_ITEM_DURATION_GRACE_MS) {
      for (const index of indexes) conflicted.add(index);
    }
  }
  return conflicted;
}

/**
 * Sources to withhold because one provider item is a viable match for more
 * than one canonical track.
 *
 * Version 4 only compared the provider's own slot titles and runtimes, so two
 * listings of the same item with the same title and a runtime inside the 10s
 * grace were both accepted. That is right when they describe one canonical
 * track listed twice, and wrong when they describe two: a multi-disc "Intro"
 * or a deluxe twin. The file that arrives has one identity, and the import
 * refuses it once two offers name that identity.
 *
 * Viability uses the same bar as the assignment edges (threshold, perfect
 * identity, and the tier margin). A duplicate listing of a single track is
 * left to the one-to-one assigner, which keeps one of them.
 */
function sharedItemSourcesToDrop(
  audioSources: readonly { member: ProviderReleaseMemberFacts; sourceIndex: number }[],
  evidence: readonly (readonly TrackMatchEvidence[])[],
  sourceMargins: readonly number[],
  targetMargins: readonly number[],
  alreadyConflicted: ReadonlySet<number>,
): Set<number> {
  const byItem = new Map<string, number[]>();
  for (const source of audioSources) {
    if (alreadyConflicted.has(source.sourceIndex)) continue;
    const key = `${source.member.item.provider}:${source.member.item.providerId}`;
    const indexes = byItem.get(key) ?? [];
    indexes.push(source.sourceIndex);
    byItem.set(key, indexes);
  }
  const dropped = new Set<number>();
  for (const indexes of byItem.values()) {
    if (indexes.length < 2) continue;
    const viableTargets = new Set<number>();
    for (const sourceIndex of indexes) {
      const row = evidence[sourceIndex] ?? [];
      for (let targetIndex = 0; targetIndex < row.length; targetIndex += 1) {
        const score = row[targetIndex]?.score || 0;
        if (score < TRACK_MATCH_THRESHOLD) continue;
        if (score !== 1
          && (sourceMargins[sourceIndex] < MIN_AMBIGUITY_MARGIN
            || targetMargins[targetIndex] < MIN_AMBIGUITY_MARGIN)) {
          continue;
        }
        viableTargets.add(targetIndex);
      }
    }
    if (viableTargets.size > 1) {
      for (const sourceIndex of indexes) dropped.add(sourceIndex);
    }
  }
  return dropped;
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
   * After the match rewrite, monitored editions that lost their cached plan
   * are replanned so Download Missing and the album page still see a current
   * selection.
   *
   * Return stats describe the caller's primary edition for a stable contract.
   */
  ingest(input: ProviderReleaseIngestionInput): {
    providerEditionItemId: number;
    releaseMatchId: number | null;
    acceptedTrackCount: number;
    ambiguousTrackCount: number;
  } {
    let droppedEditions: Array<{ libraryId: number; editionId: number }> = [];
    const result = this.db.transaction(() => {
      const providerEditionItemId = this.catalog.upsertItem(input.release);
      droppedEditions = this.invalidateDependentAcquisitionPlans(providerEditionItemId);
      if (input.releaseAudioVariants) {
        this.catalog.replaceAudioVariants(providerEditionItemId, input.releaseAudioVariants,
          { provider: input.release.provider });
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
    replanMonitoredEditions(this.db, droppedEditions);
    return result;
  }

  /** Editions whose barcode equals the provider UPC (after digit normalize). */
  private findEditionIdsByBarcode(normalizedUpc: string): number[] {
    if (!normalizedUpc) return [];
    return (this.db.prepare(`
      SELECT edition_id AS id FROM EditionBarcodeIndex WHERE barcode = ?
    `).all(normalizedUpc) as Array<{ id: number }>).map(row => row.id);
  }

  private releaseGroupIdOf(editionId: number): number | null {
    const row = this.db.prepare(`
      SELECT release_group_id FROM AlbumEditions WHERE id = ?
    `).get(editionId) as { release_group_id: number } | undefined;
    return row?.release_group_id ?? null;
  }

  private loadCanonicalTracks(editionId: number): CanonicalTrack[] {
    const canonicalTracks = this.db.prepare(`
      SELECT
        track.id,
        track.recording_id,
        recording.mbid AS recording_mbid,
        recording.isrcs,
        recording.title AS recording_title,
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
      recording_title: string | null;
      title: string;
      length_ms: number | null;
      position: number;
      medium_position: number;
    }>;
    const titlesByRecording = new Map<number, string[]>();
    if (canonicalTracks.length > 0) {
      const recordingIds = [...new Set(canonicalTracks.map((track) => track.recording_id))];
      const siblingTitles = this.db.prepare(`
        SELECT sibling.recording_id AS recording_id, sibling.title AS title
        FROM Tracks sibling
        JOIN AlbumEditions sibling_edition ON sibling_edition.id = sibling.album_edition_id
        JOIN AlbumEditions target_edition ON target_edition.id = ?
        WHERE sibling_edition.release_group_id = target_edition.release_group_id
          AND sibling.recording_id IN ${SQL_JSON_LIST}
      `).all(editionId, jsonList(recordingIds)) as Array<{ recording_id: number; title: string | null }>;
      for (const row of siblingTitles) {
        const title = String(row.title || "").trim();
        if (!title) continue;
        const titles = titlesByRecording.get(row.recording_id) ?? [];
        if (!titles.includes(title)) titles.push(title);
        titlesByRecording.set(row.recording_id, titles);
      }
    }
    return canonicalTracks.map((track) => {
      const seen = new Set([String(track.title || "").trim()]);
      const alternateTitles: string[] = [];
      for (const name of [track.recording_title, ...(titlesByRecording.get(track.recording_id) ?? [])]) {
        const title = String(name || "").trim();
        if (!title || seen.has(title)) continue;
        seen.add(title);
        alternateTitles.push(title);
      }
      return {
        id: track.id,
        recordingId: track.recording_id,
        target: {
          recordingMbid: track.recording_mbid,
          isrcs: normalizeIsrcs(track.isrcs),
          title: track.title,
          alternateTitles,
          trackNumber: track.position,
          volumeNumber: track.medium_position,
          durationSec: track.length_ms == null ? null : track.length_ms / 1000,
        },
      };
    });
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
    const built = this.buildEditionMatch(input);
    if (!built.write) {
      return {
        releaseMatchId: null,
        acceptedTrackCount: built.acceptedTrackCount,
        ambiguousTrackCount: built.ambiguousTrackCount,
        acceptedRecordingIds: [],
        identityRecordingIds: [],
        relation: null,
      };
    }
    const result = this.matches.replaceReleaseMatch({
      providerEditionItemId: input.providerEditionItemId,
      editionId: input.editionId,
      decision: built.write.decision,
      targetTrackIds: new Set(built.write.targetTrackIds),
      sourceMemberIds: new Set(built.write.sourceMemberIds),
      trackMatches: built.write.trackMatches,
    });
    return {
      releaseMatchId: result.releaseMatchId,
      acceptedTrackCount: built.acceptedTrackCount,
      ambiguousTrackCount: built.ambiguousTrackCount,
      acceptedRecordingIds: built.acceptedRecordingIds,
      identityRecordingIds: built.identityRecordingIds,
      relation: result.relation.relation,
    };
  }

  /**
   * Score one edition from stored member rows. No writes: the caller commits.
   */
  private buildEditionMatch(input: {
    providerEditionItemId: number;
    editionId: number;
    audioSources: readonly AudioSource[];
    matcherVersion: number;
    decisionSource: ProviderMatchDecision["decisionSource"];
  }): {
    acceptedTrackCount: number;
    ambiguousTrackCount: number;
    acceptedRecordingIds: number[];
    identityRecordingIds: number[];
    write: {
      decision: ProviderMatchDecision;
      targetTrackIds: number[];
      sourceMemberIds: number[];
      trackMatches: ProviderTrackMatchInput[];
    } | null;
  } {
    const targets = this.loadCanonicalTracks(input.editionId);
    if (targets.length === 0 || input.audioSources.length === 0) {
      return {
        acceptedTrackCount: 0,
        ambiguousTrackCount: 0,
        acceptedRecordingIds: [],
        identityRecordingIds: [],
        write: null,
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

    const conflictedSources = sourcesWithConflictingSharedItem(audioSources);
    const sourceMargins = evidence.map((sourceEvidence) => tierAwareMargin(sourceEvidence));
    const targetMargins = targets.map((_, targetIndex) =>
      tierAwareMargin(evidence.map((sourceEvidence) => sourceEvidence[targetIndex])));
    for (const sourceIndex of sharedItemSourcesToDrop(
      audioSources,
      evidence,
      sourceMargins,
      targetMargins,
      conflictedSources,
    )) {
      conflictedSources.add(sourceIndex);
    }
    const edges = targets.map((_target, targetIndex) =>
      audioSources.map((source) => ({
        sourceKey: String(source.memberId),
        source,
        matchScore: evidence[source.sourceIndex][targetIndex].score || 0,
        method: evidence[source.sourceIndex][targetIndex].method,
      }))
        .filter((edge) => {
          if (conflictedSources.has(edge.source.sourceIndex)) return false;
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
        acceptedTrackCount,
        ambiguousTrackCount,
        acceptedRecordingIds: [],
        identityRecordingIds: [],
        write: null,
      };
    }
    return {
      acceptedTrackCount,
      ambiguousTrackCount,
      acceptedRecordingIds,
      identityRecordingIds,
      write: {
        decision: {
          matchState: "accepted",
          decisionSource: input.decisionSource,
          confidence: acceptedTrackCount / Math.max(targets.length, audioSources.length, 1),
          method: "normalized_track_assignment",
          evidence: { ambiguousTrackCount },
          matcherVersion: input.matcherVersion,
        },
        targetTrackIds: targets.map((target) => target.id),
        sourceMemberIds: audioSources.map((source) => source.memberId),
        trackMatches,
      },
    };
  }

  /**
   * Re-decide one stored provider release from catalogue rows already on disk.
   *
   * No provider traffic and no writes. Identity mode (a UPC that hits edition
   * barcodes) re-decides only those editions, matching ingest. Otherwise every
   * accepted linked edition is re-decided, plus the caller's canonical edition
   * when artist refresh has just selected one that is not linked yet.
   * Returns null only when the item is not a stored release.
   */
  prepareStoredReplay(
    providerEditionItemId: number,
    options?: { canonicalEditionId?: number | null },
  ): StoredReplayPlan | null {
    const release = this.db.prepare(`
      SELECT id, provider, upc
      FROM ProviderItems
      WHERE id = ? AND entity_type = 'release'
    `).get(providerEditionItemId) as { id: number; provider: string; upc: string | null } | undefined;
    if (!release) return null;

    const memberRows = this.db.prepare(`
      SELECT
        member.id AS member_id,
        member.medium_position,
        member.position,
        member.contextual_title,
        member.contextual_duration_ms,
        item.provider_id,
        item.title,
        item.version,
        item.isrc,
        item.duration_ms,
        item.explicit
      FROM ProviderEditionMembers member
      JOIN ProviderItems item ON item.id = member.member_item_id
      WHERE member.provider_edition_item_id = ?
        AND item.entity_type = 'track'
      ORDER BY member.medium_position, member.position, member.id
    `).all(providerEditionItemId) as Array<{
      member_id: number;
      medium_position: number;
      position: number;
      contextual_title: string | null;
      contextual_duration_ms: number | null;
      provider_id: string;
      title: string | null;
      version: string | null;
      isrc: string | null;
      duration_ms: number | null;
      explicit: number | null;
    }>;

    const audioSources: AudioSource[] = memberRows.map((row) => ({
      memberId: row.member_id,
      member: {
        item: {
          provider: release.provider,
          entityType: "track",
          providerId: String(row.provider_id),
          title: row.title,
          version: row.version,
          isrc: row.isrc,
          durationMs: row.duration_ms,
          explicit: row.explicit == null ? null : Boolean(row.explicit),
        },
        mediumPosition: Number(row.medium_position || 1),
        position: Number(row.position || 0),
        contextualTitle: row.contextual_title,
        contextualDurationMs: row.contextual_duration_ms,
      },
    }));

    const upcEditionIds = normalizeBarcodeDigits(release.upc)
      ? this.findEditionIdsByBarcode(normalizeBarcodeDigits(release.upc))
      : [];
    const linkedEditionIds = (this.db.prepare(`
      SELECT DISTINCT edition_id AS id
      FROM ProviderEditionMatches
      WHERE provider_edition_item_id = ?
        AND match_state = 'accepted'
    `).all(providerEditionItemId) as Array<{ id: number }>).map((row) => row.id);
    const editionIds = upcEditionIds.length > 0
      ? upcEditionIds
      : [...new Set([
        ...linkedEditionIds,
        ...(options?.canonicalEditionId ? [options.canonicalEditionId] : []),
      ])];

    const decisions = editionIds.map((editionId) => {
      const built = this.buildEditionMatch({
        providerEditionItemId,
        editionId,
        audioSources,
        matcherVersion: PROVIDER_TRACK_MATCHER_VERSION,
        decisionSource: "automatic",
      });
      return {
        editionId,
        acceptedTrackCount: built.acceptedTrackCount,
        ambiguousTrackCount: built.ambiguousTrackCount,
        write: built.write,
      };
    });
    const canonical = options?.canonicalEditionId == null
      ? decisions[0]
      : decisions.find((decision) => decision.editionId === options.canonicalEditionId);
    return {
      providerEditionItemId,
      matcherVersion: PROVIDER_TRACK_MATCHER_VERSION,
      decisions,
      acceptedTrackCount: canonical?.acceptedTrackCount ?? 0,
      ambiguousTrackCount: canonical?.ambiguousTrackCount ?? 0,
    };
  }

  /**
   * Persist a prepared replay. SQL only: matching already ran outside the
   * write gate. The caller replans the returned editions in the same
   * transaction so a reader never sees the plans marked stale.
   */
  commitStoredReplay(plan: StoredReplayPlan): StoredReplayCommit {
    const run = (): StoredReplayCommit => {
      const before = this.monitoredEditionsForRelease(plan.providerEditionItemId);
      for (const decision of plan.decisions) {
        if (!decision.write) continue;
        this.matches.replaceReleaseMatch({
          providerEditionItemId: plan.providerEditionItemId,
          editionId: decision.editionId,
          decision: decision.write.decision,
          targetTrackIds: new Set(decision.write.targetTrackIds),
          sourceMemberIds: new Set(decision.write.sourceMemberIds),
          trackMatches: decision.write.trackMatches,
        });
      }
      const retired = this.retireStaleTrackMatches(plan.providerEditionItemId, plan.matcherVersion);
      const after = this.monitoredEditionsForRelease(plan.providerEditionItemId);
      const seen = new Set<string>();
      const replan: MonitoredEditionRef[] = [];
      for (const edition of [...before, ...after]) {
        const key = `${edition.libraryId}:${edition.editionId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        replan.push(edition);
      }
      return {
        acceptedTrackCount: plan.acceptedTrackCount,
        ambiguousTrackCount: plan.ambiguousTrackCount,
        retired,
        replan,
      };
    };
    return this.db.transaction(run)();
  }

  private monitoredEditionsForRelease(providerEditionItemId: number): MonitoredEditionRef[] {
    return this.db.prepare(`
      SELECT DISTINCT library_edition.library_id AS libraryId,
        library_edition.edition_id AS editionId
      FROM LibraryEditions library_edition
      JOIN ProviderEditionMatches edition_match
        ON edition_match.edition_id = library_edition.edition_id
      WHERE edition_match.provider_edition_item_id = ?
    `).all(providerEditionItemId) as MonitoredEditionRef[];
  }

  /**
   * Retire automatic track matches for this provider release that the current
   * matcher did not reproduce.
   *
   * A provider release can be matched to several canonical Editions, and a
   * replay re-derives the best one — so re-ingesting TIDAL's Frank pointed it
   * at the 16-track Germany/US Edition and left its old match to the Japanese
   * Edition behind, still asserting that a 4:15 "Amy Amy Amy" was the canonical
   * 13:17 "Amy Amy Amy / Outro". Those leftovers are decisions the current
   * matcher declined to make, so a stale version stamp is exactly the right
   * test for them: anything the replay believed was rewritten at the current
   * version moments ago.
   *
   * An Edition match with no surviving tracks is rejected, retaining its identity
   * for selected source provenance. It must not continue asserting a
   * relationship that nothing supports and would otherwise keep offering an
   * Edition the provider cannot actually fill.
   */
  retireStaleTrackMatches(providerEditionItemId: number, matcherVersion: number): number {
    return this.db.transaction(() => {
      const staleIds = (this.db.prepare(`
        SELECT track_match.id
        FROM ProviderTrackMatches track_match
        JOIN ProviderEditionMatches edition_match
          ON edition_match.id = track_match.provider_edition_match_id
        WHERE edition_match.provider_edition_item_id = ?
          AND track_match.decision_source = 'automatic'
          AND track_match.matcher_version < ?
      `).all(providerEditionItemId, matcherVersion) as Array<{ id: number }>).map(({ id }) => id);
      if (staleIds.length === 0) return 0;

      // Same reference to release as the delete path above: a plan built on a
      // match being retired is stale, and the FK will not let it dangle.
      this.invalidateDependentAcquisitionPlans(providerEditionItemId);

      this.db.prepare(`DELETE FROM ProviderTrackMatches WHERE id IN ${SQL_JSON_LIST}`).run(jsonList(staleIds));
      this.db.prepare(`
        UPDATE ProviderEditionMatches SET match_state='rejected', matched_track_count=0,
          source_coverage=0, target_coverage=0, updated_at=CURRENT_TIMESTAMP
        WHERE provider_edition_item_id = ?
          AND decision_source = 'automatic'
          AND NOT EXISTS (
            SELECT 1 FROM ProviderTrackMatches surviving
            WHERE surviving.provider_edition_match_id = ProviderEditionMatches.id
          )
      `).run(providerEditionItemId);
      return staleIds.length;
    })();
  }

  private invalidateDependentAcquisitionPlans(providerEditionItemId: number): Array<{ libraryId: number; editionId: number }> {
    // Plans reference this release three ways, and none of the track-level
    // foreign keys cascade: sources point at the edition match, plan tracks
    // point at individual track matches, and plan tracks also pin the exact
    // audio variant they would download. Replacing members or variants without
    // clearing all three leaves dangling FKs and aborts re-ingest mid-flight —
    // which is how a rematch of Bastille's MAX release (and many siblings)
    // failed with "FOREIGN KEY constraint failed" after fan-out had already
    // created plans against the new matches.
    const dependentPlanIds = `
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
    `;
    const args = [
      providerEditionItemId,
      providerEditionItemId,
      providerEditionItemId,
      providerEditionItemId,
    ];

    invalidateAcquisitionPlans(this.db, (this.db.prepare(`
      SELECT id FROM AcquisitionPlans WHERE id IN (${dependentPlanIds})
    `).all(...args) as Array<{ id: number }>).map(row => row.id));

    const droppedEditions = this.db.prepare(`
      SELECT DISTINCT plan.library_id AS libraryId, plan.edition_id AS editionId
      FROM AcquisitionPlans plan
      WHERE plan.id IN (${dependentPlanIds})
    `).all(...args) as Array<{ libraryId: number; editionId: number }>;

    return droppedEditions;
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
