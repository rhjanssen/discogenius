import { db } from "../../database.js";
import { getConfigSection } from "../config/config.js";
import { LibraryFilesService } from "../mediafiles/library-files.js";
import { LibraryCurationService } from "./library-curation-service.js";

interface ArtistCurationIdentity {
  localArtistId: string | null;
  canonicalArtistId: number | null;
  artistMbid: string | null;
}

export class CurationService {
  private static resolveIdentity(inputValue: string): ArtistCurationIdentity {
    const input = String(inputValue || "").trim();
    const row = db.prepare(`
      SELECT
        CAST(local.id AS TEXT) AS local_artist_id,
        canonical.id AS canonical_artist_id,
        canonical.mbid
      FROM ArtistMetadata canonical
      LEFT JOIN Artists local ON local.mbid = canonical.mbid
      WHERE CAST(local.id AS TEXT) = ?
         OR canonical.mbid = ?
         OR CAST(canonical.id AS TEXT) = ?
      ORDER BY CASE WHEN CAST(local.id AS TEXT) = ? THEN 0 ELSE 1 END
      LIMIT 1
    `).get(input, input, input, input) as {
      local_artist_id: string | null;
      canonical_artist_id: number;
      mbid: string;
    } | undefined;
    return {
      localArtistId: row?.local_artist_id ?? null,
      canonicalArtistId: row?.canonical_artist_id ?? null,
      artistMbid: row?.mbid ?? null,
    };
  }

  static async processAll(
    artistId: string,
    options: { skipDownloadQueue?: boolean; forceDownloadQueue?: boolean } = {},
  ): Promise<{ newAlbums: number; upgradedAlbums: number }> {
    const identity = this.resolveIdentity(artistId);
    if (identity.canonicalArtistId == null || !identity.artistMbid) {
      return { newAlbums: 0, upgradedAlbums: 0 };
    }

    const managedArtistId = (db.prepare(`
      INSERT INTO ManagedArtists (artist_id, path, metadata_status, updated_at)
      VALUES (
        ?,
        (SELECT path FROM Artists WHERE mbid = ? LIMIT 1),
        'verified',
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(artist_id) DO UPDATE SET
        path = COALESCE(excluded.path, ManagedArtists.path),
        metadata_status = excluded.metadata_status,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `).get(identity.canonicalArtistId, identity.artistMbid) as { id: number }).id;
    db.prepare(`
      INSERT OR IGNORE INTO LibraryArtists (
        library_id, managed_artist_id, monitored, credited_scope
      )
      SELECT id, ?, 1, 'release_and_track_credit'
      FROM Libraries
      WHERE enabled = 1
    `).run(managedArtistId);

    const libraries = db.prepare(`
      SELECT library.id
      FROM Libraries library
      JOIN LibraryArtists library_artist ON library_artist.library_id = library.id
      WHERE library.enabled = 1
        AND library_artist.managed_artist_id = ?
        AND library_artist.monitored = 1
      ORDER BY library.id
    `).all(managedArtistId) as Array<{ id: number }>;
    const selectedBefore = Number((db.prepare(`
      SELECT COUNT(*) AS count
      FROM LibraryEditions release
      JOIN LibraryEditionScopes scope ON scope.library_edition_id = release.id
      JOIN LibraryArtists artist ON artist.id = scope.library_artist_id
      WHERE artist.managed_artist_id = ?
    `).get(managedArtistId) as { count: number }).count);
    const configuredPriority = getConfigSection("streaming")?.provider_priority;
    const providerPriority = Array.isArray(configuredPriority)
      ? configuredPriority.map(String)
      : [];
    const curation = new LibraryCurationService(db);
    for (const library of libraries) {
      curation.curateLibrary({
        libraryId: library.id,
        curationVersion: 1,
        acquisitionPlannerVersion: 1,
        providerPriority,
      });
    }
    const selectedAfter = Number((db.prepare(`
      SELECT COUNT(*) AS count
      FROM LibraryEditions release
      JOIN LibraryEditionScopes scope ON scope.library_edition_id = release.id
      JOIN LibraryArtists artist ON artist.id = scope.library_artist_id
      WHERE artist.managed_artist_id = ?
    `).get(managedArtistId) as { count: number }).count);

    const cleanupArtistId = identity.localArtistId;
    if (cleanupArtistId && getConfigSection("monitoring")?.remove_unmonitored_files === true) {
      LibraryFilesService.pruneUnmonitoredFiles(cleanupArtistId);
    }
    if (cleanupArtistId) {
      LibraryFilesService.pruneDisabledMetadataFiles(cleanupArtistId);
    }
    if (options.skipDownloadQueue !== undefined || options.forceDownloadQueue !== undefined) {
      console.log(
        `[Queue] Ignoring curation auto-queue flags for artist ${artistId}; `
        + "DownloadMissing remains the dedicated queueing path.",
      );
    }
    return {
      newAlbums: Math.max(0, selectedAfter - selectedBefore),
      upgradedAlbums: 0,
    };
  }
}
