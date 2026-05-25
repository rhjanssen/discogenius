import { db } from "../../../database.js";
import { ExtraFileService, type ExtraFileUpsertInput } from "../files/extra-file-service.js";

export type LyricFileRow = {
  Id: number;
  ArtistId: string;
  AlbumId: string | null;
  TrackFileId: number | null;
  MediaId: string | null;
  RelativePath: string;
  FilePath: string;
  LibraryRoot: string;
  Extension: string;
  Provider: string | null;
  ProviderEntityType: string | null;
  ProviderId: string | null;
  LibrarySlot: string;
  Quality: string | null;
  CanonicalRecordingMbid: string | null;
};

export class LyricFileService {
  static upsert(input: ExtraFileUpsertInput): number {
    const base = ExtraFileService.buildBaseRecord(input);

    const info = db.prepare(`
      INSERT INTO LyricFiles (
        ArtistId, AlbumId, TrackFileId, MediaId,
        RelativePath, FilePath, LibraryRoot, Extension,
        Provider, ProviderEntityType, ProviderId,
        LibrarySlot, Quality,
        CanonicalArtistMbid, CanonicalReleaseGroupMbid, CanonicalReleaseMbid,
        CanonicalTrackMbid, CanonicalRecordingMbid,
        ExpectedPath, NeedsRename, LastUpdated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(FilePath) DO UPDATE SET
        ArtistId = excluded.ArtistId,
        AlbumId = excluded.AlbumId,
        TrackFileId = excluded.TrackFileId,
        MediaId = excluded.MediaId,
        RelativePath = excluded.RelativePath,
        LibraryRoot = excluded.LibraryRoot,
        Extension = excluded.Extension,
        Provider = excluded.Provider,
        ProviderEntityType = excluded.ProviderEntityType,
        ProviderId = excluded.ProviderId,
        LibrarySlot = excluded.LibrarySlot,
        Quality = excluded.Quality,
        CanonicalArtistMbid = COALESCE(excluded.CanonicalArtistMbid, LyricFiles.CanonicalArtistMbid),
        CanonicalReleaseGroupMbid = COALESCE(excluded.CanonicalReleaseGroupMbid, LyricFiles.CanonicalReleaseGroupMbid),
        CanonicalReleaseMbid = COALESCE(excluded.CanonicalReleaseMbid, LyricFiles.CanonicalReleaseMbid),
        CanonicalTrackMbid = COALESCE(excluded.CanonicalTrackMbid, LyricFiles.CanonicalTrackMbid),
        CanonicalRecordingMbid = COALESCE(excluded.CanonicalRecordingMbid, LyricFiles.CanonicalRecordingMbid),
        ExpectedPath = excluded.ExpectedPath,
        NeedsRename = excluded.NeedsRename,
        LastUpdated = CURRENT_TIMESTAMP
    `).run(
      base.ArtistId,
      base.AlbumId,
      base.TrackFileId,
      base.MediaId,
      base.RelativePath,
      base.FilePath,
      base.LibraryRoot,
      base.Extension,
      base.Provider,
      base.ProviderEntityType,
      base.ProviderId,
      base.LibrarySlot,
      input.quality || null,
      input.canonicalArtistMbid || null,
      input.canonicalReleaseGroupMbid || null,
      input.canonicalReleaseMbid || null,
      input.canonicalTrackMbid || null,
      input.canonicalRecordingMbid || null,
      base.ExpectedPath,
      base.NeedsRename,
    );

    return Number(info.lastInsertRowid || ExtraFileService.findIdByPath("LyricFiles", input.filePath) || 0);
  }

  static findByProviderTrack(provider: string, providerTrackId: string): LyricFileRow | null {
    return (db.prepare(`
      SELECT *
      FROM LyricFiles
      WHERE (
          Provider = ?
          AND ProviderEntityType = 'track'
          AND CAST(ProviderId AS TEXT) = CAST(? AS TEXT)
        )
        OR CAST(MediaId AS TEXT) = CAST(? AS TEXT)
      ORDER BY LastUpdated DESC, Id DESC
      LIMIT 1
    `).get(provider, providerTrackId, providerTrackId) as LyricFileRow | undefined) ?? null;
  }

  static findByForeignRecording(foreignRecordingId: string): LyricFileRow | null {
    return (db.prepare(`
      WITH related_recordings(recording_mbid) AS (
        SELECT ?
        UNION
        SELECT CASE
          WHEN SourceForeignRecordingId = ? THEN TargetForeignRecordingId
          ELSE SourceForeignRecordingId
        END
        FROM RecordingRelations
        WHERE RelationType IN ('same_lyrical_content', 'spatial_mix_of', 'alternate_mix_of')
          AND (SourceForeignRecordingId = ? OR TargetForeignRecordingId = ?)
      )
      SELECT *
      FROM LyricFiles
      WHERE CanonicalRecordingMbid IN (
        SELECT recording_mbid FROM related_recordings WHERE recording_mbid IS NOT NULL
      )
      ORDER BY CASE WHEN CanonicalRecordingMbid = ? THEN 0 ELSE 1 END,
               LastUpdated DESC,
               Id DESC
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
