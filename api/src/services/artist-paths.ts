import path from "path";
import { db } from "../database.js";
import { resolveArtistFolder, resolveArtistFolderFromRecord } from "./naming.js";
import { normalizeComparablePath } from "./path-utils.js";

type ArtistFolderSeed = {
  artistId?: string | number | null;
  artistName: string;
  artistMbId?: string | null;
  existingPath?: string | null;
};

export type ArtistPathConflict = {
  artistId: string;
  artistName: string;
  path: string;
  relation: "same" | "parent" | "child";
};

function sanitizeSegment(input: string): string {
  return (input || "")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function artistPathExistsForOtherArtist(candidatePath: string, artistId?: string | number | null): boolean {
  const existing = db.prepare("SELECT id FROM artists WHERE path = ? LIMIT 1").get(candidatePath) as { id: number | string } | undefined;
  if (!existing) return false;
  if (artistId == null) return true;
  return String(existing.id) !== String(artistId);
}

function artistPathConflictsForOtherArtist(candidatePath: string, artistId?: string | number | null): boolean {
  if (artistPathExistsForOtherArtist(candidatePath, artistId)) {
    return true;
  }

  return findArtistPathConflict(candidatePath, artistId) !== null;
}

function splitArtistPath(pathValue: string): string[] {
  return String(pathValue || "")
    .split(/[\\/]+/g)
    .map((segment) => sanitizeSegment(segment))
    .filter(Boolean);
}

function buildDisambiguatedArtistPath(basePath: string, segmentIndex: number, suffix: string): string {
  const segments = splitArtistPath(basePath);
  if (segments.length === 0) {
    return basePath;
  }

  const targetIndex = Math.max(0, Math.min(segmentIndex, segments.length - 1));
  segments[targetIndex] = `${segments[targetIndex]} ${suffix}`;
  return path.join(...segments);
}

export function normalizeArtistFolderInput(rawPath: string): string {
  const trimmed = String(rawPath || "").trim();
  if (!trimmed) {
    throw new Error("Artist path must not be empty");
  }

  if (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new Error("Artist path must be relative to the configured library roots");
  }

  const segments = trimmed
    .split(/[\\/]+/g)
    .map((segment) => sanitizeSegment(segment))
    .filter((segment) => segment.length > 0)
    .filter((segment) => segment !== "." && segment !== "..");

  if (segments.length === 0) {
    throw new Error("Artist path must contain at least one valid folder segment");
  }

  return path.join(...segments);
}

export function findArtistPathConflict(candidatePath: string, artistId?: string | number | null): ArtistPathConflict | null {
  const normalizedCandidate = normalizeComparablePath(candidatePath);
  if (!normalizedCandidate) {
    return null;
  }

  const artists = db.prepare("SELECT id, name, path FROM artists WHERE path IS NOT NULL").all() as Array<{
    id: number | string;
    name: string | null;
    path: string | null;
  }>;

  for (const artist of artists) {
    if (artistId != null && String(artist.id) === String(artistId)) {
      continue;
    }

    const existingPath = String(artist.path || "").trim();
    if (!existingPath) {
      continue;
    }

    const normalizedExisting = normalizeComparablePath(existingPath);
    if (!normalizedExisting) {
      continue;
    }

    let relation: ArtistPathConflict["relation"] | null = null;
    if (normalizedExisting === normalizedCandidate) {
      relation = "same";
    } else if (normalizedCandidate.startsWith(`${normalizedExisting}/`)) {
      relation = "child";
    } else if (normalizedExisting.startsWith(`${normalizedCandidate}/`)) {
      relation = "parent";
    }

    if (relation) {
      return {
        artistId: String(artist.id),
        artistName: String(artist.name || "Unknown Artist"),
        path: existingPath,
        relation,
      };
    }
  }

  return null;
}

export function resolveArtistFolderFromTemplate(seed: ArtistFolderSeed): string {
  const basePath = resolveArtistFolder(seed.artistName, seed.artistMbId);
  const baseConflict = findArtistPathConflict(basePath, seed.artistId);

  if (!baseConflict && !artistPathExistsForOtherArtist(basePath, seed.artistId)) {
    return basePath;
  }

  const baseSegments = splitArtistPath(basePath);
  const conflictSegments = splitArtistPath(baseConflict?.path || "");
  const disambiguatedSegmentIndex = baseConflict?.relation === "child" && conflictSegments.length > 0
    ? Math.min(conflictSegments.length - 1, baseSegments.length - 1)
    : Math.max(0, baseSegments.length - 1);

  if (seed.artistId) {
    const artistIdCandidate = buildDisambiguatedArtistPath(basePath, disambiguatedSegmentIndex, `(${seed.artistId})`);
    if (!artistPathConflictsForOtherArtist(artistIdCandidate, seed.artistId)) {
      return artistIdCandidate;
    }
  }

  let index = 1;
  while (index < 100) {
    const candidatePath = buildDisambiguatedArtistPath(basePath, disambiguatedSegmentIndex, `(${index})`);
    if (!artistPathConflictsForOtherArtist(candidatePath, seed.artistId)) {
      return candidatePath;
    }
    index += 1;
  }

  return buildDisambiguatedArtistPath(basePath, disambiguatedSegmentIndex, "(99)");
}

export function resolveArtistFolderForPersistence(seed: ArtistFolderSeed): string {
  const stored = resolveArtistFolderFromRecord({
    name: seed.artistName,
    mbid: seed.artistMbId ?? null,
    path: seed.existingPath ?? null,
  });

  if (String(seed.existingPath || "").trim()) {
    return stored;
  }

  return resolveArtistFolderFromTemplate(seed);
}

export function shouldReapplyArtistPathTemplate(seed: ArtistFolderSeed): boolean {
  const existingPath = String(seed.existingPath || "").trim();
  if (!existingPath || !seed.artistMbId) {
    return false;
  }

  const currentTemplatePath = resolveArtistFolderFromTemplate({
    ...seed,
    existingPath: null,
  });

  if (normalizeComparablePath(existingPath) === normalizeComparablePath(currentTemplatePath)) {
    return false;
  }

  const legacyTemplatePath = resolveArtistFolderFromTemplate({
    ...seed,
    artistMbId: null,
    existingPath: null,
  });

  return normalizeComparablePath(existingPath) === normalizeComparablePath(legacyTemplatePath);
}
