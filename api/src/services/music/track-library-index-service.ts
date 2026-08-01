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
          album_edition_id,
          recording_id,
          popularity,
          downloaded,
          has_stereo,
          has_spatial,
          updated_at
        )
        SELECT
          track.id,
          track.album_edition_id,
          track.recording_id,
          COALESCE(recording.popularity, 0),
          EXISTS (
            SELECT 1 FROM TrackFiles file
            WHERE file.track_id = track.id AND file.file_class = 'audio'
          ),
          MAX(CASE
            WHEN plan.state = 'current'
             AND plan_track.id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1
               FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
               WHERE allowed.value = 'spatial'
             )
            THEN 1 ELSE 0
          END),
          MAX(CASE
            WHEN plan.state = 'current'
             AND plan_track.id IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
               WHERE allowed.value = 'spatial'
             )
            THEN 1 ELSE 0
          END),
          CURRENT_TIMESTAMP
        FROM Tracks track
        LEFT JOIN Recordings recording ON recording.id = track.recording_id
        JOIN LibraryEditions library_release
          ON library_release.edition_id = track.album_edition_id
        JOIN Libraries library
          ON library.id = library_release.library_id
         AND library.enabled = 1
        JOIN quality_profiles quality_profile
          ON quality_profile.id = library.quality_profile_id
        JOIN AlbumEditions release
          ON release.id = library_release.edition_id
        JOIN LibraryAlbums library_group
          ON library_group.library_id = library_release.library_id
         AND library_group.release_group_id = release.release_group_id
         AND library_group.monitored = 1
        LEFT JOIN SelectedAcquisitionPlans plan
          ON plan.library_edition_id = library_release.id
        LEFT JOIN AcquisitionPlanTracks plan_track
          ON plan_track.plan_id = plan.id
         AND plan_track.track_id = track.id
        GROUP BY track.id
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
