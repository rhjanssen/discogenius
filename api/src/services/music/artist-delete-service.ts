import { db } from "../../database.js";
import { deleteArtistLibraryFiles } from "../mediafiles/library-file-delete-service.js";
import {
  invalidateAllDownloadState,
  invalidateArtistDownloadStatus,
} from "../download/download-state.js";

export type DeleteArtistResult = {
  artistId: string;
  deletedFiles: number;
  missingFiles: number;
  fileErrors: number;
  deletedArtist: boolean;
};

/**
 * Remove an artist from the library (Lidarr Delete Artist).
 * Optionally deletes on-disk files first. Does not add import-list exclusions
 * (that feature does not exist yet).
 */
export function deleteArtistFromLibrary(
  artistIdInput: string,
  options: { deleteFiles?: boolean } = {},
): DeleteArtistResult {
  const artistId = String(artistIdInput || "").trim();
  if (!artistId) {
    const error = new Error("Artist id is required") as Error & { status?: number };
    error.status = 400;
    throw error;
  }

  const artist = db.prepare("SELECT id FROM Artists WHERE id = ?").get(artistId) as { id: number } | undefined;
  if (!artist) {
    const error = new Error("Artist not found") as Error & { status?: number };
    error.status = 404;
    throw error;
  }

  let deletedFiles = 0;
  let missingFiles = 0;
  let fileErrors = 0;

  if (options.deleteFiles === true) {
    // Removing the artist removes them from every Library at once, so this is
    // the explicitly named all-Library deletion rather than an omitted scope.
    const fileResult = deleteArtistLibraryFiles(artistId, {
      allLibraries: true,
      unmonitor: false,
    });
    deletedFiles = fileResult.deleted;
    missingFiles = fileResult.missing;
    fileErrors = fileResult.errors;
  }

  const tx = db.transaction(() => {
    // Drop remaining tracked file rows even when deleteFiles was false (DB-only remove).
    for (const table of ["MetadataFiles", "LyricFiles", "ExtraFiles"] as const) {
      try {
        db.prepare(`DELETE FROM ${table} WHERE artist_id = ?`).run(artistId);
      } catch {
        // table may be absent on older schemas
      }
    }
    db.prepare("DELETE FROM TrackFiles WHERE artist_id = ?").run(artistId);
    try {
      db.prepare("DELETE FROM UnmappedFiles WHERE artist_id = ?").run(artistId);
    } catch {
      // optional table
    }
    try {
      db.prepare("DELETE FROM ArtistStatistics WHERE artist_id = ?").run(artistId);
    } catch {
      // optional table
    }

    db.prepare("DELETE FROM Artists WHERE id = ?").run(artistId);
  });
  tx();

  try {
    invalidateArtistDownloadStatus(artistId);
    invalidateAllDownloadState();
  } catch {
    // best-effort cache bust
  }

  return {
    artistId,
    deletedFiles,
    missingFiles,
    fileErrors,
    deletedArtist: true,
  };
}
