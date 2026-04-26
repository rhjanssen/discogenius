import type { LidarrLibraryType } from "./lidarr-domain-schema.js";

export type ReleaseGroupType = "album" | "ep" | "single" | "other";

export interface LidarrTrackCandidate {
  id: string | number;
  recordingId?: string | null;
  isrcs?: string[] | null;
  title: string;
  absoluteTrackNumber?: number | null;
}

export interface LidarrAlbumReleaseCandidate {
  id: string | number;
  releaseGroupId: string | number;
  title: string;
  status?: string | null;
  releaseDate?: string | null;
  country?: string[] | null;
  media?: Array<{ format?: string | null }> | null;
  trackCount?: number | null;
  monitored?: boolean | null;
  providerAvailable?: Partial<Record<LidarrLibraryType, boolean>>;
  tracks: LidarrTrackCandidate[];
}

export interface LidarrReleaseGroupCandidate {
  id: string | number;
  artistId?: string | number | null;
  title: string;
  type?: ReleaseGroupType | string | null;
  monitored?: boolean | null;
  selectedReleaseId?: string | number | null;
  releases: LidarrAlbumReleaseCandidate[];
}

export type LidarrReleaseDecisionReason =
  | "selected"
  | "unmonitored"
  | "no_release"
  | "redundant_track_subset";

export interface LidarrReleaseMonitoringDecision {
  releaseGroupId: string;
  libraryType: LidarrLibraryType;
  monitored: boolean;
  selectedReleaseId: string | null;
  redundantToReleaseGroupId: string | null;
  reason: LidarrReleaseDecisionReason;
}

export interface BuildLidarrReleaseMonitoringInput {
  releaseGroups: LidarrReleaseGroupCandidate[];
  libraryTypes: LidarrLibraryType[];
  redundancyEnabled?: boolean;
}

export interface BuildLidarrReleaseMonitoringResult {
  decisions: LidarrReleaseMonitoringDecision[];
  selectedReleaseByGroup: Map<string, LidarrAlbumReleaseCandidate>;
}

export function selectBestAlbumRelease(
  releaseGroup: LidarrReleaseGroupCandidate,
  libraryType: LidarrLibraryType,
): LidarrAlbumReleaseCandidate | null {
  const releaseGroupId = String(releaseGroup.id);
  const releases = releaseGroup.releases.filter((release) => String(release.releaseGroupId) === releaseGroupId);
  if (releases.length === 0) {
    return null;
  }

  const selectedId = releaseGroup.selectedReleaseId === null || releaseGroup.selectedReleaseId === undefined
    ? null
    : String(releaseGroup.selectedReleaseId);

  return [...releases].sort((left, right) => {
    return compareReleaseCandidates(left, right, selectedId, libraryType);
  })[0] ?? null;
}

function compareReleaseCandidates(
  left: LidarrAlbumReleaseCandidate,
  right: LidarrAlbumReleaseCandidate,
  selectedId: string | null,
  libraryType: LidarrLibraryType,
): number {
  return releaseScore(right, selectedId, libraryType) - releaseScore(left, selectedId, libraryType)
    || compareDate(left.releaseDate, right.releaseDate)
    || String(left.id).localeCompare(String(right.id));
}

function releaseScore(
  release: LidarrAlbumReleaseCandidate,
  selectedId: string | null,
  libraryType: LidarrLibraryType,
): number {
  const trackCount = Number(release.trackCount ?? release.tracks.length ?? 0);
  return (selectedId && String(release.id) === selectedId ? 1_000_000 : 0)
    + (release.monitored ? 500_000 : 0)
    + (trackCount * 1_000)
    + (release.providerAvailable?.[libraryType] ? 100 : 0)
    + (isOfficial(release.status) ? 10 : 0)
    + (isDigitalRelease(release) ? 5 : 0);
}

function compareDate(left?: string | null, right?: string | null): number {
  const normalizedLeft = String(left || "");
  const normalizedRight = String(right || "");
  if (!normalizedLeft && !normalizedRight) return 0;
  if (!normalizedLeft) return 1;
  if (!normalizedRight) return -1;
  return normalizedLeft.localeCompare(normalizedRight);
}

function isOfficial(status?: string | null): boolean {
  return String(status || "").trim().toLowerCase() === "official";
}

function isDigitalRelease(release: LidarrAlbumReleaseCandidate): boolean {
  return (release.media || []).some((medium) => String(medium.format || "").toLowerCase().includes("digital"));
}

export function buildLidarrReleaseMonitoringDecisions(
  input: BuildLidarrReleaseMonitoringInput,
): BuildLidarrReleaseMonitoringResult {
  const redundancyEnabled = input.redundancyEnabled !== false;
  const decisions: LidarrReleaseMonitoringDecision[] = [];
  const selectedReleaseByGroup = new Map<string, LidarrAlbumReleaseCandidate>();

  for (const releaseGroup of input.releaseGroups) {
    const releaseGroupId = String(releaseGroup.id);

    for (const libraryType of input.libraryTypes) {
      if (!releaseGroup.monitored) {
        decisions.push({
          releaseGroupId,
          libraryType,
          monitored: false,
          selectedReleaseId: null,
          redundantToReleaseGroupId: null,
          reason: "unmonitored",
        });
        continue;
      }

      const selected = selectBestAlbumRelease(releaseGroup, libraryType);
      if (!selected) {
        decisions.push({
          releaseGroupId,
          libraryType,
          monitored: false,
          selectedReleaseId: null,
          redundantToReleaseGroupId: null,
          reason: "no_release",
        });
        continue;
      }

      selectedReleaseByGroup.set(`${releaseGroupId}:${libraryType}`, selected);
      decisions.push({
        releaseGroupId,
        libraryType,
        monitored: true,
        selectedReleaseId: String(selected.id),
        redundantToReleaseGroupId: null,
        reason: "selected",
      });
    }
  }

  if (redundancyEnabled) {
    applyTrackSubsetRedundancy(input.releaseGroups, decisions, selectedReleaseByGroup);
  }

  return { decisions, selectedReleaseByGroup };
}

function applyTrackSubsetRedundancy(
  releaseGroups: LidarrReleaseGroupCandidate[],
  decisions: LidarrReleaseMonitoringDecision[],
  selectedReleaseByGroup: Map<string, LidarrAlbumReleaseCandidate>,
) {
  const groupById = new Map(releaseGroups.map((group) => [String(group.id), group]));
  const decisionsByLibrary = new Map<LidarrLibraryType, LidarrReleaseMonitoringDecision[]>();

  for (const decision of decisions) {
    if (!decision.monitored || decision.reason !== "selected" || !decision.selectedReleaseId) {
      continue;
    }

    const bucket = decisionsByLibrary.get(decision.libraryType) || [];
    bucket.push(decision);
    decisionsByLibrary.set(decision.libraryType, bucket);
  }

  for (const libraryDecisions of decisionsByLibrary.values()) {
    const ranked = [...libraryDecisions].sort((left, right) => {
      const leftRelease = selectedReleaseByGroup.get(`${left.releaseGroupId}:${left.libraryType}`);
      const rightRelease = selectedReleaseByGroup.get(`${right.releaseGroupId}:${right.libraryType}`);
      const leftGroup = groupById.get(left.releaseGroupId);
      const rightGroup = groupById.get(right.releaseGroupId);

      return releaseGroupCoverageScore(rightGroup, rightRelease) - releaseGroupCoverageScore(leftGroup, leftRelease)
        || String(left.releaseGroupId).localeCompare(String(right.releaseGroupId));
    });

    const kept: Array<{ decision: LidarrReleaseMonitoringDecision; trackSet: Set<string> }> = [];
    for (const decision of ranked) {
      const selected = selectedReleaseByGroup.get(`${decision.releaseGroupId}:${decision.libraryType}`);
      const trackSet = buildTrackIdentitySet(selected?.tracks || []);
      if (trackSet.size === 0) {
        kept.push({ decision, trackSet });
        continue;
      }

      const coveredBy = kept.find((candidate) => isSubset(trackSet, candidate.trackSet));
      if (coveredBy) {
        decision.monitored = false;
        decision.redundantToReleaseGroupId = coveredBy.decision.releaseGroupId;
        decision.reason = "redundant_track_subset";
        continue;
      }

      kept.push({ decision, trackSet });
    }
  }
}

function releaseGroupCoverageScore(
  releaseGroup: LidarrReleaseGroupCandidate | undefined,
  release: LidarrAlbumReleaseCandidate | undefined,
): number {
  const typeScore = releaseGroupTypeRank(releaseGroup?.type) * 1_000_000;
  const trackScore = Number(release?.trackCount ?? release?.tracks.length ?? 0) * 1_000;
  return typeScore + trackScore;
}

function releaseGroupTypeRank(value?: string | null): number {
  switch (String(value || "").trim().toLowerCase()) {
    case "album":
      return 4;
    case "ep":
      return 3;
    case "single":
      return 2;
    default:
      return 1;
  }
}

function buildTrackIdentitySet(tracks: LidarrTrackCandidate[]): Set<string> {
  const identities = new Set<string>();

  for (const track of tracks) {
    const recordingId = String(track.recordingId || "").trim().toLowerCase();
    if (recordingId) {
      identities.add(`recording:${recordingId}`);
      continue;
    }

    const isrc = (track.isrcs || [])
      .map((value) => String(value || "").trim().toUpperCase())
      .find(Boolean);
    if (isrc) {
      identities.add(`isrc:${isrc}`);
      continue;
    }

    identities.add(`title:${normalizeTrackTitle(track.title)}`);
  }

  return identities;
}

function normalizeTrackTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function isSubset(left: Set<string>, right: Set<string>): boolean {
  if (left.size === 0 || right.size === 0 || left.size > right.size) {
    return false;
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }

  return true;
}
