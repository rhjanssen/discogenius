import { db as defaultDb } from "../database.js";
import {
  buildLidarrReleaseMonitoringDecisions,
  type LidarrAlbumReleaseCandidate,
  type LidarrReleaseGroupCandidate,
  type LidarrTrackCandidate,
} from "./lidarr-release-selection.js";
import type { LidarrLibraryType } from "./lidarr-domain-schema.js";
import type Database from "better-sqlite3";

export interface ApplyReleaseMonitoringOptions {
  database?: Database.Database;
  artistId?: string;
  libraryTypes?: LidarrLibraryType[];
  redundancyEnabled?: boolean;
}

export interface ApplyReleaseMonitoringResult {
  releaseGroups: number;
  decisions: number;
  monitored: number;
  redundant: number;
}

interface ReleaseGroupRow {
  id: number;
  artist_metadata_id: number;
  title: string;
  album_type: string | null;
  monitored: number;
  selected_release_id: number | null;
}

interface ReleaseRow {
  id: number;
  release_group_id: number;
  title: string;
  status: string | null;
  release_date: string | null;
  media: string | null;
  track_count: number | null;
  monitored: number;
  stereo_available: number;
  atmos_available: number;
}

interface TrackRow {
  id: number;
  album_release_id: number;
  foreign_recording_id: string | null;
  title: string;
  absolute_track_number: number | null;
  isrcs: string | null;
}

export class LidarrReleaseMonitoringService {
  static applyMonitoringDecisions(options: ApplyReleaseMonitoringOptions = {}): ApplyReleaseMonitoringResult {
    const database = options.database || defaultDb;
    const libraryTypes = options.libraryTypes || ["stereo", "atmos"];
    const releaseGroups = loadReleaseGroupCandidates(database, options.artistId);
    const result = buildLidarrReleaseMonitoringDecisions({
      releaseGroups,
      libraryTypes,
      redundancyEnabled: options.redundancyEnabled,
    });

    const upsertMonitoring = database.prepare(`
      INSERT INTO release_group_monitoring (
        release_group_id, library_type, monitored, selected_release_id,
        monitored_at, redundancy_state, redundant_to_release_group_id, redundancy_reason
      ) VALUES (?, ?, ?, ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END, ?, ?, ?)
      ON CONFLICT(release_group_id, library_type) DO UPDATE SET
        monitored = excluded.monitored,
        selected_release_id = excluded.selected_release_id,
        monitored_at = CASE
          WHEN excluded.monitored = 1 AND release_group_monitoring.monitored_at IS NULL THEN CURRENT_TIMESTAMP
          WHEN excluded.monitored = 0 THEN NULL
          ELSE release_group_monitoring.monitored_at
        END,
        redundancy_state = excluded.redundancy_state,
        redundant_to_release_group_id = excluded.redundant_to_release_group_id,
        redundancy_reason = excluded.redundancy_reason
    `);
    const clearReleaseMonitoring = database.prepare("UPDATE album_releases SET monitored = 0 WHERE release_group_id = ?");
    const markSelectedRelease = database.prepare("UPDATE album_releases SET monitored = 1 WHERE id = ?");

    const tx = database.transaction(() => {
      const touchedReleaseGroups = new Set<string>();
      for (const decision of result.decisions) {
        touchedReleaseGroups.add(decision.releaseGroupId);
        const redundancyState = decision.reason === "redundant_track_subset" ? "redundant" : decision.reason;
        upsertMonitoring.run(
          decision.releaseGroupId,
          decision.libraryType,
          decision.monitored ? 1 : 0,
          decision.selectedReleaseId,
          decision.monitored ? 1 : 0,
          redundancyState,
          decision.redundantToReleaseGroupId,
          decision.reason,
        );
      }

      for (const releaseGroupId of touchedReleaseGroups) {
        clearReleaseMonitoring.run(releaseGroupId);
      }

      const selectedReleaseIds = new Set(
        result.decisions
          .filter((decision) => decision.monitored && decision.selectedReleaseId)
          .map((decision) => decision.selectedReleaseId as string),
      );
      for (const releaseId of selectedReleaseIds) {
        markSelectedRelease.run(releaseId);
      }
    });

    tx();

    return {
      releaseGroups: releaseGroups.length,
      decisions: result.decisions.length,
      monitored: result.decisions.filter((decision) => decision.monitored).length,
      redundant: result.decisions.filter((decision) => decision.reason === "redundant_track_subset").length,
    };
  }
}

function loadReleaseGroupCandidates(
  database: Database.Database,
  artistId?: string,
): LidarrReleaseGroupCandidate[] {
  const params: unknown[] = [];
  let artistWhere = "";
  if (artistId) {
    artistWhere = "WHERE CAST(ma.id AS TEXT) = ? OR CAST(rg.artist_metadata_id AS TEXT) = ?";
    params.push(artistId, artistId);
  }

  const releaseGroupRows = database.prepare(`
    SELECT
      rg.id,
      rg.artist_metadata_id,
      rg.title,
      rg.album_type,
      rg.monitored,
      (
        SELECT selected_release_id
        FROM release_group_monitoring rgm
        WHERE rgm.release_group_id = rg.id
          AND rgm.selected_release_id IS NOT NULL
        ORDER BY rgm.monitored DESC, rgm.monitored_at DESC
        LIMIT 1
      ) AS selected_release_id
    FROM release_groups rg
    LEFT JOIN managed_artists ma ON ma.artist_metadata_id = rg.artist_metadata_id
    ${artistWhere}
    ORDER BY rg.release_date, rg.title COLLATE NOCASE
  `).all(...params) as ReleaseGroupRow[];

  if (releaseGroupRows.length === 0) {
    return [];
  }

  const releaseRows = database.prepare(`
    SELECT
      ar.id,
      ar.release_group_id,
      ar.title,
      ar.status,
      ar.release_date,
      ar.media,
      ar.track_count,
      ar.monitored,
      EXISTS (
        SELECT 1 FROM provider_releases pr
        WHERE pr.album_release_id = ar.id
          AND pr.library_type = 'stereo'
      ) AS stereo_available,
      EXISTS (
        SELECT 1 FROM provider_releases pr
        WHERE pr.album_release_id = ar.id
          AND pr.library_type = 'atmos'
      ) AS atmos_available
    FROM album_releases ar
    WHERE ar.release_group_id = ?
    ORDER BY ar.track_count DESC, ar.release_date
  `);

  const trackRows = database.prepare(`
    SELECT
      id,
      album_release_id,
      foreign_recording_id,
      title,
      absolute_track_number,
      isrcs
    FROM tracks
    WHERE album_release_id = ?
    ORDER BY medium_number, absolute_track_number, track_number
  `);

  return releaseGroupRows.map((row) => {
    const releases = (releaseRows.all(row.id) as ReleaseRow[]).map((release) => mapReleaseCandidate(
      release,
      trackRows.all(release.id) as TrackRow[],
    ));

    return {
      id: row.id,
      artistId: row.artist_metadata_id,
      title: row.title,
      type: row.album_type || "other",
      monitored: Boolean(row.monitored),
      selectedReleaseId: row.selected_release_id,
      releases,
    };
  });
}

function mapReleaseCandidate(row: ReleaseRow, trackRows: TrackRow[]): LidarrAlbumReleaseCandidate {
  return {
    id: row.id,
    releaseGroupId: row.release_group_id,
    title: row.title,
    status: row.status,
    releaseDate: row.release_date,
    media: parseJsonArray(row.media),
    trackCount: row.track_count,
    monitored: Boolean(row.monitored),
    providerAvailable: {
      stereo: Boolean(row.stereo_available),
      atmos: Boolean(row.atmos_available),
    },
    tracks: trackRows.map(mapTrackCandidate),
  };
}

function mapTrackCandidate(row: TrackRow): LidarrTrackCandidate {
  return {
    id: row.id,
    recordingId: row.foreign_recording_id,
    title: row.title,
    absoluteTrackNumber: row.absolute_track_number,
    isrcs: parseJsonArray(row.isrcs),
  };
}

function parseJsonArray(value: string | null | undefined): any[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
