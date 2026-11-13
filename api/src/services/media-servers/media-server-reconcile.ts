import path from "node:path";
import { db } from "../../database.js";
import { getConfigSection } from "../config/config.js";
import {
  PlexClient,
  extractMusicBrainzIdFromPlexGuids,
  isLocalPlexGuid,
  type PlexLibraryItem,
} from "./plex-client.js";
import { JellyfinClient } from "./jellyfin-client.js";

export interface PlexMergeCandidate {
  sectionId: string;
  targetRatingKey: string;
  sourceRatingKeys: string[];
  title: string;
  mbid: string | null;
  reason: string;
}

export interface PlexFixMatchCandidate {
  sectionId: string;
  ratingKey: string;
  title: string;
  currentGuid: string;
  targetMbid: string;
  reason: string;
}

export interface MediaServerReconcileReport {
  dryRun: boolean;
  checkedAt: string;
  plex: {
    enabled: boolean;
    duplicateArtists: PlexMergeCandidate[];
    duplicateAlbums: PlexMergeCandidate[];
    mismatchedArtists: PlexFixMatchCandidate[];
    mismatchedAlbums: PlexFixMatchCandidate[];
    mergesApplied: number;
    matchesFixed: number;
    itemsRefreshed: number;
    errors: string[];
  };
  jellyfin: {
    enabled: boolean;
    matchedItems: number;
    itemsRefreshed: number;
    errors: string[];
  };
}

interface TrackFileLocationRow {
  file_path: string;
  artist_mbid: string | null;
  artist_name: string | null;
  album_mbid: string | null;
  edition_mbid: string | null;
  album_title: string | null;
}

function normalizePathForMatch(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function buildDiscogeniusLocationIndex() {
  const rows = db.prepare(`
    SELECT
      tf.file_path,
      COALESCE(am.mbid, tf.canonical_artist_mbid) AS artist_mbid,
      am.name AS artist_name,
      COALESCE(a.mbid, tf.canonical_release_group_mbid) AS album_mbid,
      COALESCE(ae.mbid, tf.canonical_release_mbid) AS edition_mbid,
      a.title AS album_title
    FROM TrackFiles tf
    LEFT JOIN ArtistMetadata am ON am.id = tf.artist_metadata_id
    LEFT JOIN Albums a ON a.id = tf.release_group_id
    LEFT JOIN AlbumEditions ae ON ae.id = tf.album_edition_id
    WHERE tf.file_type = 'track' AND tf.file_path IS NOT NULL
  `).all() as TrackFileLocationRow[];

  const albumDirToInfo = new Map<string, { mbid: string; editionMbid: string | null; title: string; artistMbid: string | null }>();
  const artistDirToInfo = new Map<string, { mbid: string; name: string }>();
  const knownMbids = new Set<string>();

  for (const row of rows) {
    const albumDir = normalizePathForMatch(path.dirname(row.file_path));
    const artistDir = normalizePathForMatch(path.dirname(path.dirname(row.file_path)));
    const albumMbid = row.album_mbid?.toLowerCase() ?? null;
    const editionMbid = row.edition_mbid?.toLowerCase() ?? null;
    const artistMbid = row.artist_mbid?.toLowerCase() ?? null;

    if (albumMbid) knownMbids.add(albumMbid);
    if (editionMbid) knownMbids.add(editionMbid);
    if (artistMbid) knownMbids.add(artistMbid);

    if (albumMbid && !albumDirToInfo.has(albumDir)) {
      albumDirToInfo.set(albumDir, {
        mbid: albumMbid,
        editionMbid,
        title: row.album_title ?? "",
        artistMbid,
      });
    }
    if (artistMbid && !artistDirToInfo.has(artistDir)) {
      artistDirToInfo.set(artistDir, {
        mbid: artistMbid,
        name: row.artist_name ?? "",
      });
    }
  }

  return { albumDirToInfo, artistDirToInfo, knownMbids };
}

function findPlexCanonicalMbidForLocations(
  locations: string[],
  dirMap: Map<string, { mbid: string }>,
): string | null {
  for (const loc of locations) {
    const norm = normalizePathForMatch(loc);
    const direct = dirMap.get(norm);
    if (direct) return direct.mbid;
    for (const [dir, info] of dirMap.entries()) {
      if (dir.startsWith(`${norm}/`) || norm.startsWith(`${dir}/`)) {
        return info.mbid;
      }
    }
  }
  return null;
}

function planPlexGroupReconciliation(
  sectionId: string,
  items: PlexLibraryItem[],
  dirMap: Map<string, { mbid: string }>,
  kind: "artist" | "album",
): { merges: PlexMergeCandidate[]; fixes: PlexFixMatchCandidate[] } {
  const byMbid = new Map<string, PlexLibraryItem[]>();
  const fixes: PlexFixMatchCandidate[] = [];

  for (const item of items) {
    const guidMbid = extractMusicBrainzIdFromPlexGuids(item.guid, item.guids);
    const folderMbid = findPlexCanonicalMbidForLocations(item.locations, dirMap);
    const canonicalMbid = folderMbid ?? guidMbid;

    if (folderMbid && (isLocalPlexGuid(item.guid) || (guidMbid && guidMbid !== folderMbid))) {
      fixes.push({
        sectionId,
        ratingKey: item.ratingKey,
        title: item.title,
        currentGuid: item.guid || "(empty)",
        targetMbid: folderMbid,
        reason: isLocalPlexGuid(item.guid)
          ? `Plex ${kind} uses local:// instead of MusicBrainz ${folderMbid}`
          : `Plex ${kind} MBID ${guidMbid} differs from Discogenius ${folderMbid}`,
      });
    }

    if (canonicalMbid) {
      const list = byMbid.get(canonicalMbid) ?? [];
      list.push(item);
      byMbid.set(canonicalMbid, list);
    }
  }

  const merges: PlexMergeCandidate[] = [];
  for (const [mbid, group] of byMbid.entries()) {
    if (group.length <= 1) continue;
    // Prefer an item that already has a non-local MusicBrainz GUID as merge target.
    const sorted = [...group].sort((a, b) => {
      const aLocal = isLocalPlexGuid(a.guid) ? 1 : 0;
      const bLocal = isLocalPlexGuid(b.guid) ? 1 : 0;
      return aLocal - bLocal;
    });
    const target = sorted[0];
    const sources = sorted.slice(1).map((s) => s.ratingKey);
    merges.push({
      sectionId,
      targetRatingKey: target.ratingKey,
      sourceRatingKeys: sources,
      title: target.title,
      mbid,
      reason: `${group.length} Plex ${kind} entries map to MusicBrainz ${mbid}`,
    });
  }

  return { merges, fixes };
}

export async function reconcileMediaServers(options: { dryRun?: boolean } = {}): Promise<MediaServerReconcileReport> {
  const dryRun = options.dryRun ?? true;
  const config = getConfigSection("media_servers");
  const { albumDirToInfo, artistDirToInfo, knownMbids } = buildDiscogeniusLocationIndex();

  const report: MediaServerReconcileReport = {
    dryRun,
    checkedAt: new Date().toISOString(),
    plex: {
      enabled: Boolean(config?.plex_enabled && config.plex_url && config.plex_token),
      duplicateArtists: [],
      duplicateAlbums: [],
      mismatchedArtists: [],
      mismatchedAlbums: [],
      mergesApplied: 0,
      matchesFixed: 0,
      itemsRefreshed: 0,
      errors: [],
    },
    jellyfin: {
      enabled: Boolean(config?.jellyfin_enabled && config.jellyfin_url && config.jellyfin_api_key),
      matchedItems: 0,
      itemsRefreshed: 0,
      errors: [],
    },
  };

  if (report.plex.enabled && config) {
    try {
      const plex = new PlexClient(config.plex_url, config.plex_token);
      const sectionIds = config.plex_music_section_id
        ? [config.plex_music_section_id]
        : (await plex.getMusicSections()).map((s) => s.key);

      for (const sectionId of sectionIds) {
        const [artists, albums] = await Promise.all([
          plex.listArtists(sectionId),
          plex.listAlbums(sectionId),
        ]);

        const artistPlan = planPlexGroupReconciliation(sectionId, artists, artistDirToInfo, "artist");
        const albumPlan = planPlexGroupReconciliation(sectionId, albums, albumDirToInfo, "album");

        report.plex.duplicateArtists.push(...artistPlan.merges);
        report.plex.mismatchedArtists.push(...artistPlan.fixes);
        report.plex.duplicateAlbums.push(...albumPlan.merges);
        report.plex.mismatchedAlbums.push(...albumPlan.fixes);

        if (!dryRun) {
          const refreshed = new Set<string>();
          for (const merge of [...artistPlan.merges, ...albumPlan.merges]) {
            await plex.mergeItems(sectionId, merge.targetRatingKey, merge.sourceRatingKeys);
            report.plex.mergesApplied += 1;
            if (!refreshed.has(merge.targetRatingKey)) {
              await plex.refreshItem(merge.targetRatingKey);
              refreshed.add(merge.targetRatingKey);
              report.plex.itemsRefreshed += 1;
            }
          }
          for (const fix of [...artistPlan.fixes, ...albumPlan.fixes]) {
            await plex.fixMatch(fix.ratingKey, fix.targetMbid, fix.title);
            report.plex.matchesFixed += 1;
            if (!refreshed.has(fix.ratingKey)) {
              await plex.refreshItem(fix.ratingKey);
              refreshed.add(fix.ratingKey);
              report.plex.itemsRefreshed += 1;
            }
          }
        }
      }
    } catch (error) {
      report.plex.errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (report.jellyfin.enabled && config) {
    try {
      const jellyfin = new JellyfinClient(config.jellyfin_url, config.jellyfin_api_key);
      const [artists, albums] = await Promise.all([
        jellyfin.listMusicItems("MusicArtist"),
        jellyfin.listMusicItems("MusicAlbum"),
      ]);

      const affectedIds: string[] = [];
      for (const item of [...artists, ...albums]) {
        const normPath = item.path ? normalizePathForMatch(item.path) : null;
        const matchedByMbid = Boolean(item.musicBrainzId && knownMbids.has(item.musicBrainzId));
        const matchedByPath = Boolean(normPath && (albumDirToInfo.has(normPath) || artistDirToInfo.has(normPath)));
        if (matchedByMbid || matchedByPath) {
          affectedIds.push(item.id);
        }
      }

      report.jellyfin.matchedItems = affectedIds.length;
      if (!dryRun) {
        for (const itemId of affectedIds) {
          await jellyfin.refreshItem(itemId);
          report.jellyfin.itemsRefreshed += 1;
        }
      }
    } catch (error) {
      report.jellyfin.errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return report;
}
