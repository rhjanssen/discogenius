import { db } from "../../database.js";
import { CommandNames } from "../commands/command-names.js";
import { CommandQueueManager } from "../commands/command-queue-manager.js";
import { buildStreamingMediaUrl } from "../download/download-routing.js";

export type PlannedReleaseGroupSlot = {
  slot?: string | null;
  selected_provider?: string | null;
  selected_provider_id?: string | null;
  selected_release_mbid?: string | null;
  release_group_mbid?: string | null;
  match_method?: string | null;
  match_evidence?: string | null;
  quality?: string | null;
  provider_cover?: string | null;
  provider_artist_name?: string | null;
  artist_name?: string | null;
  title?: string | null;
};

type TrackSource = {
  providerTrackId: string;
  canonicalTrackMbid: string;
  canonicalRecordingMbid: string;
  title: string;
  quality: string | null;
  trackNum: number | null;
  volumeNum: number | null;
};

export type QueueTrackAcquisitionPlanOptions = {
  canQueue?: () => boolean;
  onQueued?: (commandId: number) => void;
};

function parseTrackSources(slot: PlannedReleaseGroupSlot): TrackSource[] | null {
  const providerAlbumIds = String(slot.selected_provider_id || "").split(";").filter(Boolean);
  const isTrackPlan = slot.match_method === "strict_partial_track_coverage"
    || slot.match_method === "quality_optimized_composite_track_coverage"
    || slot.match_method === "strict_composite_track_coverage"
    || providerAlbumIds.length > 1;
  if (!isTrackPlan || !slot.match_evidence) return null;

  let evidence: { trackSources?: Array<Record<string, unknown>> };
  try {
    evidence = JSON.parse(String(slot.match_evidence));
  } catch {
    return null;
  }
  if (!Array.isArray(evidence.trackSources) || evidence.trackSources.length === 0) return null;

  const sources: TrackSource[] = [];
  for (const source of evidence.trackSources) {
    const providerTrackId = String(source.providerTrackId || "").trim();
    const canonicalTrackMbid = String(source.canonicalTrackMbid || "").trim();
    const canonicalRecordingMbid = String(source.canonicalRecordingMbid || "").trim();
    if (!providerTrackId || (!canonicalTrackMbid && !canonicalRecordingMbid)) continue;
    sources.push({
      providerTrackId,
      canonicalTrackMbid,
      canonicalRecordingMbid,
      title: String(source.title || slot.title || "Unknown Track"),
      quality: source.quality ? String(source.quality) : slot.quality || null,
      trackNum: Number(source.trackNum || source.trackPosition || 0) || null,
      volumeNum: Number(source.volumeNum || source.mediumPosition || 0) || null,
    });
  }
  return sources.length > 0 ? sources : null;
}

/**
 * Queue the selected per-track acquisition plan for a composite or partial slot.
 * Both automatic missing-item searches and manual album downloads use this path,
 * so they cannot accidentally download every source album in a hybrid plan.
 */
export function queueTrackAcquisitionPlan(
  slot: PlannedReleaseGroupSlot,
  options: QueueTrackAcquisitionPlanOptions = {},
): { recognized: boolean; commandIds: number[] } {
  const sources = parseTrackSources(slot);
  if (!sources) return { recognized: false, commandIds: [] };

  const commandIds: number[] = [];
  const librarySlot = slot.slot === "spatial" ? "spatial" : "stereo";
  for (const source of sources) {
    if (options.canQueue && !options.canQueue()) break;

    const downloaded = db.prepare(`
      SELECT 1
      FROM TrackFiles
      WHERE file_type = 'track'
        AND library_slot = ?
        AND (
          (? <> '' AND canonical_track_mbid = ?)
          OR (? <> '' AND canonical_recording_mbid = ?)
        )
      LIMIT 1
    `).get(
      librarySlot,
      source.canonicalTrackMbid,
      source.canonicalTrackMbid,
      source.canonicalRecordingMbid,
      source.canonicalRecordingMbid,
    );
    const queueRefId = source.canonicalTrackMbid
      ? `${source.canonicalTrackMbid}:${librarySlot}`
      : `${source.canonicalRecordingMbid}:${librarySlot}`;
    const buffered = db.prepare(`
      SELECT 1 FROM commands
      WHERE name IN (?, ?) AND ref_id = ? AND status IN ('queued', 'started', 'failed')
      LIMIT 1
    `).get(CommandNames.DownloadTrack, CommandNames.ImportDownload, queueRefId);
    if (downloaded || buffered) continue;

    const provider = slot.selected_provider || "tidal";
    const artistName = slot.artist_name || slot.provider_artist_name || "Unknown";
    const commandId = CommandQueueManager.push(CommandNames.DownloadTrack, {
      url: buildStreamingMediaUrl("track", source.providerTrackId, provider as any),
      type: "track",
      provider,
      providerId: source.providerTrackId,
      canonicalTrackMbid: source.canonicalTrackMbid || null,
      canonicalRecordingMbid: source.canonicalRecordingMbid || null,
      releaseGroupMbid: slot.release_group_mbid || undefined,
      releaseMbid: slot.selected_release_mbid || null,
      libraryRoot: librarySlot === "spatial" ? "spatial" : "music",
      slot: librarySlot,
      title: source.title,
      artist: artistName,
      albumTitle: slot.title || undefined,
      cover: slot.provider_cover || null,
      quality: source.quality,
      trackNumber: source.trackNum,
      volumeNumber: source.volumeNum,
      description: `${source.title} by ${artistName}`,
    }, queueRefId);
    if (commandId !== -1) {
      commandIds.push(commandId);
      options.onQueued?.(commandId);
    }
  }

  return { recognized: true, commandIds };
}
