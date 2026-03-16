import fs from "fs";
import path from "path";
import { db } from "../database.js";
import { Config } from "./config.js";
import { normalizeComparablePath } from "./path-utils.js";
import type { LibraryRoot } from "./naming.js";

const LEGACY_ROOTS: Record<LibraryRoot, string> = {
  music: "/library/music",
  spatial_music: "/library/atmos",
  music_videos: "/library/videos",
};

function isAbsolutePathLike(inputPath: string): boolean {
  return path.isAbsolute(inputPath) || /^[A-Za-z]:[\\/]/.test(String(inputPath || ""));
}

function basenameForCompare(inputPath: string): string {
  const normalized = normalizeComparablePath(inputPath);
  const segments = normalized.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : "";
}

function guessRootKeyFromStoredPath(candidatePath: string): LibraryRoot | null {
  const candidateBase = basenameForCompare(candidatePath);
  if (!candidateBase) {
    return null;
  }

  for (const key of ["music", "spatial_music", "music_videos"] as const) {
    const currentBase = basenameForCompare(getCurrentLibraryRootPath(key));
    const legacyBase = basenameForCompare(LEGACY_ROOTS[key]);
    if (candidateBase === currentBase || candidateBase === legacyBase) {
      return key;
    }
  }

  return null;
}

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const normalizedCandidate = normalizeComparablePath(candidatePath);
  const normalizedRoot = normalizeComparablePath(rootPath);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function relativeFromRoot(candidatePath: string, rootPath: string): string | null {
  if (!candidatePath || !rootPath || !isWithinRoot(candidatePath, rootPath)) {
    return null;
  }

  const normalizedCandidate = normalizeComparablePath(candidatePath);
  const normalizedRoot = normalizeComparablePath(rootPath);
  if (normalizedCandidate === normalizedRoot) {
    return "";
  }

  return normalizedCandidate.slice(normalizedRoot.length + 1).split("/").join(path.sep);
}

function normalizeRelativePath(relativePath: string | null | undefined): string | null {
  if (!relativePath) return null;

  const segments = String(relativePath)
    .split(/[\\/]+/g)
    .filter(Boolean)
    .filter((segment) => segment !== "." && segment !== "..");

  return segments.length > 0 ? path.join(...segments) : "";
}

export function getCurrentLibraryRootPath(libraryRoot: LibraryRoot): string {
  if (libraryRoot === "music") return Config.getMusicPath();
  if (libraryRoot === "spatial_music") return Config.getAtmosPath();
  return Config.getVideoPath();
}

export function resolveLibraryRootKey(
  libraryRoot: string | null | undefined,
  filePath?: string | null | undefined,
): LibraryRoot | null {
  const direct = String(libraryRoot || "").trim();
  if (direct === "music" || direct === "spatial_music" || direct === "music_videos") {
    return direct;
  }

  const candidates = [libraryRoot, filePath]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const guessedKey = guessRootKeyFromStoredPath(candidate);
    if (guessedKey) {
      return guessedKey;
    }

    for (const key of ["music", "spatial_music", "music_videos"] as const) {
      if (isWithinRoot(candidate, getCurrentLibraryRootPath(key)) || isWithinRoot(candidate, LEGACY_ROOTS[key])) {
        return key;
      }
    }
  }

  return null;
}

export function resolveLibraryRootPath(
  libraryRoot: string | null | undefined,
  filePath?: string | null | undefined,
): string | null {
  const key = resolveLibraryRootKey(libraryRoot, filePath);
  if (key) {
    return getCurrentLibraryRootPath(key);
  }

  const trimmed = String(libraryRoot || "").trim();
  return trimmed && isAbsolutePathLike(trimmed) ? trimmed : null;
}

export function resolveStoredLibraryPath(options: {
  filePath: string;
  libraryRoot?: string | null;
  relativePath?: string | null;
}): string {
  const { filePath, libraryRoot, relativePath } = options;
  if (!filePath) return filePath;
  if (fs.existsSync(filePath)) return filePath;

  const key = resolveLibraryRootKey(libraryRoot, filePath);
  if (!key) return filePath;

  const currentRoot = getCurrentLibraryRootPath(key);
  const relativeCandidates = new Set<string>();
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  if (normalizedRelativePath !== null) {
    relativeCandidates.add(normalizedRelativePath);
  }

  const rootCandidates = [
    String(libraryRoot || "").trim(),
    LEGACY_ROOTS[key],
    currentRoot,
  ].filter(Boolean);

  for (const candidateRoot of rootCandidates) {
    const derivedRelative = relativeFromRoot(filePath, candidateRoot);
    if (derivedRelative !== null) {
      relativeCandidates.add(derivedRelative);
    }
  }

  for (const candidateRelative of relativeCandidates) {
    const targetPath = candidateRelative
      ? path.join(currentRoot, candidateRelative)
      : currentRoot;

    if (fs.existsSync(targetPath)) {
      return targetPath;
    }
  }

  const fallbackRelative = normalizedRelativePath ?? [...relativeCandidates][0] ?? null;
  if (fallbackRelative !== null) {
    return fallbackRelative ? path.join(currentRoot, fallbackRelative) : currentRoot;
  }

  return filePath;
}

function translateExpectedPath(
  expectedPath: string | null | undefined,
  libraryRootKey: LibraryRoot | null,
): string | null {
  if (!expectedPath || !libraryRootKey) return expectedPath || null;

  const currentRoot = getCurrentLibraryRootPath(libraryRootKey);
  if (isWithinRoot(expectedPath, currentRoot)) {
    return expectedPath;
  }

  const derivedRelative = relativeFromRoot(expectedPath, LEGACY_ROOTS[libraryRootKey]);
  if (derivedRelative === null) {
    return expectedPath;
  }

  return derivedRelative ? path.join(currentRoot, derivedRelative) : currentRoot;
}

export function reconcileStoredLibraryPaths(): {
  libraryFilesUpdated: number;
  libraryFilesDeduplicated: number;
  unmappedFilesUpdated: number;
} {
  const libraryRows = db.prepare(`
    SELECT id, file_path, relative_path, library_root, expected_path
    FROM library_files
  `).all() as Array<{
    id: number;
    file_path: string;
    relative_path: string | null;
    library_root: string;
    expected_path: string | null;
  }>;

  const unmappedRows = db.prepare(`
    SELECT id, file_path, relative_path, library_root
    FROM unmapped_files
  `).all() as Array<{
    id: number;
    file_path: string;
    relative_path: string | null;
    library_root: string;
  }>;

  const updateLibraryFile = db.prepare(`
    UPDATE library_files
    SET file_path = ?,
        relative_path = ?,
        library_root = ?,
        filename = ?,
        extension = ?,
        expected_path = ?,
        verified_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  const deleteLibraryFile = db.prepare(`DELETE FROM library_files WHERE id = ?`);
  const findLibraryConflict = db.prepare(`SELECT id FROM library_files WHERE file_path = ? AND id != ? LIMIT 1`);

  const updateUnmappedFile = db.prepare(`
    UPDATE unmapped_files
    SET file_path = ?,
        relative_path = ?,
        library_root = ?,
        filename = ?,
        extension = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  const deleteUnmappedFile = db.prepare(`DELETE FROM unmapped_files WHERE id = ?`);
  const findUnmappedConflict = db.prepare(`SELECT id FROM unmapped_files WHERE file_path = ? AND id != ? LIMIT 1`);

  let libraryFilesUpdated = 0;
  let libraryFilesDeduplicated = 0;
  let unmappedFilesUpdated = 0;

  db.transaction(() => {
    for (const row of libraryRows) {
      const libraryRootKey = resolveLibraryRootKey(row.library_root, row.file_path);
      if (!libraryRootKey) continue;

      const currentRoot = getCurrentLibraryRootPath(libraryRootKey);
      const resolvedFilePath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
        relativePath: row.relative_path,
      });

      if (!fs.existsSync(resolvedFilePath)) continue;

      const nextRelativePath = path.relative(currentRoot, resolvedFilePath);
      const nextExpectedPath = translateExpectedPath(row.expected_path, libraryRootKey);
      const normalizedCurrentPath = normalizeComparablePath(row.file_path);
      const normalizedResolvedPath = normalizeComparablePath(resolvedFilePath);
      const normalizedStoredRoot = normalizeComparablePath(row.library_root);
      const normalizedCurrentRoot = normalizeComparablePath(currentRoot);

      if (
        normalizedCurrentPath === normalizedResolvedPath &&
        normalizedStoredRoot === normalizedCurrentRoot &&
        (row.relative_path || "") === nextRelativePath &&
        (row.expected_path || null) === nextExpectedPath
      ) {
        continue;
      }

      const conflict = findLibraryConflict.get(resolvedFilePath, row.id) as { id: number } | undefined;
      if (conflict) {
        deleteLibraryFile.run(row.id);
        libraryFilesDeduplicated++;
        continue;
      }

      updateLibraryFile.run(
        resolvedFilePath,
        nextRelativePath,
        currentRoot,
        path.basename(resolvedFilePath),
        path.extname(resolvedFilePath).replace(".", ""),
        nextExpectedPath,
        row.id,
      );
      libraryFilesUpdated++;
    }

    for (const row of unmappedRows) {
      const libraryRootKey = resolveLibraryRootKey(row.library_root, row.file_path);
      if (!libraryRootKey) continue;

      const currentRoot = getCurrentLibraryRootPath(libraryRootKey);
      const resolvedFilePath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
        relativePath: row.relative_path,
      });

      if (!fs.existsSync(resolvedFilePath)) continue;

      const nextRelativePath = path.relative(currentRoot, resolvedFilePath);
      const normalizedCurrentPath = normalizeComparablePath(row.file_path);
      const normalizedResolvedPath = normalizeComparablePath(resolvedFilePath);
      const normalizedStoredRoot = normalizeComparablePath(row.library_root);
      const normalizedCurrentRoot = normalizeComparablePath(currentRoot);

      if (
        normalizedCurrentPath === normalizedResolvedPath &&
        normalizedStoredRoot === normalizedCurrentRoot &&
        (row.relative_path || "") === nextRelativePath
      ) {
        continue;
      }

      const conflict = findUnmappedConflict.get(resolvedFilePath, row.id) as { id: number } | undefined;
      if (conflict) {
        deleteUnmappedFile.run(row.id);
        continue;
      }

      updateUnmappedFile.run(
        resolvedFilePath,
        nextRelativePath,
        currentRoot,
        path.basename(resolvedFilePath),
        path.extname(resolvedFilePath).replace(".", ""),
        row.id,
      );
      unmappedFilesUpdated++;
    }
  })();

  if (libraryFilesUpdated > 0 || libraryFilesDeduplicated > 0 || unmappedFilesUpdated > 0) {
    console.log(
      `[LibraryPaths] Reconciled stored paths: ` +
      `${libraryFilesUpdated} library file(s) updated, ` +
      `${libraryFilesDeduplicated} duplicate stale record(s) removed, ` +
      `${unmappedFilesUpdated} unmapped file(s) updated`,
    );
  }

  return {
    libraryFilesUpdated,
    libraryFilesDeduplicated,
    unmappedFilesUpdated,
  };
}
