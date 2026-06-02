import { db } from "../database.js";
import { resolveLibraryFileIdentity, type LibraryFileIdentityInput } from "./library-file-identity.js";

export type CanonicalTrackPosition = {
  trackMbid: string;
  title: string;
  trackNumber: number;
  volumeNumber: number;
};

export function getCanonicalTrackPosition(canonicalTrackMbid: string | null | undefined): CanonicalTrackPosition | null {
  const trackMbid = String(canonicalTrackMbid || "").trim();
  if (!trackMbid) {
    return null;
  }

  const row = db.prepare(`
    SELECT mbid, title, position, medium_position
    FROM Tracks
    WHERE mbid = ?
    LIMIT 1
  `).get(trackMbid) as {
    mbid: string;
    title: string;
    position: number | null;
    medium_position: number | null;
  } | undefined;

  if (!row || !Number(row.position || 0)) {
    return null;
  }

  return {
    trackMbid: row.mbid,
    title: row.title,
    trackNumber: Number(row.position),
    volumeNumber: Number(row.medium_position || 1),
  };
}

export function resolveCanonicalTrackPosition(input: LibraryFileIdentityInput): CanonicalTrackPosition | null {
  const identity = resolveLibraryFileIdentity(input);
  return getCanonicalTrackPosition(identity.canonicalTrackMbid);
}
