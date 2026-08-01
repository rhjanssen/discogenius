import {
  inlineVideoSlot,
  type CanonicalVideoType,
  type InlineVideoSlot,
} from "./canonical-video-type.js";

/**
 * Which videos a Library takes, and where each one's single file goes.
 *
 * Three decisions, made in this order and kept apart:
 *
 *   1. eligibility — is this candidate the kind of video the Library wants?
 *   2. inline winner — of the candidates competing for one Plex slot beside one
 *      exact audio Track, which one occupies it?
 *   3. placement — for a video that is selected, which single Track (or none,
 *      meaning the separated video library) hosts the file?
 *
 * The slot competition is the part that has no audio equivalent. Plex gives a
 * track one `-video` extra and one `-lyrics` extra, so an official video, a
 * visualizer and a live cut of the same song all contend for the first, and only
 * one can win. Deciding that by "whatever was inserted last" is how two files
 * end up resolving to one filename.
 *
 * Everything here is a pure function over already-loaded rows: the ranking is
 * the interesting part and it should be testable without a database.
 */

export type VideoLayout = "separated" | "inline" | "inline_only";

/** Where a release sits relative to the kind of video being placed. */
export type ReleaseKind = "studio" | "other" | "compilation" | "live";

export interface VideoCandidate {
  videoRecordingId: number;
  canonicalType: CanonicalVideoType;
  /** The exact audio Recording this video is a video OF, when a relation exists. */
  audioRecordingId: number | null;
  /** 0..1 relation strength; 0 when there is no relation. */
  relationConfidence: number;
  /** The relation was accepted or entered by hand rather than inferred. */
  relationAccepted: boolean;
  /** Editions that carry this video Recording as a canonical Track outright. */
  directEditionIds: ReadonlySet<number>;
  /** A provider can currently deliver it. */
  providerAvailable: boolean;
  /** Lower is better; ties broken deterministically further down. */
  providerQualityRank: number;
  /** The user picked this one; automation may not demote it. */
  manuallySelected: boolean;
}

/**
 * A canonical audio Track occurrence a video could be placed beside.
 *
 * Only Tracks of currently monitored Editions in the applicable audio Library
 * belong here — a video cannot sit beside a track the Library does not hold.
 */
export interface InlinePlacementCandidate {
  trackId: number;
  editionId: number;
  releaseGroupId: number;
  audioRecordingId: number;
  placementLibraryId: number;
  releaseKind: ReleaseKind;
  /** Canonical track count of the Edition; a tie-break, never a lead criterion. */
  editionTrackCount: number;
  representative: boolean;
}

export type ResolvedPlacement =
  | { mode: "separated" }
  | {
    mode: "inline";
    placementLibraryId: number;
    inlineTrackId: number;
    inlineSlot: InlineVideoSlot;
  };

export interface VideoCurationDecision {
  videoRecordingId: number;
  placement: ResolvedPlacement;
  reason: string;
}

/**
 * How well a release suits this kind of video.
 *
 * A live video belongs with the live record; an ordinary or lyric video belongs
 * with the studio album the song came from. This is what stops a compilation
 * winning on size alone — it is ranked before track counts, never after.
 */
function releaseContextRank(type: CanonicalVideoType, kind: ReleaseKind): number {
  if (type === "live") {
    return kind === "live" ? 0 : kind === "studio" ? 2 : 1;
  }
  switch (kind) {
    case "studio": return 0;
    case "other": return 1;
    case "compilation": return 2;
    case "live": return 3;
  }
}

/** True when this candidate may be placed beside this Track at all. */
export function candidateFitsTrack(
  candidate: VideoCandidate,
  track: InlinePlacementCandidate,
): boolean {
  // Either the video IS a track of that Edition, or it is a video of the exact
  // audio Recording the Track carries. Nothing weaker qualifies.
  return candidate.directEditionIds.has(track.editionId)
    || (candidate.audioRecordingId != null
      && candidate.audioRecordingId === track.audioRecordingId);
}

/**
 * §13 — of the candidates contending for one slot beside one Track, which wins.
 *
 * Returns negative when `left` should win. Ordered so that canonical identity
 * always outranks provider circumstance: a title-only match can never beat an
 * exact Recording relation, whatever quality it is offered at.
 */
export function compareInlineCandidates(
  left: VideoCandidate,
  right: VideoCandidate,
  track: InlinePlacementCandidate,
): number {
  const exactRelation = (candidate: VideoCandidate): number =>
    candidate.audioRecordingId != null
      && candidate.audioRecordingId === track.audioRecordingId ? 0 : 1;
  const directMembership = (candidate: VideoCandidate): number =>
    candidate.directEditionIds.has(track.editionId) ? 0 : 1;

  return exactRelation(left) - exactRelation(right)
    || directMembership(left) - directMembership(right)
    || releaseContextRank(left.canonicalType, track.releaseKind)
      - releaseContextRank(right.canonicalType, track.releaseKind)
    || Number(right.relationAccepted) - Number(left.relationAccepted)
    || right.relationConfidence - left.relationConfidence
    || Number(right.providerAvailable) - Number(left.providerAvailable)
    || left.providerQualityRank - right.providerQualityRank
    || left.videoRecordingId - right.videoRecordingId;
}

/**
 * §14 — of the Tracks a selected video could sit beside, which hosts the file.
 *
 * Canonical closeness first, size last. A compilation carrying forty tracks does
 * not become the home of a video because it is big; the album the song is from
 * does, because that is what the video is of.
 */
export function comparePlacementCandidates(
  candidate: VideoCandidate,
  left: InlinePlacementCandidate,
  right: InlinePlacementCandidate,
): number {
  const directMembership = (track: InlinePlacementCandidate): number =>
    candidate.directEditionIds.has(track.editionId) ? 0 : 1;
  const exactRelation = (track: InlinePlacementCandidate): number =>
    candidate.audioRecordingId != null
      && candidate.audioRecordingId === track.audioRecordingId ? 0 : 1;

  return directMembership(left) - directMembership(right)
    || exactRelation(left) - exactRelation(right)
    || releaseContextRank(candidate.canonicalType, left.releaseKind)
      - releaseContextRank(candidate.canonicalType, right.releaseKind)
    || right.editionTrackCount - left.editionTrackCount
    || Number(right.representative) - Number(left.representative)
    || left.editionId - right.editionId
    || left.trackId - right.trackId;
}

export interface CurateVideosInput {
  layout: VideoLayout;
  candidates: readonly VideoCandidate[];
  /** Audio Track occurrences inline placement may use. */
  placementCandidates: readonly InlinePlacementCandidate[];
}

export interface CurateVideosResult {
  /** Videos that get a LibraryVideos row, with their resolved placement. */
  selected: VideoCurationDecision[];
  /**
   * Eligible candidates deliberately left unselected — `inline_only` losers.
   * They stay visible in the UX; they simply have no row and no download.
   */
  unselected: number[];
}

/**
 * Decide selection and placement for one Video Library.
 *
 * `separated` takes every eligible candidate and stores each in the video
 * library. `inline` takes them all too, but the slot winners move in beside
 * their track and the rest stay separated — never both. `inline_only` takes
 * only the winners, leaving the losers as visible alternatives rather than
 * downloads nobody asked for.
 */
export function curateLibraryVideos(input: CurateVideosInput): CurateVideosResult {
  const ordered = [...input.candidates]
    .sort((left, right) => left.videoRecordingId - right.videoRecordingId);
  if (input.layout === "separated") {
    return {
      selected: ordered.map((candidate) => ({
        videoRecordingId: candidate.videoRecordingId,
        placement: { mode: "separated" as const },
        reason: "layout_separated",
      })),
      unselected: [],
    };
  }

  // One winner per (Track, slot). A video that already occupies a slot cannot
  // also take another, so winners are tracked by video too.
  const winnerBySlot = new Map<string, { candidate: VideoCandidate; track: InlinePlacementCandidate }>();
  const orderedTracks = [...input.placementCandidates].sort((left, right) =>
    left.trackId - right.trackId);

  for (const candidate of ordered) {
    const fitting = orderedTracks.filter((track) => candidateFitsTrack(candidate, track));
    if (fitting.length === 0) continue;
    const slot = inlineVideoSlot(candidate.canonicalType);
    // Where this video would most naturally live, decided before it competes.
    const [best] = [...fitting].sort((left, right) =>
      comparePlacementCandidates(candidate, left, right));
    const key = `${best.placementLibraryId}:${best.trackId}:${slot}`;
    const incumbent = winnerBySlot.get(key);
    if (!incumbent) {
      winnerBySlot.set(key, { candidate, track: best });
      continue;
    }
    // A manual selection is the user's answer to exactly this question.
    if (incumbent.candidate.manuallySelected && !candidate.manuallySelected) continue;
    if (candidate.manuallySelected && !incumbent.candidate.manuallySelected) {
      winnerBySlot.set(key, { candidate, track: best });
      continue;
    }
    if (compareInlineCandidates(candidate, incumbent.candidate, best) < 0) {
      winnerBySlot.set(key, { candidate, track: best });
    }
  }

  const inlineByVideo = new Map<number, ResolvedPlacement>();
  for (const { candidate, track } of winnerBySlot.values()) {
    inlineByVideo.set(candidate.videoRecordingId, {
      mode: "inline",
      placementLibraryId: track.placementLibraryId,
      inlineTrackId: track.trackId,
      inlineSlot: inlineVideoSlot(candidate.canonicalType),
    });
  }

  const selected: VideoCurationDecision[] = [];
  const unselected: number[] = [];
  for (const candidate of ordered) {
    const inline = inlineByVideo.get(candidate.videoRecordingId);
    if (inline) {
      selected.push({
        videoRecordingId: candidate.videoRecordingId,
        placement: inline,
        reason: "inline_slot_winner",
      });
      continue;
    }
    if (input.layout === "inline_only" && !candidate.manuallySelected) {
      // Nothing to place it beside, so under inline_only there is nothing to do
      // with it. It stays a candidate the user can still choose.
      unselected.push(candidate.videoRecordingId);
      continue;
    }
    selected.push({
      videoRecordingId: candidate.videoRecordingId,
      placement: { mode: "separated" },
      reason: candidate.manuallySelected ? "manual_selection" : "inline_slot_loser",
    });
  }
  return { selected, unselected };
}
