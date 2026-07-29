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
            WHERE file.track_id = track.id AND file.file_class = 'audio'
          ),
          MAX(CASE
            WHEN plan.state = 'current'
             AND variant.quality_class <> 'spatial'
            THEN 1 ELSE 0
          END),
          MAX(CASE
            WHEN plan.state = 'current'
             AND variant.quality_class = 'spatial'
            THEN 1 ELSE 0
          END),
          CURRENT_TIMESTAMP
        FROM Tracks track
        LEFT JOIN Recordings recording ON recording.id = track.recording_id
        JOIN LibraryReleases library_release
          ON library_release.release_id = track.album_release_id
        JOIN AlbumReleases release
          ON release.id = library_release.release_id
        JOIN LibraryReleaseGroups library_group
          ON library_group.library_id = library_release.library_id
         AND library_group.release_group_id = release.release_group_id
         AND library_group.monitored = 1
        LEFT JOIN AcquisitionPlans plan
          ON plan.library_release_id = library_release.id
        LEFT JOIN AcquisitionPlanTracks plan_track
          ON plan_track.plan_id = plan.id
         AND plan_track.track_id = track.id
        LEFT JOIN ProviderItemAudioVariants variant
          ON variant.id = plan_track.provider_audio_variant_id
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
