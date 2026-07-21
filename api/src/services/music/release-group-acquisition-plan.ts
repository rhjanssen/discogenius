import { db } from "../../database.js";
import { CommandNames } from "../commands/command-names.js";
import { CommandQueueManager } from "../commands/command-queue-manager.js";
import type {
  DownloadAlbumAcquisitionMode,
  DownloadTrackOffer,
  DownloadTrackStateEntry,
} from "../commands/command-bodies.js";
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
  provider_title?: string | null;
};

type TrackSource = {
  providerTrackId: string;
  providerAlbumId?: string | null;
  canonicalTrackMbid: string;
  canonicalRecordingMbid: string;
  title: string;
  quality: string | null;
  trackNum: number | null;
  volumeNum: number | null;
};

type CatalogTrackRow = {
  track_mbid: string;
  recording_mbid: string | null;
  title: string;
  track_num: number;
  volume_num: number;
};

export type QueueTrackAcquisitionPlanOptions = {
  canQueue?: () => boolean;
  onQueued?: (commandId: number) => void;
};

function librarySlotOf(slot: PlannedReleaseGroupSlot): "stereo" | "spatial" {
  return slot.slot === "spatial" ? "spatial" : "stereo";
}

function isHybridTrackPlan(slot: PlannedReleaseGroupSlot): boolean {
  const providerAlbumIds = String(slot.selected_provider_id || "").split(";").filter(Boolean);
  return slot.match_method === "strict_partial_track_coverage"
    || slot.match_method === "quality_optimized_composite_track_coverage"
    || slot.match_method === "strict_composite_track_coverage"
    || providerAlbumIds.length > 1;
}

function parseTrackSources(slot: PlannedReleaseGroupSlot): TrackSource[] | null {
  if (!isHybridTrackPlan(slot) || !slot.match_evidence) return null;

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
      providerAlbumId: source.providerAlbumId ? String(source.providerAlbumId) : null,
      canonicalTrackMbid,
      canonicalRecordingMbid,
      title: String(source.title || slot.title || "Unknown Track"),
      quality: source.quality ? String(source.quality) : slot.quality || null,
      // Catalog positions only (coveragePlanEvidence writes trackNum/volumeNum from Tracks).
      trackNum: Number(source.trackNum || 0) || null,
      volumeNum: Number(source.volumeNum || 0) || null,
    });
  }
  return sources.length > 0 ? sources : null;
}

function resolveReleaseMbid(slot: PlannedReleaseGroupSlot): string | null {
  const explicit = String(slot.selected_release_mbid || "").trim();
  if (explicit) return explicit;
  const releaseGroupMbid = String(slot.release_group_mbid || "").trim();
  if (!releaseGroupMbid) return null;
  const row = db.prepare(`
    SELECT mbid
    FROM AlbumReleases
    WHERE release_group_mbid = ?
    ORDER BY
      CASE WHEN date IS NULL OR TRIM(date) = '' THEN 1 ELSE 0 END,
      date ASC,
      mbid ASC
    LIMIT 1
  `).get(releaseGroupMbid) as { mbid?: string } | undefined;
  return row?.mbid ? String(row.mbid) : null;
}

function loadCatalogTracks(releaseMbid: string | null): CatalogTrackRow[] {
  if (!releaseMbid) return [];
  return (db.prepare(`
    SELECT
      t.mbid AS track_mbid,
      t.recording_mbid AS recording_mbid,
      t.title AS title,
      COALESCE(t.position, 0) AS track_num,
      COALESCE(t.medium_position, 1) AS volume_num
    FROM Tracks t
    LEFT JOIN Recordings r ON r.mbid = t.recording_mbid
    WHERE t.release_mbid = ?
      AND (r.is_video IS NULL OR r.is_video = 0)
    ORDER BY t.medium_position ASC, t.position ASC, t.mbid ASC
  `).all(releaseMbid) as CatalogTrackRow[]).map((row) => ({
    track_mbid: String(row.track_mbid),
    recording_mbid: row.recording_mbid ? String(row.recording_mbid) : null,
    title: String(row.title || "Unknown Track"),
    track_num: Number(row.track_num || 0),
    volume_num: Number(row.volume_num || 1),
  }));
}

function isTrackDownloaded(
  librarySlot: "stereo" | "spatial",
  canonicalTrackMbid: string,
  canonicalRecordingMbid: string | null,
  releaseGroupMbid?: string | null,
): boolean {
  // Prefer exact track MBID. Recording-only matches must stay on the same
  // release group — otherwise a Rehab single makes Back to Black look complete.
  if (canonicalTrackMbid) {
    return Boolean(db.prepare(`
      SELECT 1
      FROM TrackFiles
      WHERE file_type = 'track'
        AND library_slot = ?
        AND canonical_track_mbid = ?
      LIMIT 1
    `).get(librarySlot, canonicalTrackMbid));
  }

  const recordingMbid = String(canonicalRecordingMbid || "").trim();
  const rgMbid = String(releaseGroupMbid || "").trim();
  if (!recordingMbid) {
    return false;
  }

  if (rgMbid) {
    return Boolean(db.prepare(`
      SELECT 1
      FROM TrackFiles
      WHERE file_type = 'track'
        AND library_slot = ?
        AND canonical_recording_mbid = ?
        AND (
          canonical_release_group_mbid = ?
          OR canonical_track_mbid IS NULL
        )
      LIMIT 1
    `).get(librarySlot, recordingMbid, rgMbid));
  }

  return Boolean(db.prepare(`
    SELECT 1
    FROM TrackFiles
    WHERE file_type = 'track'
      AND library_slot = ?
      AND canonical_recording_mbid = ?
      AND canonical_track_mbid IS NULL
    LIMIT 1
  `).get(librarySlot, recordingMbid));
}

function resolveProviderTrackOffersForAlbum(
  provider: string,
  providerAlbumId: string,
  catalogTracks: CatalogTrackRow[],
): Map<string, { providerTrackId: string; quality: string | null }> {
  // Match offers by recording / track MBID only. Never bind by provider-native
  // disc/track numbers (match_evidence or ProviderItems.track_number) — those
  // describe the provider album layout, not the monitored Tracks edition.
  const rows = db.prepare(`
    SELECT
      CAST(provider_id AS TEXT) AS provider_id,
      recording_mbid,
      track_mbid,
      isrc,
      quality
    FROM ProviderItems
    WHERE provider = ?
      AND entity_type = 'track'
      AND CAST(provider_album_id AS TEXT) = ?
  `).all(provider, providerAlbumId) as Array<{
    provider_id: string;
    recording_mbid: string | null;
    track_mbid: string | null;
    isrc: string | null;
    quality: string | null;
  }>;

  const byTrack = new Map<string, typeof rows[number]>();
  const byRecording = new Map<string, typeof rows[number]>();
  const byIsrc = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    if (row.track_mbid) byTrack.set(String(row.track_mbid), row);
    if (row.recording_mbid) byRecording.set(String(row.recording_mbid), row);
    const isrc = String(row.isrc || "").trim().toUpperCase();
    if (isrc && !byIsrc.has(isrc)) byIsrc.set(isrc, row);
  }

  const catalogIsrcs = catalogTracks.length > 0
    ? (db.prepare(`
        SELECT
          t.mbid AS track_mbid,
          UPPER(TRIM(
            CASE
              WHEN json_valid(r.isrcs) THEN json_extract(r.isrcs, '$[0]')
              ELSE r.isrcs
            END
          )) AS isrc
        FROM Tracks t
        JOIN Recordings r ON r.mbid = t.recording_mbid
        WHERE t.mbid IN (${catalogTracks.map(() => "?").join(",")})
          AND r.isrcs IS NOT NULL AND TRIM(r.isrcs) != ''
      `).all(...catalogTracks.map((t) => t.track_mbid)) as Array<{ track_mbid: string; isrc: string }>)
        .filter((row) => Boolean(String(row.isrc || "").trim()))
    : [];
  const isrcByTrack = new Map(catalogIsrcs.map((row) => [String(row.track_mbid), String(row.isrc)]));

  const offers = new Map<string, { providerTrackId: string; quality: string | null }>();
  for (const track of catalogTracks) {
    const match = byTrack.get(track.track_mbid)
      || (track.recording_mbid ? byRecording.get(track.recording_mbid) : undefined)
      || (() => {
        const isrc = isrcByTrack.get(track.track_mbid);
        return isrc ? byIsrc.get(isrc) : undefined;
      })();
    if (!match?.provider_id) continue;
    offers.set(track.track_mbid, {
      providerTrackId: String(match.provider_id),
      quality: match.quality ? String(match.quality) : null,
    });
  }
  return offers;
}

function primaryProviderAlbumId(slot: PlannedReleaseGroupSlot): string | null {
  const parts = String(slot.selected_provider_id || "").split(";").map((part) => part.trim()).filter(Boolean);
  return parts[0] || null;
}

/**
 * Queue one catalog-anchored DownloadAlbum for a release-group slot.
 *
 * - Normal full-missing match → provider album download (`acquisitionMode: "album"`).
 * - Hybrid / composite / partial-library → same DownloadAlbum with per-track offers
 *   for missing tracks only (`acquisitionMode: "trackOffers"`).
 * - Already complete library → no command.
 */
export function queueCatalogAlbumDownload(
  slot: PlannedReleaseGroupSlot,
  options: QueueTrackAcquisitionPlanOptions = {},
): { queued: boolean; recognizedHybrid: boolean; commandId: number | null } {
  const releaseGroupMbid = String(slot.release_group_mbid || "").trim();
  const providerAlbumId = primaryProviderAlbumId(slot);
  if (!releaseGroupMbid || !providerAlbumId) {
    return { queued: false, recognizedHybrid: false, commandId: null };
  }
  if (options.canQueue && !options.canQueue()) {
    return { queued: false, recognizedHybrid: isHybridTrackPlan(slot), commandId: null };
  }

  const librarySlot = librarySlotOf(slot);
  const queueRefId = `${releaseGroupMbid}:${librarySlot}`;
  const buffered = db.prepare(`
    SELECT 1 FROM commands
    WHERE name = ? AND ref_id = ? AND status IN ('queued', 'started', 'failed')
    LIMIT 1
  `).get(CommandNames.DownloadAlbum, queueRefId);
  if (buffered) {
    return { queued: false, recognizedHybrid: Boolean(parseTrackSources(slot)), commandId: null };
  }

  const releaseMbid = resolveReleaseMbid(slot);
  const catalogTracks = loadCatalogTracks(releaseMbid);
  const hybridSources = parseTrackSources(slot);
  const provider = String(slot.selected_provider || "tidal");
  const artistName = slot.artist_name || slot.provider_artist_name || "Unknown Artist";
  const albumTitle = slot.title || slot.provider_title || "Unknown Album";

  const hybridByTrack = new Map<string, TrackSource>();
  const hybridByRecording = new Map<string, TrackSource>();
  if (hybridSources) {
    for (const source of hybridSources) {
      if (source.canonicalTrackMbid) hybridByTrack.set(source.canonicalTrackMbid, source);
      if (source.canonicalRecordingMbid) hybridByRecording.set(source.canonicalRecordingMbid, source);
    }
  }

  const albumProviderOffers = (!hybridSources && catalogTracks.length > 0)
    ? resolveProviderTrackOffersForAlbum(provider, providerAlbumId, catalogTracks)
    : new Map<string, { providerTrackId: string; quality: string | null }>();

  const trackStates: DownloadTrackStateEntry[] = [];
  const missingOffers: DownloadTrackOffer[] = [];

  if (catalogTracks.length > 0) {
    for (const track of catalogTracks) {
      const downloaded = isTrackDownloaded(
        librarySlot,
        track.track_mbid,
        track.recording_mbid,
        releaseGroupMbid,
      );
      const hybrid = hybridByTrack.get(track.track_mbid)
        || (track.recording_mbid ? hybridByRecording.get(track.recording_mbid) : undefined);
      const albumOffer = albumProviderOffers.get(track.track_mbid);
      const providerTrackId = hybrid?.providerTrackId || albumOffer?.providerTrackId || undefined;
      const trackQuality = hybrid?.quality || albumOffer?.quality || slot.quality || null;

      trackStates.push({
        title: track.title,
        trackNum: track.track_num || undefined,
        volumeNum: track.volume_num || undefined,
        // `skipped` = already in library (stays green through import of the rest).
        // `completed` is reserved for download-session progress that import resets.
        status: downloaded ? "skipped" : "queued",
        providerTrackId,
        provider: providerTrackId ? provider : undefined,
        quality: trackQuality,
        canonicalTrackMbid: track.track_mbid,
        canonicalRecordingMbid: track.recording_mbid,
      });

      if (!downloaded && providerTrackId) {
        missingOffers.push({
          provider,
          providerTrackId,
          canonicalTrackMbid: track.track_mbid,
          canonicalRecordingMbid: track.recording_mbid,
          title: track.title,
          quality: trackQuality,
          trackNum: track.track_num,
          volumeNum: track.volume_num,
        });
      }
    }
  } else if (hybridSources) {
    // Catalog tracklist unavailable — fall back to hybrid evidence order.
    for (const source of hybridSources) {
      const downloaded = isTrackDownloaded(
        librarySlot,
        source.canonicalTrackMbid,
        source.canonicalRecordingMbid || null,
        releaseGroupMbid,
      );
      trackStates.push({
        title: source.title,
        trackNum: source.trackNum ?? undefined,
        volumeNum: source.volumeNum ?? undefined,
        status: downloaded ? "skipped" : "queued",
        providerTrackId: source.providerTrackId,
        provider,
        quality: source.quality,
        canonicalTrackMbid: source.canonicalTrackMbid || undefined,
        canonicalRecordingMbid: source.canonicalRecordingMbid || undefined,
      });
      if (!downloaded) {
        missingOffers.push({
          provider,
          providerTrackId: source.providerTrackId,
          canonicalTrackMbid: source.canonicalTrackMbid || null,
          canonicalRecordingMbid: source.canonicalRecordingMbid || null,
          title: source.title,
          quality: source.quality,
          trackNum: source.trackNum,
          volumeNum: source.volumeNum,
        });
      }
    }
  }

  const presentCount = trackStates.filter((track) => track.status === "skipped" || track.status === "completed").length;
  const allPresent = trackStates.length > 0 && presentCount === trackStates.length;
  if (allPresent) {
    return { queued: false, recognizedHybrid: Boolean(hybridSources), commandId: null };
  }

  // Prefer track-offer fetches when hybrid evidence exists, or when the library
  // already has part of the album (avoid re-pulling the whole provider album).
  const forceTrackOffers = Boolean(hybridSources) || presentCount > 0;
  let acquisitionMode: DownloadAlbumAcquisitionMode = "album";
  if (forceTrackOffers) {
    if (missingOffers.length === 0) {
      // Partial album but we could not resolve provider track ids — do not
      // re-download the full album blindly.
      return { queued: false, recognizedHybrid: Boolean(hybridSources), commandId: null };
    }
    acquisitionMode = "trackOffers";
  }

  const done = presentCount;
  const total = Math.max(trackStates.length, done + missingOffers.length, 1);
  const commandId = CommandQueueManager.push(CommandNames.DownloadAlbum, {
    url: acquisitionMode === "album"
      ? buildStreamingMediaUrl("album", providerAlbumId, provider as any)
      : null,
    type: "album",
    provider,
    providerId: providerAlbumId,
    releaseGroupMbid,
    releaseMbid: releaseMbid || null,
    albumId: releaseGroupMbid,
    libraryRoot: librarySlot === "spatial" ? "spatial" : "music",
    slot: librarySlot,
    title: albumTitle,
    artist: artistName,
    artists: [artistName].filter(Boolean),
    cover: slot.provider_cover || null,
    quality: slot.quality || null,
    description: `${albumTitle} by ${artistName} (${librarySlot})`,
    acquisitionMode,
    trackOffers: acquisitionMode === "trackOffers" ? missingOffers : undefined,
    downloadState: {
      state: "queued",
      currentFileNum: done,
      totalFiles: total,
      progress: total > 0 ? Math.round((done / total) * 100) : 0,
      tracks: trackStates.length > 0 ? trackStates : undefined,
    },
  }, queueRefId, 0, 1);

  if (commandId !== -1) {
    options.onQueued?.(commandId);
    return { queued: true, recognizedHybrid: Boolean(hybridSources), commandId };
  }
  return { queued: false, recognizedHybrid: Boolean(hybridSources), commandId: null };
}

/**
 * Queue the selected acquisition plan for a composite or partial slot.
 * Returns `recognized: true` when hybrid track evidence was present (whether or
 * not a command was queued — e.g. all tracks already on disk).
 *
 * Both automatic missing-item searches and manual album downloads use this path
 * so they cannot accidentally download every source album in a hybrid plan.
 */
export function queueTrackAcquisitionPlan(
  slot: PlannedReleaseGroupSlot,
  options: QueueTrackAcquisitionPlanOptions = {},
): { recognized: boolean; commandIds: number[] } {
  const sources = parseTrackSources(slot);
  if (!sources) return { recognized: false, commandIds: [] };

  const result = queueCatalogAlbumDownload(slot, options);
  return {
    recognized: true,
    commandIds: result.commandId != null ? [result.commandId] : [],
  };
}
