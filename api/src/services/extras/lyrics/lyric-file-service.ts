import { db } from "../../../database.js";
import { ExtraFileService, type ExtraFileUpsertInput } from "../files/extra-file-service.js";

export type LyricFileRow = {
  id: number;
  artist_id: string;
  album_id: string | null;
  track_file_id: number | null;
  media_id: string | null;
  relative_path: string;
  file_path: string;
  library_root: string;
  extension: string;
  provider: string | null;
  provider_entity_type: string | null;
  provider_id: string | null;
  library_slot: string;
  quality: string | null;
  canonical_recording_mbid: string | null;
};

export class LyricFileService {
  static upsert(input: ExtraFileUpsertInput): number {
    const base = ExtraFileService.buildBaseRecord(input);

    const info = db.prepare(`
      INSERT INTO LyricFiles (
        artist_id, album_id, track_file_id, media_id,
        relative_path, file_path, library_root, extension,
        provider, provider_entity_type, provider_id,
        library_slot, quality,
        canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
        canonical_track_mbid, canonical_recording_mbid,
        expected_path, needs_rename, last_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(file_path) DO UPDATE SET
        artist_id = excluded.artist_id,
        album_id = excluded.album_id,
        track_file_id = excluded.track_file_id,
        media_id = excluded.media_id,
        relative_path = excluded.relative_path,
        library_root = excluded.library_root,
        extension = excluded.extension,
        provider = excluded.provider,
        provider_entity_type = excluded.provider_entity_type,
        provider_id = excluded.provider_id,
        library_slot = excluded.library_slot,
        quality = excluded.quality,
        canonical_artist_mbid = COALESCE(excluded.canonical_artist_mbid, LyricFiles.canonical_artist_mbid),
        canonical_release_group_mbid = COALESCE(excluded.canonical_release_group_mbid, LyricFiles.canonical_release_group_mbid),
        canonical_release_mbid = COALESCE(excluded.canonical_release_mbid, LyricFiles.canonical_release_mbid),
        canonical_track_mbid = COALESCE(excluded.canonical_track_mbid, LyricFiles.canonical_track_mbid),
        canonical_recording_mbid = COALESCE(excluded.canonical_recording_mbid, LyricFiles.canonical_recording_mbid),
        expected_path = excluded.expected_path,
        needs_rename = excluded.needs_rename,
        last_updated = CURRENT_TIMESTAMP
    `).run(
      base.artist_id,
      base.album_id,
      base.track_file_id,
      base.media_id,
      base.relative_path,
      base.file_path,
      base.library_root,
      base.extension,
      base.provider,
      base.provider_entity_type,
      base.provider_id,
      base.library_slot,
      input.quality || null,
      input.canonicalArtistMbid || null,
      input.canonicalReleaseGroupMbid || null,
      input.canonicalReleaseMbid || null,
      input.canonicalTrackMbid || null,
      input.canonicalRecordingMbid || null,
      base.expected_path,
      base.needs_rename,
    );

    return Number(info.lastInsertRowid || ExtraFileService.findIdByPath("LyricFiles", input.filePath) || 0);
  }

  static findByProviderTrack(provider: string, providerTrackId: string): LyricFileRow | null {
    return (db.prepare(`
      SELECT *
      FROM LyricFiles
      WHERE (
          provider = ?
          AND provider_entity_type = 'track'
          AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
        )
        OR CAST(media_id AS TEXT) = CAST(? AS TEXT)
      ORDER BY last_updated DESC, id DESC
      LIMIT 1
    `).get(provider, providerTrackId, providerTrackId) as LyricFileRow | undefined) ?? null;
  }

  static findByForeignRecording(foreignRecordingId: string): LyricFileRow | null {
    return (db.prepare(`
      WITH related_recordings(recording_mbid) AS (
        SELECT ?
        UNION
        SELECT CASE
          WHEN source_foreign_recording_id = ? THEN target_foreign_recording_id
          ELSE source_foreign_recording_id
        END
        FROM RecordingRelations
        WHERE relation_type IN ('same_lyrical_content', 'spatial_mix_of', 'alternate_mix_of')
          AND (source_foreign_recording_id = ? OR target_foreign_recording_id = ?)
      )
      SELECT *
      FROM LyricFiles
      WHERE canonical_recording_mbid IN (
        SELECT recording_mbid FROM related_recordings WHERE recording_mbid IS NOT NULL
      )
      ORDER BY CASE WHEN canonical_recording_mbid = ? THEN 0 ELSE 1 END,
               last_updated DESC,
               id DESC
      LIMIT 1
    `).get(
      foreignRecordingId,
      foreignRecordingId,
      foreignRecordingId,
      foreignRecordingId,
      foreignRecordingId,
    ) as LyricFileRow | undefined) ?? null;
  }
}
