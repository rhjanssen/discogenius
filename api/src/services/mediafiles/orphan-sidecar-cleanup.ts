import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, withSqliteWriteGate } from "../../database.js";
import { RequestValidationError } from "../../utils/request-validation.js";
import { Config } from "../config/config.js";
import type { library_root } from "../config/naming.js";
import type { ExtraFileTableName } from "../extras/files/extra-file-service.js";
import { loadArtistMetadataIdentity } from "../music/managed-artists.js";
import { SUPPORTED_IMPORT_EXTENSIONS, extractNamingMbid } from "./import-discovery.js";
import { removeEmptyParents } from "./library-files.js";
import {
  getCurrentLibraryRootPath,
  resolveLibraryRootKey,
  resolveStoredLibraryPath,
} from "./library-paths.js";
import { isMediaRewriteTemporaryName } from "./media-file-rewrite.js";
import {
  fileContentWitness,
  isCaseInsensitivePath,
  isSameFile,
  normalizeComparablePath,
  resolvedPathIsInsideRoot,
} from "./path-utils.js";

export const ORPHAN_SIDECAR_EXTENSIONS = new Set([".lrc", ".txt", ".json"]);

const EXCLUDED_DIRECTORIES = new Set([
  ".zfs",
  ".git",
  ".vs",
  ".appledouble",
  "$recycle.bin",
  "system volume information",
  "@eadir",
]);

const FOLDER_LEVEL_PROTECTED_METADATA_TYPES = new Set(["bio", "review", "nfo"]);
const DB_SCAN_CHUNK_SIZE = 2000;

export class OrphanSidecarConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrphanSidecarConflictError";
  }
}

export type StaleSidecarDbRow = {
  table: ExtraFileTableName;
  id: number;
  filePath: string;
};

export type OrphanSidecarEntry = {
  filePath: string;
  relativePath: string;
  libraryRoot: string;
  libraryRootKey: library_root | null;
  extension: ".lrc" | ".txt" | ".json";
  sizeBytes: number;
  witness: string;
  reason: "orphan_sidecar_no_matching_media";
  staleDbRows: StaleSidecarDbRow[];
};

export type OrphanSidecarRootInfo = {
  key: library_root;
  path: string;
  caseInsensitive: boolean;
};

export type OrphanSidecarScanOptions = {
  libraryRoot?: string;
  artistId?: string;
  limit?: number;
  yieldToEventLoop?: () => Promise<void>;
};

export type OrphanSidecarPreviewReport = {
  dryRun: true;
  generatedAt: string;
  confirmationToken: string;
  rootsScanned: OrphanSidecarRootInfo[];
  directoriesScanned: number;
  sidecarsInspected: number;
  orphanCount: number;
  totalBytes: number;
  protectedCount: number;
  entries: OrphanSidecarEntry[];
  truncated: boolean;
};

export type OrphanSidecarApplyOptions = {
  confirm: boolean;
  confirmationToken: string;
  libraryRoot?: string;
  artistId?: string;
  pruneEmptyFolders?: boolean;
  filePaths?: string[];
  yieldToEventLoop?: () => Promise<void>;
  onProgress?: (progress: number, description: string) => void;
};

export type OrphanSidecarApplyResult = {
  deleted: number;
  deletedDbRows: number;
  skippedChanged: number;
  skippedProtected: number;
  prunedFolders: number;
  errors: Array<{ filePath: string; error: string }>;
  deletedPaths: string[];
};

type DiskCandidate = {
  filePath: string;
  relativePath: string;
  directory: string;
  dirLower: string;
  relativeDirLower: string;
  libraryRoot: string;
  libraryRootKey: library_root;
  extension: ".lrc" | ".txt" | ".json";
  sizeBytes: number;
  witness: string;
  protected: boolean;
  staleDbRows: StaleSidecarDbRow[];
};

type MediaSibling = {
  name: string;
  stem: string;
  stemLower: string;
  fullPath: string;
};

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function normalizeDirLower(dirPath: string): string {
  return normalizeComparablePath(dirPath, true);
}

function dirIdentityKey(dirPath: string): string | null {
  try {
    const stat = fs.lstatSync(dirPath, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

function resolveScanRoots(libraryRootFilter?: string): OrphanSidecarRootInfo[] {
  const configured: Array<{ key: library_root; path: string }> = ([
    { key: "music" as const, path: Config.getMusicPath() },
    { key: "spatial" as const, path: Config.getSpatialPath() },
    { key: "videos" as const, path: Config.getVideoPath() },
  ])
    .filter((entry) => Boolean(String(entry.path || "").trim()))
    .map((entry) => ({ key: entry.key, path: path.resolve(entry.path) }));

  const trimmedFilter = String(libraryRootFilter || "").trim();
  const filterKey = trimmedFilter ? resolveLibraryRootKey(trimmedFilter, trimmedFilter) : null;
  const filterLower = trimmedFilter ? normalizeDirLower(path.resolve(trimmedFilter)) : null;

  const seenDirKeys = new Set<string>();
  const roots: OrphanSidecarRootInfo[] = [];

  for (const entry of configured) {
    if (trimmedFilter) {
      const matchesKey = filterKey === entry.key;
      const matchesPath = filterLower === normalizeDirLower(entry.path);
      if (!matchesKey && !matchesPath) continue;
    }
    const identity = dirIdentityKey(entry.path);
    if (!identity || seenDirKeys.has(identity)) continue;
    seenDirKeys.add(identity);
    roots.push({
      key: entry.key,
      path: entry.path,
      caseInsensitive: isCaseInsensitivePath(entry.path),
    });
  }

  return roots;
}

function resolveArtistTopFolders(artistId: string, roots: readonly OrphanSidecarRootInfo[]): Set<string> | null {
  const identity = loadArtistMetadataIdentity(artistId);
  if (!identity) {
    throw new RequestValidationError(`Unknown artistId: ${artistId}`);
  }
  const allowedTopDirsLower = new Set<string>();
  const artistMbidLower = identity.mbid ? identity.mbid.toLowerCase() : null;

  const membershipRows = db.prepare(`
    SELECT path
    FROM LibraryArtists
    WHERE artist_metadata_id = ? AND path IS NOT NULL AND TRIM(path) != ''
  `).all(identity.id) as Array<{ path: string }>;

  for (const row of membershipRows) {
    const raw = String(row.path || "").trim();
    if (!raw) continue;
    const base = path.isAbsolute(raw) ? path.basename(raw) : raw.split(/[\\/]+/)[0];
    if (base) allowedTopDirsLower.add(base.toLowerCase());
  }

  const trackRows = db.prepare(`
    SELECT DISTINCT relative_path
    FROM TrackFiles
    WHERE artist_metadata_id = ? AND relative_path IS NOT NULL AND TRIM(relative_path) != ''
  `).all(identity.id) as Array<{ relative_path: string }>;

  for (const row of trackRows) {
    const first = String(row.relative_path || "").split(/[\\/]+/).filter(Boolean)[0];
    if (first) allowedTopDirsLower.add(first.toLowerCase());
  }

  if (artistMbidLower) {
    for (const root of roots) {
      try {
        for (const entry of fs.readdirSync(root.path, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const folderMbid = extractNamingMbid(entry.name);
          if (folderMbid && folderMbid.toLowerCase() === artistMbidLower) {
            allowedTopDirsLower.add(entry.name.toLowerCase());
          }
        }
      } catch {
        // Unreadable root is handled during the walk.
      }
    }
  }

  return allowedTopDirsLower;
}

/**
 * Check whether a sidecar file belongs to any media sibling in its directory.
 *
 * Uses both case-insensitive stem comparison (matching live ZFS
 * `casesensitivity=insensitive, normalization=none`) and kernel inode/dev
 * comparison (`isSameFile`) against every media file's expected sidecar path.
 */
function matchesAnyMediaSibling(
  sidecarPath: string,
  sidecarName: string,
  ext: ".lrc" | ".txt" | ".json",
  directory: string,
  mediaSiblings: readonly MediaSibling[],
  mediaStemsLower: ReadonlySet<string>,
): boolean {
  const stem = path.parse(sidecarName).name;
  const stemLower = stem.toLowerCase();
  if (mediaStemsLower.has(stemLower)) return true;

  // yt-dlp / metadata sidecars use `<stem>.info.json` next to `<stem>.<ext>`.
  const isInfoJson = ext === ".json" && stemLower.endsWith(".info");
  const infoStemLower = isInfoJson ? stemLower.slice(0, -".info".length) : null;
  if (infoStemLower && mediaStemsLower.has(infoStemLower)) return true;

  for (const media of mediaSiblings) {
    if (isSameFile(sidecarPath, media.fullPath)) return true;
    if (isSameFile(sidecarPath, path.join(directory, `${media.stem}${ext}`))) return true;
    if (isInfoJson && isSameFile(sidecarPath, path.join(directory, `${media.stem}.info.json`))) return true;
  }

  return false;
}

function readDirectoryMediaSiblings(directory: string): {
  mediaSiblings: MediaSibling[];
  mediaStemsLower: Set<string>;
} {
  const mediaSiblings: MediaSibling[] = [];
  const mediaStemsLower = new Set<string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return { mediaSiblings, mediaStemsLower };
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    if (entry.name.startsWith(".") || isMediaRewriteTemporaryName(entry.name)) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!SUPPORTED_IMPORT_EXTENSIONS.has(ext)) continue;
    const stem = path.parse(entry.name).name;
    const stemLower = stem.toLowerCase();
    mediaSiblings.push({
      name: entry.name,
      stem,
      stemLower,
      fullPath: path.join(directory, entry.name),
    });
    mediaStemsLower.add(stemLower);
  }
  return { mediaSiblings, mediaStemsLower };
}

function hasLiveTrackFileOnDisk(trackFileId: number, cache: Map<number, boolean>): boolean {
  const cached = cache.get(trackFileId);
  if (cached !== undefined) return cached;
  const row = db.prepare(`
    SELECT file_path, library_root, relative_path
    FROM TrackFiles
    WHERE id = ?
  `).get(trackFileId) as { file_path: string; library_root: string | null; relative_path: string | null } | undefined;
  const live = Boolean(
    row && fs.existsSync(resolveStoredLibraryPath({
      filePath: row.file_path,
      libraryRoot: row.library_root,
      relativePath: row.relative_path,
    })),
  );
  cache.set(trackFileId, live);
  return live;
}

function rowCandidateDirKeys(row: {
  file_path: string;
  library_root: string | null;
  relative_path: string | null;
}): string[] {
  const keys = new Set<string>();
  if (row.file_path) {
    const dir = normalizeDirLower(path.dirname(row.file_path));
    if (dir && dir !== ".") {
      keys.add(dir);
      const leaf = path.posix.basename(dir);
      if (leaf && leaf !== ".") keys.add(`leaf:${leaf}`);
    }
  }
  if (row.relative_path) {
    const relDir = normalizeDirLower(path.dirname(row.relative_path));
    if (relDir && relDir !== ".") {
      keys.add(relDir);
      const leaf = path.posix.basename(relDir);
      if (leaf && leaf !== ".") keys.add(`leaf:${leaf}`);
    }
    const rootKey = resolveLibraryRootKey(row.library_root, row.file_path);
    if (rootKey) {
      const currentRoot = getCurrentLibraryRootPath(rootKey);
      if (currentRoot) {
        keys.add(normalizeDirLower(path.dirname(path.join(currentRoot, row.relative_path))));
      }
    }
  }
  return [...keys];
}

async function reconcileCandidatesAgainstDatabase(
  candidates: DiskCandidate[],
  yieldFn: () => Promise<void>,
): Promise<void> {
  if (candidates.length === 0) return;

  const byDirKey = new Map<string, DiskCandidate[]>();
  const addIndex = (key: string, candidate: DiskCandidate) => {
    if (!key) return;
    const list = byDirKey.get(key) ?? [];
    list.push(candidate);
    byDirKey.set(key, list);
  };
  for (const candidate of candidates) {
    addIndex(candidate.dirLower, candidate);
    const leaf = path.posix.basename(candidate.dirLower);
    if (leaf && leaf !== ".") {
      addIndex(`leaf:${leaf}`, candidate);
    }
    if (candidate.relativeDirLower && candidate.relativeDirLower !== ".") {
      addIndex(candidate.relativeDirLower, candidate);
    }
  }

  const matchedCandidatesForRow = (row: {
    file_path: string;
    library_root: string | null;
    relative_path: string | null;
  }): DiskCandidate[] => {
    const unique = new Set<DiskCandidate>();
    for (const key of rowCandidateDirKeys(row)) {
      const bucket = byDirKey.get(key);
      if (!bucket) continue;
      for (const candidate of bucket) {
        if (!candidate.protected) unique.add(candidate);
      }
    }
    return [...unique];
  };

  // Protect anything that shares an inode with TrackFiles or UnmappedFiles.
  for (const table of ["TrackFiles", "UnmappedFiles"] as const) {
    let cursor = 0;
    while (true) {
      const rows = db.prepare(`
        SELECT id, file_path, relative_path, library_root
        FROM ${table}
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ?
      `).all(cursor, DB_SCAN_CHUNK_SIZE) as Array<{
        id: number;
        file_path: string;
        relative_path: string | null;
        library_root: string | null;
      }>;
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;

      for (const row of rows) {
        const nearby = matchedCandidatesForRow(row);
        if (nearby.length === 0) continue;
        const resolved = resolveStoredLibraryPath({
          filePath: row.file_path,
          libraryRoot: row.library_root,
          relativePath: row.relative_path,
        });
        for (const candidate of nearby) {
          if (isSameFile(candidate.filePath, resolved)) {
            candidate.protected = true;
          }
        }
      }
      await yieldFn();
    }
  }

  const liveTrackCache = new Map<number, boolean>();
  const extraTables: Array<{ name: ExtraFileTableName; hasFileType: boolean }> = [
    { name: "LyricFiles", hasFileType: false },
    { name: "MetadataFiles", hasFileType: true },
    { name: "ExtraFiles", hasFileType: true },
  ];

  for (const { name: table, hasFileType } of extraTables) {
    let cursor = 0;
    while (true) {
      const rows = db.prepare(`
        SELECT id, file_path, relative_path, library_root, track_file_id,
               ${hasFileType ? "file_type" : "'lyrics' AS file_type"}
        FROM ${table}
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ?
      `).all(cursor, DB_SCAN_CHUNK_SIZE) as Array<{
        id: number;
        file_path: string;
        relative_path: string | null;
        library_root: string | null;
        track_file_id: number | null;
        file_type: string;
      }>;
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;

      for (const row of rows) {
        const nearby = matchedCandidatesForRow(row);
        if (nearby.length === 0) continue;
        const resolved = resolveStoredLibraryPath({
          filePath: row.file_path,
          libraryRoot: row.library_root,
          relativePath: row.relative_path,
        });
        for (const candidate of nearby) {
          if (!isSameFile(candidate.filePath, resolved)) continue;

          if (row.track_file_id != null && hasLiveTrackFileOnDisk(row.track_file_id, liveTrackCache)) {
            candidate.protected = true;
            continue;
          }
          if (
            table === "MetadataFiles"
            && row.track_file_id == null
            && FOLDER_LEVEL_PROTECTED_METADATA_TYPES.has(String(row.file_type || "").toLowerCase())
          ) {
            candidate.protected = true;
            continue;
          }
          candidate.staleDbRows.push({ table, id: row.id, filePath: row.file_path });
        }
      }
      await yieldFn();
    }
  }
}

export function computeOrphanSidecarConfirmationToken(
  entries: ReadonlyArray<Pick<OrphanSidecarEntry, "filePath" | "witness">>,
): string {
  const hash = createHash("sha256");
  const sorted = [...entries].sort((left, right) => left.filePath.localeCompare(right.filePath));
  for (const entry of sorted) {
    hash.update(`${entry.filePath}\0${entry.witness}\n`);
  }
  return hash.digest("hex");
}

/**
 * Dry-run scan for orphan `.lrc`/`.txt`/`.json` sidecars across library roots.
 *
 * Deletes nothing. Produces an exact list of orphan sidecars (stem has no
 * audio/video file in the folder under case-insensitive + inode/dev comparison,
 * and no `LyricFiles`/`MetadataFiles`/`ExtraFiles` row points at a live track)
 * plus a confirmation token required by `applyOrphanSidecarCleanup`.
 */
export async function previewOrphanSidecarCleanup(
  options: OrphanSidecarScanOptions = {},
): Promise<OrphanSidecarPreviewReport> {
  const yieldFn = options.yieldToEventLoop ?? defaultYield;
  const roots = resolveScanRoots(options.libraryRoot);
  const allowedTopDirsLower = options.artistId
    ? resolveArtistTopFolders(options.artistId, roots)
    : null;

  const diskCandidates: DiskCandidate[] = [];
  let directoriesScanned = 0;
  let sidecarsInspected = 0;
  let protectedCount = 0;

  for (const root of roots) {
    const rootIdentity = dirIdentityKey(root.path);
    if (!rootIdentity) continue;
    const visitedDirs = new Set<string>([rootIdentity]);
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root.path, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.pop()!;
      if (!resolvedPathIsInsideRoot(current.dir, root.path)) continue;

      let dirents: fs.Dirent[];
      try {
        dirents = await fs.promises.readdir(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      directoriesScanned += 1;

      const mediaSiblings: MediaSibling[] = [];
      const mediaStemsLower = new Set<string>();
      const sidecarsInDir: Array<{ name: string; fullPath: string; ext: ".lrc" | ".txt" | ".json" }> = [];

      for (const entry of dirents) {
        if (entry.isSymbolicLink()) continue;
        const fullPath = path.join(current.dir, entry.name);

        if (entry.isDirectory()) {
          if (EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
          if (current.depth === 0 && allowedTopDirsLower && !allowedTopDirsLower.has(entry.name.toLowerCase())) {
            continue;
          }
          const childKey = dirIdentityKey(fullPath);
          if (!childKey || visitedDirs.has(childKey)) continue;
          visitedDirs.add(childKey);
          queue.push({ dir: fullPath, depth: current.depth + 1 });
          continue;
        }

        if (!entry.isFile()) continue;
        if (entry.name.startsWith(".") || isMediaRewriteTemporaryName(entry.name)) continue;

        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_IMPORT_EXTENSIONS.has(ext)) {
          const stem = path.parse(entry.name).name;
          const stemLower = stem.toLowerCase();
          mediaSiblings.push({ name: entry.name, stem, stemLower, fullPath });
          mediaStemsLower.add(stemLower);
        } else if (current.depth >= 1 && ORPHAN_SIDECAR_EXTENSIONS.has(ext)) {
          sidecarsInDir.push({
            name: entry.name,
            fullPath,
            ext: ext as ".lrc" | ".txt" | ".json",
          });
        }
      }

      if (sidecarsInDir.length > 0) {
        const dirLower = normalizeDirLower(current.dir);
        const relativeDir = path.relative(root.path, current.dir);
        const relativeDirLower = normalizeDirLower(relativeDir);

        for (const sidecar of sidecarsInDir) {
          sidecarsInspected += 1;
          if (matchesAnyMediaSibling(
            sidecar.fullPath,
            sidecar.name,
            sidecar.ext,
            current.dir,
            mediaSiblings,
            mediaStemsLower,
          )) {
            protectedCount += 1;
            continue;
          }

          const witness = fileContentWitness(sidecar.fullPath);
          if (!witness) continue;
          let sizeBytes = 0;
          try {
            sizeBytes = fs.lstatSync(sidecar.fullPath).size;
          } catch {
            continue;
          }

          diskCandidates.push({
            filePath: sidecar.fullPath,
            relativePath: path.relative(root.path, sidecar.fullPath),
            directory: current.dir,
            dirLower,
            relativeDirLower,
            libraryRoot: root.path,
            libraryRootKey: root.key,
            extension: sidecar.ext,
            sizeBytes,
            witness,
            protected: false,
            staleDbRows: [],
          });
        }
      }

      if (directoriesScanned % 25 === 0) {
        await yieldFn();
      }
    }
  }

  await reconcileCandidatesAgainstDatabase(diskCandidates, yieldFn);

  const orphans: OrphanSidecarEntry[] = [];
  let totalBytes = 0;
  for (const candidate of diskCandidates) {
    if (candidate.protected) {
      protectedCount += 1;
      continue;
    }
    totalBytes += candidate.sizeBytes;
    orphans.push({
      filePath: candidate.filePath,
      relativePath: candidate.relativePath,
      libraryRoot: candidate.libraryRoot,
      libraryRootKey: candidate.libraryRootKey,
      extension: candidate.extension,
      sizeBytes: candidate.sizeBytes,
      witness: candidate.witness,
      reason: "orphan_sidecar_no_matching_media",
      staleDbRows: candidate.staleDbRows,
    });
  }

  orphans.sort((left, right) => left.filePath.localeCompare(right.filePath));
  const confirmationToken = computeOrphanSidecarConfirmationToken(orphans);
  const limit = options.limit;
  const truncated = limit != null && orphans.length > limit;
  const entries = limit != null ? orphans.slice(0, limit) : orphans;

  return {
    dryRun: true,
    generatedAt: new Date().toISOString(),
    confirmationToken,
    rootsScanned: roots,
    directoriesScanned,
    sidecarsInspected,
    orphanCount: orphans.length,
    totalBytes,
    protectedCount,
    entries,
    truncated,
  };
}

function isProtectedInDbNow(filePath: string, libraryRoot: string): boolean {
  const dirLower = normalizeDirLower(path.dirname(filePath));
  const relDirLower = normalizeDirLower(path.dirname(path.relative(libraryRoot, filePath)));
  const leafLower = path.posix.basename(dirLower);
  const targets = new Set([
    dirLower,
    relDirLower,
    leafLower && leafLower !== "." ? `leaf:${leafLower}` : "",
  ].filter((value) => value && value !== "."));
  const dirLike = `${dirLower.replace(/([\\%_])/g, "\\$1")}/%`;
  const hasRelDir = Boolean(relDirLower && relDirLower !== ".");
  const relLike = hasRelDir ? `${relDirLower.replace(/([\\%_])/g, "\\$1")}/%` : "";
  const relSuffixLike = hasRelDir ? `%/${relDirLower.replace(/([\\%_])/g, "\\$1")}/%` : "";
  const whereClause = hasRelDir
    ? "(LOWER(REPLACE(file_path, '\\', '/')) LIKE ? ESCAPE '\\' OR LOWER(REPLACE(file_path, '\\', '/')) LIKE ? ESCAPE '\\' OR LOWER(REPLACE(relative_path, '\\', '/')) LIKE ? ESCAPE '\\')"
    : "LOWER(REPLACE(file_path, '\\', '/')) LIKE ? ESCAPE '\\'";
  const whereArgs = hasRelDir ? [dirLike, relSuffixLike, relLike] : [dirLike];

  for (const table of ["TrackFiles", "UnmappedFiles"] as const) {
    const rows = db.prepare(`
      SELECT file_path, relative_path, library_root
      FROM ${table}
      WHERE ${whereClause}
    `).all(...whereArgs) as Array<{
      file_path: string;
      relative_path: string | null;
      library_root: string | null;
    }>;
    for (const row of rows) {
      const resolved = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
        relativePath: row.relative_path,
      });
      if (isSameFile(filePath, resolved)) return true;
    }
  }

  const liveTrackCache = new Map<number, boolean>();
  for (const { name: table, hasFileType } of [
    { name: "LyricFiles" as const, hasFileType: false },
    { name: "MetadataFiles" as const, hasFileType: true },
    { name: "ExtraFiles" as const, hasFileType: true },
  ]) {
    const rows = db.prepare(`
      SELECT id, file_path, relative_path, library_root, track_file_id,
             ${hasFileType ? "file_type" : "'lyrics' AS file_type"}
      FROM ${table}
      WHERE ${whereClause}
    `).all(...whereArgs) as Array<{
      id: number;
      file_path: string;
      relative_path: string | null;
      library_root: string | null;
      track_file_id: number | null;
      file_type: string;
    }>;
    for (const row of rows) {
      if (!rowCandidateDirKeys(row).some((key) => targets.has(key))) continue;
      const resolved = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
        relativePath: row.relative_path,
      });
      if (!isSameFile(filePath, resolved)) continue;
      if (row.track_file_id != null && hasLiveTrackFileOnDisk(row.track_file_id, liveTrackCache)) {
        return true;
      }
      if (
        table === "MetadataFiles"
        && row.track_file_id == null
        && FOLDER_LEVEL_PROTECTED_METADATA_TYPES.has(String(row.file_type || "").toLowerCase())
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Remove orphan sidecars previously reviewed via `previewOrphanSidecarCleanup`.
 *
 * Requires explicit `confirm: true` and the exact `confirmationToken` from the
 * dry-run preview. Fails closed if the candidate set or any file changed since
 * the preview, and re-checks both sibling stems and live-track DB links right
 * before unlinking.
 */
export async function applyOrphanSidecarCleanup(
  options: OrphanSidecarApplyOptions,
): Promise<OrphanSidecarApplyResult> {
  if (options.confirm !== true) {
    throw new RequestValidationError("Explicit confirm: true is required after running dry-run preview");
  }
  const token = String(options.confirmationToken || "").trim();
  if (!token) {
    throw new RequestValidationError("confirmationToken from the dry-run preview is required");
  }

  const yieldFn = options.yieldToEventLoop ?? defaultYield;
  const current = await previewOrphanSidecarCleanup({
    libraryRoot: options.libraryRoot,
    artistId: options.artistId,
    yieldToEventLoop: yieldFn,
  });

  if (current.confirmationToken !== token) {
    throw new OrphanSidecarConflictError(
      "Orphan sidecar list changed since dry-run preview; run preview again before applying",
    );
  }

  let selected = current.entries;
  if (options.filePaths !== undefined) {
    if (!Array.isArray(options.filePaths) || options.filePaths.length === 0) {
      throw new RequestValidationError("filePaths must be a non-empty array when provided");
    }
    const byPath = new Map(current.entries.map((entry) => [path.resolve(entry.filePath), entry]));
    const picked: OrphanSidecarEntry[] = [];
    const seen = new Set<string>();
    for (const rawPath of options.filePaths) {
      const resolved = path.resolve(String(rawPath || ""));
      const match = byPath.get(resolved);
      if (!match) {
        throw new OrphanSidecarConflictError(
          `Requested path is not an eligible orphan sidecar in the confirmed preview: ${rawPath}`,
        );
      }
      if (!seen.has(match.filePath)) {
        seen.add(match.filePath);
        picked.push(match);
      }
    }
    selected = picked;
  }

  const result: OrphanSidecarApplyResult = {
    deleted: 0,
    deletedDbRows: 0,
    skippedChanged: 0,
    skippedProtected: 0,
    prunedFolders: 0,
    errors: [],
    deletedPaths: [],
  };

  for (let index = 0; index < selected.length; index += 1) {
    const entry = selected[index];
    const currentWitness = fileContentWitness(entry.filePath);
    if (!currentWitness || currentWitness !== entry.witness) {
      result.skippedChanged += 1;
      continue;
    }
    if (!resolvedPathIsInsideRoot(entry.filePath, entry.libraryRoot)) {
      result.skippedProtected += 1;
      continue;
    }

    const directory = path.dirname(entry.filePath);
    const { mediaSiblings, mediaStemsLower } = readDirectoryMediaSiblings(directory);
    if (matchesAnyMediaSibling(
      entry.filePath,
      path.basename(entry.filePath),
      entry.extension,
      directory,
      mediaSiblings,
      mediaStemsLower,
    )) {
      result.skippedProtected += 1;
      continue;
    }

    if (isProtectedInDbNow(entry.filePath, entry.libraryRoot)) {
      result.skippedProtected += 1;
      continue;
    }

    try {
      fs.rmSync(entry.filePath, { force: true });
      result.deleted += 1;
      result.deletedPaths.push(entry.filePath);

      if (entry.staleDbRows.length > 0) {
        const removedRows = await withSqliteWriteGate(() => db.transaction(() => {
          let removed = 0;
          for (const stale of entry.staleDbRows) {
            const deleted = db.prepare(`
              DELETE FROM ${stale.table}
              WHERE id = ?
                AND (
                  track_file_id IS NULL
                  OR track_file_id NOT IN (SELECT id FROM TrackFiles)
                )
            `).run(stale.id);
            removed += deleted.changes;
          }
          return removed;
        })(), "cleanup:orphan-sidecar-db");
        result.deletedDbRows += removedRows;
      }

      if (options.pruneEmptyFolders === true) {
        result.prunedFolders += removeEmptyParents(directory, entry.libraryRoot);
      }
    } catch (error) {
      result.errors.push({
        filePath: entry.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    options.onProgress?.(
      Math.round(((index + 1) / selected.length) * 100),
      `Removed ${result.deleted}/${selected.length} orphan sidecar(s)`,
    );
    await yieldFn();
  }

  return result;
}
