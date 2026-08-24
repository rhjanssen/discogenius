import { db } from "../../database.js";
import { deleteArtistLibraryFiles } from "../mediafiles/library-file-delete-service.js";
import {
  invalidateAllDownloadState,
  invalidateArtistDownloadStatus,
} from "../download/download-state.js";
import {
  loadArtistMetadataIdentity,
  removeArtistFromLibraries,
  resolveArtistMetadataId,
} from "./managed-artists.js";

export type DeleteArtistResult = {
  artistId: string;
  deletedFiles: number;
  missingFiles: number;
  fileErrors: number;
  deletedArtist: boolean;
};

/**
 * Remove an artist from every library (Lidarr Delete Artist).
 * Optionally deletes on-disk files first. Catalog ArtistMetadata is kept.
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

  const identity = loadArtistMetadataIdentity(artistId);
  if (!identity) {
    const error = new Error("Artist not found") as Error & { status?: number };
    error.status = 404;
    throw error;
  }

  let deletedFiles = 0;
  let missingFiles = 0;
  let fileErrors = 0;

  if (options.deleteFiles === true) {
    const fileResult = deleteArtistLibraryFiles(identity.mbid, {
      allLibraries: true,
      unmonitor: false,
    });
    deletedFiles = fileResult.deleted;
    missingFiles = fileResult.missing;
    fileErrors = fileResult.errors;
  }

  const metadataId = resolveArtistMetadataId(artistId) ?? identity.id;
  const tx = db.transaction(() => {
    for (const table of ["MetadataFiles", "LyricFiles", "ExtraFiles"] as const) {
      try {
        db.prepare(`DELETE FROM ${table} WHERE artist_id = ?`).run(identity.mbid);
      } catch {
        // table may be absent on older schemas
      }
    }
    db.prepare("DELETE FROM TrackFiles WHERE artist_metadata_id = ?").run(metadataId);
    try {
      db.prepare("DELETE FROM UnmappedFiles WHERE artist_metadata_id = ?").run(identity.mbid);
    } catch {
      // optional table
    }
    try {
      db.prepare("DELETE FROM ArtistStatistics WHERE artist_metadata_id = ?").run(metadataId);
    } catch {
      // optional table
    }

    removeArtistFromLibraries(metadataId);
  });
  tx();

  try {
    invalidateArtistDownloadStatus(identity.mbid);
    invalidateAllDownloadState();
  } catch {
    // best-effort
  }

  return {
    artistId: identity.mbid,
    deletedFiles,
    missingFiles,
    fileErrors,
    deletedArtist: true,
  };
}
