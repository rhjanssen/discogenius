import { db } from "../../database.js";

/**
 * Compact read model for the selected, monitored track library.
 *
 * The full MusicBrainz catalog intentionally remains normalized. This table
 * contains only the identities and filter/sort flags used to page the library,
 * so a request never has to walk every catalog track or provider offer.
 */
export class TrackLibraryIndexService {
  static isReady(): boolean {
    return Boolean(db.prepare(`
      SELECT 1 FROM TrackLibraryProjectionState WHERE singleton_id = 1
    `).get());
  }

  static needsRebuild(): boolean {
    return !this.isReady();
  }

  static rebuild(): { rows: number } {
    return db.transaction(() => {
      db.prepare("DELETE FROM TrackLibraryIndex").run();

      const result = db.prepare(`
        INSERT INTO TrackLibraryIndex (
          track_id,
          album_release_id,
          recording_id,
          popularity,
          downloaded,
          has_stereo,
          has_spatial,
          updated_at
        )
        SELECT
          track.id,
          track.album_release_id,
          track.recording_id,
          COALESCE(recording.popularity, 0),
          EXISTS (
            SELECT 1 FROM TrackFiles file
            WHERE file.track_id = track.id AND file.file_type = 'track'
          ),
          EXISTS (
            SELECT 1 FROM ReleaseGroupSlots stereo_slot
            WHERE stereo_slot.selected_album_release_id = track.album_release_id
              AND stereo_slot.slot = 'stereo'
              AND stereo_slot.monitored = 1
              AND stereo_slot.selected_provider_id IS NOT NULL
          ),
          EXISTS (
            SELECT 1 FROM ReleaseGroupSlots spatial_slot
            WHERE spatial_slot.selected_album_release_id = track.album_release_id
              AND spatial_slot.slot = 'spatial'
              AND spatial_slot.monitored = 1
              AND spatial_slot.selected_provider_id IS NOT NULL
          ),
          CURRENT_TIMESTAMP
        FROM Tracks track
        LEFT JOIN Recordings recording ON recording.id = track.recording_id
        WHERE track.album_release_id IN (
          SELECT selected_slot.selected_album_release_id
          FROM ReleaseGroupSlots selected_slot
          WHERE selected_slot.monitored = 1
            AND selected_slot.selected_provider_id IS NOT NULL
            AND selected_slot.selected_album_release_id IS NOT NULL
        )
      `).run();

      const rows = Number(result.changes || 0);
      db.prepare(`
        INSERT INTO TrackLibraryProjectionState (singleton_id, row_count, updated_at)
        VALUES (1, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(singleton_id) DO UPDATE SET
          row_count = excluded.row_count,
          updated_at = CURRENT_TIMESTAMP
      `).run(rows);

      return { rows };
    })();
  }
}
