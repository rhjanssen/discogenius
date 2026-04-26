import { getQualityRank, type LibraryType, type QualityProfile } from "../repositories/MediaRepository.js";
import { buildEditionIdentityKey, buildIsrcSet, buildNormalizedTrackTitleSet } from "./release-identity.js";

export type CurationLibraryType = "music" | "atmos" | "video";
export type CurationDecisionReason =
  | "selected"
  | "filtered_category"
  | "duplicate_edition"
  | "duplicate_track_set"
  | "subset";

export interface CurationTrackCandidate {
  id: string | number;
  isrc?: string | null;
  title?: string | null;
}

export interface CurationAlbumCandidate {
  id: string | number;
  title: string;
  version?: string | null;
  type?: string | null;
  quality?: string | null;
  explicit?: number | boolean | null;
  num_tracks?: number | null;
  monitor?: number | boolean | null;
  tracks?: CurationTrackCandidate[];
  tags?: string[];
  monitor_lock?: number | boolean | null;
  redundant?: string | null;
  module?: string | null;
  group_type?: string | null;
  version_group_id?: number | null;
  mbid?: string | null;
  mb_release_group_id?: string | null;
  upc?: string | null;
  mb_primary?: string | null;
  mb_secondary?: string | null;
}

export interface CurationDecision {
  albumId: string;
  monitor: boolean;
  redundant: string | null;
  reason: CurationDecisionReason;
}

export interface CurationDecisionInput {
  albums: CurationAlbumCandidate[];
  libraryType: CurationLibraryType;
  curationConfig: any;
  qualityConfig: any;
  yieldEvery?: number;
}

export interface CurationDecisionResult {
  qualifiedAlbums: CurationAlbumCandidate[];
  includedAlbums: CurationAlbumCandidate[];
  finalSelection: CurationAlbumCandidate[];
  decisionsByAlbumId: Map<string, CurationDecision>;
  editionGroupCount: number;
  afterEditionCount: number;
  afterTrackSetDedupCount: number;
  subsetFilteringApplied: boolean;
}

type RedundancyReason = Exclude<CurationDecisionReason, "selected" | "filtered_category">;

interface RedundancyTarget {
  targetAlbumId: string;
  reason: RedundancyReason;
}

export async function buildCurationDecisions(input: CurationDecisionInput): Promise<CurationDecisionResult> {
  const curationConfig = input.curationConfig ?? {};
  const qualifiedAlbums = filterByLibraryType(input.albums, input.libraryType);
  const includedAlbums = qualifiedAlbums.filter((album) => isIncludedByCategory(album, curationConfig));
  const includedAlbumIds = new Set(includedAlbums.map((album) => String(album.id)));
  const redundancyEnabled = curationConfig?.enable_redundancy_filter !== false;
  const redundancyMap = new Map<string, RedundancyTarget>();

  let candidatesForDedup = includedAlbums;
  let editionGroupCount = includedAlbums.length;
  let afterEditionCount = includedAlbums.length;

  if (redundancyEnabled) {
    const editionGroups = groupByEditionIdentity(includedAlbums);
    editionGroupCount = editionGroups.size;

    const bestByEditionGroup: CurationAlbumCandidate[] = [];
    let counter = 0;
    for (const group of editionGroups.values()) {
      const best = selectBestInGroup(group, curationConfig, input.qualityConfig, input.libraryType);
      bestByEditionGroup.push(best);

      for (const album of group) {
        if (String(album.id) !== String(best.id)) {
          redundancyMap.set(String(album.id), {
            targetAlbumId: String(best.id),
            reason: "duplicate_edition",
          });
        }
      }

      counter++;
      await maybeYield(counter, input.yieldEvery);
    }

    candidatesForDedup = bestByEditionGroup;
    afterEditionCount = bestByEditionGroup.length;
  }

  const deduped = await resolveEqualTrackSets(
    candidatesForDedup,
    curationConfig,
    input.qualityConfig,
    input.libraryType,
    redundancyMap,
    input.yieldEvery,
  );

  const finalSelection = redundancyEnabled
    ? await filterSubsets(deduped, redundancyMap, input.yieldEvery)
    : deduped;

  const finalIds = new Set(finalSelection.map((album) => String(album.id)));
  const decisionsByAlbumId = new Map<string, CurationDecision>();

  for (const album of qualifiedAlbums) {
    const albumId = String(album.id);
    if (!includedAlbumIds.has(albumId)) {
      decisionsByAlbumId.set(albumId, {
        albumId,
        monitor: false,
        redundant: "filtered",
        reason: "filtered_category",
      });
      continue;
    }

    if (finalIds.has(albumId)) {
      decisionsByAlbumId.set(albumId, {
        albumId,
        monitor: true,
        redundant: null,
        reason: "selected",
      });
      continue;
    }

    const redundant = redundancyMap.get(albumId);
    decisionsByAlbumId.set(albumId, {
      albumId,
      monitor: false,
      redundant: redundant?.targetAlbumId ?? null,
      reason: redundant?.reason ?? "subset",
    });
  }

  return {
    qualifiedAlbums,
    includedAlbums,
    finalSelection,
    decisionsByAlbumId,
    editionGroupCount,
    afterEditionCount,
    afterTrackSetDedupCount: deduped.length,
    subsetFilteringApplied: redundancyEnabled,
  };
}

function filterByLibraryType(
  albums: CurationAlbumCandidate[],
  libraryType: CurationLibraryType,
): CurationAlbumCandidate[] {
  if (libraryType === "atmos") {
    return albums.filter((album) => normalizeQuality(album.quality) === "DOLBY_ATMOS");
  }

  if (libraryType === "music") {
    return albums.filter((album) => ["LOSSLESS", "HIRES_LOSSLESS"].includes(normalizeQuality(album.quality)));
  }

  return albums;
}

function normalizeQuality(value?: string | null): string {
  return String(value || "").trim().toUpperCase();
}

function normalizePrimary(album: CurationAlbumCandidate): "album" | "ep" | "single" {
  const raw = String(album.mb_primary || "").trim().toLowerCase();
  if (raw === "album" || raw === "ep" || raw === "single") {
    return raw;
  }

  const type = String(album.type || "").trim().toUpperCase();
  if (type === "SINGLE") return "single";
  if (type === "EP") return "ep";
  return "album";
}

function isIncludedByCategory(album: CurationAlbumCandidate, curationConfig: any): boolean {
  const module = String(album.module || "").toUpperCase();
  if (module.includes("APPEARS_ON")) {
    return curationConfig.include_appears_on === true;
  }

  const secondary = String(album.mb_secondary || "").trim().toLowerCase();
  if (secondary) {
    switch (secondary) {
      case "compilation":
        return curationConfig.include_compilation !== false;
      case "soundtrack":
        return curationConfig.include_soundtrack !== false;
      case "live":
        return curationConfig.include_live !== false;
      case "remix":
      case "dj-mix":
        return curationConfig.include_remix !== false;
      case "demo":
        return false;
      default:
        return true;
    }
  }

  switch (normalizePrimary(album)) {
    case "single":
      return curationConfig.include_single !== false;
    case "ep":
      return curationConfig.include_ep !== false;
    case "album":
    default:
      return curationConfig.include_album !== false;
  }
}

function groupByEditionIdentity(albums: CurationAlbumCandidate[]): Map<string, CurationAlbumCandidate[]> {
  const groups = new Map<string, CurationAlbumCandidate[]>();

  for (const album of albums) {
    const groupKey = buildEditionIdentityKey(album);
    const group = groups.get(groupKey);
    if (group) {
      group.push(album);
    } else {
      groups.set(groupKey, [album]);
    }
  }

  return groups;
}

async function resolveEqualTrackSets(
  albums: CurationAlbumCandidate[],
  curationConfig: any,
  qualityConfig: any,
  libraryType: CurationLibraryType,
  redundancyMap: Map<string, RedundancyTarget>,
  yieldEvery?: number,
): Promise<CurationAlbumCandidate[]> {
  const uniqueAlbums: CurationAlbumCandidate[] = [];
  const albumsByIsrcSet = new Map<string, CurationAlbumCandidate[]>();
  let counter = 0;

  for (const album of albums) {
    const isrcs = Array.from(buildIsrcSet(album.tracks || [])).sort().join("|");
    if (!isrcs) {
      uniqueAlbums.push(album);
      counter++;
      await maybeYield(counter, yieldEvery);
      continue;
    }

    const group = albumsByIsrcSet.get(isrcs);
    if (group) {
      group.push(album);
    } else {
      albumsByIsrcSet.set(isrcs, [album]);
    }

    counter++;
    await maybeYield(counter, yieldEvery);
  }

  for (const group of albumsByIsrcSet.values()) {
    const best = selectBestInGroup(group, curationConfig, qualityConfig, libraryType);
    uniqueAlbums.push(best);

    for (const album of group) {
      if (String(album.id) !== String(best.id)) {
        redundancyMap.set(String(album.id), {
          targetAlbumId: String(best.id),
          reason: "duplicate_track_set",
        });
      }
    }

    counter++;
    await maybeYield(counter, yieldEvery);
  }

  return uniqueAlbums;
}

async function filterSubsets(
  albums: CurationAlbumCandidate[],
  redundancyMap: Map<string, RedundancyTarget>,
  yieldEvery?: number,
): Promise<CurationAlbumCandidate[]> {
  const result: CurationAlbumCandidate[] = [];
  const sorted = [...albums].sort((a, b) => Number(b.num_tracks || 0) - Number(a.num_tracks || 0));
  let counter = 0;

  for (const candidate of sorted) {
    counter++;
    await maybeYield(counter, yieldEvery);

    const candidateIsrcs = buildIsrcSet(candidate.tracks || []);
    const candidateNames = buildNormalizedTrackTitleSet(candidate.tracks || []);
    let isSubset = false;

    for (const superset of result) {
      counter++;
      await maybeYield(counter, yieldEvery);

      if (String(candidate.id) === String(superset.id)) {
        continue;
      }

      const supersetIsrcs = buildIsrcSet(superset.tracks || []);
      const supersetNames = buildNormalizedTrackTitleSet(superset.tracks || []);

      const isIsrcSubset = candidateIsrcs.size > 0
        && supersetIsrcs.size > 0
        && [...candidateIsrcs].every((isrc) => supersetIsrcs.has(isrc));

      const isNameSubset = candidateNames.size > 0
        && supersetNames.size > 0
        && [...candidateNames].every((name) => supersetNames.has(name));

      if (isIsrcSubset || isNameSubset) {
        redundancyMap.set(String(candidate.id), {
          targetAlbumId: String(superset.id),
          reason: "subset",
        });
        isSubset = true;
        break;
      }
    }

    if (!isSubset) {
      result.push(candidate);
    }
  }

  return result;
}

function selectBestInGroup(
  group: CurationAlbumCandidate[],
  curationConfig: any,
  qualityConfig: any,
  libraryType: CurationLibraryType,
): CurationAlbumCandidate {
  if (group.length === 0) {
    throw new Error("Cannot select best release from an empty group");
  }

  if (group.length === 1) {
    return group[0];
  }

  return group.reduce((best, current) => {
    const bestRank = rankAlbumForComparison(best, curationConfig, qualityConfig, libraryType);
    const currentRank = rankAlbumForComparison(current, curationConfig, qualityConfig, libraryType);

    if (currentRank.quality !== bestRank.quality) {
      return currentRank.quality > bestRank.quality ? current : best;
    }

    if (currentRank.explicit !== bestRank.explicit) {
      return currentRank.explicit > bestRank.explicit ? current : best;
    }

    return Number(current.id) > Number(best.id) ? current : best;
  });
}

function rankAlbumForComparison(
  album: CurationAlbumCandidate,
  curationConfig: any,
  qualityConfig: any,
  libraryType: CurationLibraryType,
): { quality: number; explicit: number } {
  const preferExplicit = curationConfig?.prefer_explicit !== undefined ? curationConfig.prefer_explicit : true;
  const explicit = preferExplicit
    ? (album.explicit ? 1 : 0)
    : (album.explicit ? 0 : 1);

  const qualityTier = (qualityConfig?.audio_quality || "max") as QualityProfile;
  const effectiveLibraryType: LibraryType = libraryType === "atmos"
    ? "dolby_atmos"
    : libraryType === "video"
      ? "music_video"
      : "music";
  const qualityTag = album.tags?.[0] || album.quality || "LOSSLESS";
  const quality = getQualityRank(qualityTag, qualityTier, effectiveLibraryType);

  return { quality, explicit };
}

async function maybeYield(counter: number, yieldEvery?: number): Promise<void> {
  if (!yieldEvery || yieldEvery <= 0 || counter <= 0 || counter % yieldEvery !== 0) {
    return;
  }

  await new Promise<void>((resolve) => setImmediate(resolve));
}
