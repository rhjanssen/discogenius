import {
  isLivePerformanceTitle,
} from "./live-performance-markers.js";
import {
  cleanVideoGroupTitle,
  normalizeVideoVariant,
  VIDEO_AUDIO_STUDIO_DURATION_MATCH_MS,
} from "./video-variant.js";

/**
 * Deriving `video Recording → exact audio Recording` from co-membership of one
 * canonical Edition.
 *
 * This is the iTunes Festival shape. Apple ships a release whose members 1–5 are
 * audio and 6–7 are video, MusicBrainz represents all seven as canonical Tracks,
 * and the durable fact worth keeping is not "these videos are on this release" —
 * the canonical Tracks already say that — but *which performance* each video is
 * of. Member 6 is the video of member 1; member 7 is the video of member 5.
 *
 * Scoping the search to one Edition is what makes it safe. The Alchemy live
 * "Tunnel of Love" video can only be compared against Alchemy's own tracks, so
 * it can only ever land on the live recording; the Making Movies studio cut is
 * not a candidate because it is not on this release. That is stronger than any
 * title heuristic and is why the live/studio problem largely disappears here.
 *
 * Provider Edition membership is the same evidence read from the provider's
 * side, for the case where MusicBrainz has not represented the video tracks.
 * Either way the durable result is a Recording-level relation; neither produces
 * a video-to-Edition association table, because the Tracks already are one.
 */

export interface EditionMember {
  trackId: number;
  recordingId: number;
  isVideo: boolean;
  title: string;
  lengthMs: number | null;
  /** ISRCs on the recording, when the catalogue has them. */
  isrcs: readonly string[];
  mediumPosition: number;
  position: number;
  /** Canonical video class; only meaningful for video members. */
  videoVariant?: string | null;
}

export interface DerivedVideoRelation {
  videoRecordingId: number;
  audioRecordingId: number;
  /** 0..1, higher for identifier evidence than for title/duration evidence. */
  confidence: number;
  method: string;
  evidence: Record<string, unknown>;
}

function normalizedTitle(title: string): string {
  return cleanVideoGroupTitle(title).trim().toLowerCase();
}

function sharedIsrc(left: readonly string[], right: readonly string[]): string | null {
  const rightSet = new Set(right.map((value) => value.trim().toUpperCase()).filter(Boolean));
  for (const value of left) {
    const normalized = value.trim().toUpperCase();
    if (normalized && rightSet.has(normalized)) return normalized;
  }
  return null;
}

/**
 * Whether a video and an audio member describe the same kind of performance.
 *
 * Both sit on one release, so the release's own live-ness is shared and cancels
 * out; what remains is the track titles disagreeing — "Song (live)" against
 * "Song" on the same record means two different cuts, and a video of one is not
 * a video of the other.
 */
function performanceKindAgrees(video: EditionMember, audio: EditionMember): boolean {
  const videoIsLive = normalizeVideoVariant(video.videoVariant) === "live"
    || isLivePerformanceTitle(video.title);
  const audioIsLive = isLivePerformanceTitle(audio.title);
  // A live-marked audio track needs a live-marked video, and vice versa. A pair
  // where neither is marked is the ordinary case and agrees trivially.
  return videoIsLive === audioIsLive;
}

function durationAgrees(video: EditionMember, audio: EditionMember): boolean {
  if (video.lengthMs == null || audio.lengthMs == null) return true;
  return Math.abs(video.lengthMs - audio.lengthMs) <= VIDEO_AUDIO_STUDIO_DURATION_MATCH_MS;
}

type ScoredCandidate = { audio: EditionMember; confidence: number; method: string; evidence: Record<string, unknown> };

function scoreCandidate(video: EditionMember, audio: EditionMember): ScoredCandidate | null {
  if (!performanceKindAgrees(video, audio)) return null;

  // An ISRC shared between the video and an audio track is the provider saying
  // outright that they are the same recording.
  const isrc = sharedIsrc(video.isrcs, audio.isrcs);
  if (isrc) {
    return {
      audio,
      confidence: 0.99,
      method: "canonical-edition-isrc",
      evidence: { isrc, audioTrackId: audio.trackId },
    };
  }

  if (normalizedTitle(video.title) !== normalizedTitle(audio.title)) return null;
  if (!durationAgrees(video, audio)) return null;

  const bothHaveDuration = video.lengthMs != null && audio.lengthMs != null;
  return {
    audio,
    confidence: bothHaveDuration ? 0.95 : 0.9,
    method: bothHaveDuration
      ? "canonical-edition-title-duration"
      : "canonical-edition-title",
    evidence: {
      audioTrackId: audio.trackId,
      audioPosition: `${audio.mediumPosition}-${audio.position}`,
      videoPosition: `${video.mediumPosition}-${video.position}`,
    },
  };
}

/**
 * The relations one canonical Edition's own membership justifies.
 *
 * A video with two equally good audio candidates yields nothing: on a release
 * carrying a song twice there is no unambiguous answer, and guessing one is
 * worse than leaving the video unlinked and visible as a candidate.
 */
export function deriveVideoRelationsFromEdition(
  members: readonly EditionMember[],
): DerivedVideoRelation[] {
  const videos = members.filter((member) => member.isVideo);
  const audio = members.filter((member) => !member.isVideo);
  if (videos.length === 0 || audio.length === 0) return [];

  const relations: DerivedVideoRelation[] = [];
  for (const video of [...videos].sort((left, right) => left.trackId - right.trackId)) {
    const scored = audio
      .map((candidate) => scoreCandidate(video, candidate))
      .filter((candidate): candidate is ScoredCandidate => candidate != null)
      .sort((left, right) =>
        right.confidence - left.confidence
        || left.audio.mediumPosition - right.audio.mediumPosition
        || left.audio.position - right.audio.position
        || left.audio.trackId - right.audio.trackId);
    if (scored.length === 0) continue;

    // Ambiguous when the runner-up is just as good AND names a different
    // recording. Two Track rows for one recording are not a conflict.
    const best = scored[0];
    const rival = scored.find((candidate) =>
      candidate.audio.recordingId !== best.audio.recordingId);
    if (rival && rival.confidence === best.confidence) continue;

    relations.push({
      videoRecordingId: video.recordingId,
      audioRecordingId: best.audio.recordingId,
      confidence: best.confidence,
      method: best.method,
      evidence: { ...best.evidence, videoTrackId: video.trackId },
    });
  }
  return relations;
}
