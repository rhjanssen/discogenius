import path from "path";
import fs from "fs";
import { db } from "../database.js";
import { resolveArtistFolder, resolveArtistFolderFromRecord } from "./naming.js";
import { Config } from "./config.js";
import { normalizeComparablePath } from "./path-utils.js";

type ArtistFolderSeed = {
  artistId?: string | number | null;
  artistName: string;
  artistMbId?: string | null;
  artistDisambiguation?: string | null;
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

function isSameCanonicalArtist(existing: { id: number | string; mbid?: string | null }, artistId?: string | number | null, artistMbId?: string | null): boolean {
  if (artistId != null && String(existing.id) === String(artistId)) {
    return true;
  }

  return Boolean(artistMbId && existing.mbid && String(existing.mbid) === String(artistMbId));
}

function artistPathExistsForOtherArtist(candidatePath: string, artistId?: string | number | null, artistMbId?: string | null): boolean {
  const existing = db.prepare("SELECT id, mbid FROM artists WHERE path = ? LIMIT 1").get(candidatePath) as
    { id: number | string; mbid?: string | null } | undefined;
  if (!existing) return false;
  return !isSameCanonicalArtist(existing, artistId, artistMbId);
}

function artistPathConflictsForOtherArtist(candidatePath: string, artistId?: string | number | null, artistMbId?: string | null): boolean {
  if (artistPathExistsForOtherArtist(candidatePath, artistId, artistMbId)) {
    return true;
  }

  return findArtistPathConflict(candidatePath, artistId, artistMbId) !== null;
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

function resolveCollisionSuffixes(seed: ArtistFolderSeed): string[] {
  const disambiguation = sanitizeSegment(String(seed.artistDisambiguation || "").trim());
  const suffixes: string[] = [];
  if (disambiguation) {
    suffixes.push(`(${disambiguation})`);
  }

  for (let index = 1; index < 100; index += 1) {
    suffixes.push(`(${index})`);
  }

  return suffixes;
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

export function findArtistPathConflict(candidatePath: string, artistId?: string | number | null, artistMbId?: string | null): ArtistPathConflict | null {
  const normalizedCandidate = normalizeComparablePath(candidatePath);
  if (!normalizedCandidate) {
    return null;
  }

  const artists = db.prepare("SELECT id, name, mbid, path FROM artists WHERE path IS NOT NULL").all() as Array<{
    id: number | string;
    name: string | null;
    mbid?: string | null;
    path: string | null;
  }>;

  for (const artist of artists) {
    if (isSameCanonicalArtist(artist, artistId, artistMbId)) {
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
  const basePath = resolveArtistFolder(seed.artistName, seed.artistMbId, seed.artistDisambiguation);
  const baseConflict = findArtistPathConflict(basePath, seed.artistId, seed.artistMbId);

  if (!baseConflict && !artistPathExistsForOtherArtist(basePath, seed.artistId, seed.artistMbId)) {
    return basePath;
  }

  const baseSegments = splitArtistPath(basePath);
  const conflictSegments = splitArtistPath(baseConflict?.path || "");
  const disambiguatedSegmentIndex = baseConflict?.relation === "child" && conflictSegments.length > 0
    ? Math.min(conflictSegments.length - 1, baseSegments.length - 1)
    : Math.max(0, baseSegments.length - 1);

  for (const suffix of resolveCollisionSuffixes(seed)) {
    const candidatePath = buildDisambiguatedArtistPath(basePath, disambiguatedSegmentIndex, suffix);
    if (!artistPathConflictsForOtherArtist(candidatePath, seed.artistId, seed.artistMbId)) {
      return candidatePath;
    }
  }

  return buildDisambiguatedArtistPath(basePath, disambiguatedSegmentIndex, "(99)");
}

export function resolveArtistFolderForPersistence(seed: ArtistFolderSeed): string {
  const stored = resolveArtistFolderFromRecord({
    name: seed.artistName,
    mbid: seed.artistMbId ?? null,
    disambiguation: seed.artistDisambiguation ?? null,
    path: seed.existingPath ?? null,
  });

  if (String(seed.existingPath || "").trim()) {
    return stored;
  }

  return resolveArtistFolderFromTemplate(seed);
}

export function resolveArtistFolderForIdentityUpdate(seed: ArtistFolderSeed): {
  path: string;
  shouldReplaceExistingPath: boolean;
} {
  if (shouldReapplyArtistPathTemplate(seed)) {
    return {
      path: resolveArtistFolderFromTemplate({
        ...seed,
        existingPath: null,
      }),
      shouldReplaceExistingPath: true,
    };
  }

  return {
    path: resolveArtistFolderForPersistence(seed),
    shouldReplaceExistingPath: false,
  };
}

export function ensureEmptyArtistFoldersIfEnabled(relativeArtistPath: string): string[] {
  if (Config.getPathConfig().create_empty_artist_folders !== true) {
    return [];
  }

  const normalizedArtistPath = normalizeArtistFolderInput(relativeArtistPath);
  const roots = Array.from(new Set([
    Config.getMusicPath(),
    Config.getSpatialPath(),
    Config.getVideoPath(),
  ].filter(Boolean)));

  const ensured: string[] = [];
  for (const root of roots) {
    const target = path.join(root, normalizedArtistPath);
    fs.mkdirSync(target, { recursive: true });
    ensured.push(target);
  }

  return ensured;
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

  if (seed.artistId) {
    const obsoleteProviderIdPath = buildDisambiguatedArtistPath(
      currentTemplatePath,
      Math.max(0, splitArtistPath(currentTemplatePath).length - 1),
      `(${seed.artistId})`,
    );
    if (normalizeComparablePath(existingPath) === normalizeComparablePath(obsoleteProviderIdPath)) {
      return true;
    }
  }

  const legacyTemplatePath = resolveArtistFolderFromTemplate({
    ...seed,
    artistMbId: null,
    existingPath: null,
  });

  return normalizeComparablePath(existingPath) === normalizeComparablePath(legacyTemplatePath);
}
