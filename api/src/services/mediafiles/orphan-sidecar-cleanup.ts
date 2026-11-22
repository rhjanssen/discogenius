import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, withSqliteWriteGate } from "../../database.js";
import { RequestValidationError } from "../../utils/request-validation.js";
import { SQL_JSON_LIST, jsonList } from "../../utils/sql-id-list.js";
import { CommandNames } from "../commands/command-names.js";
import { Config } from "../config/config.js";
import type { ExtraFileTableName } from "../extras/files/extra-file-service.js";
import { loadArtistMetadataIdentity } from "../music/managed-artists.js";
import { SUPPORTED_IMPORT_EXTENSIONS, extractNamingMbid } from "./import-discovery.js";
import { removeEmptyParents } from "./library-files.js";
import { resolveLibraryRootKey, resolveStoredLibraryPath } from "./library-paths.js";
import { isMediaRewriteTemporaryName } from "./media-file-rewrite.js";
import { normalizeComparablePath, resolvedPathIsInsideRoot, sameDirectoryEntry } from "./path-utils.js";

export const ORPHAN_SIDECAR_EXTENSIONS = new Set([".lrc", ".txt", ".json"]);
export const MAX_PREVIEW_ENTRIES = 5000;

const EXCLUDED_DIRS = new Set([".zfs", ".git", ".vs", ".appledouble", "$recycle.bin", "system volume information", "@eadir"]);
const FOLDER_METADATA_TYPES = new Set(["bio", "review", "nfo"]);
const EXTRA_TABLES: ReadonlyArray<{ name: ExtraFileTableName; typeSql: string }> = [
  { name: "LyricFiles", typeSql: "'lyrics'" },
  { name: "MetadataFiles", typeSql: "file_type" },
  { name: "ExtraFiles", typeSql: "file_type" },
];

export class OrphanSidecarConflictError extends Error {
  override name = "OrphanSidecarConflictError";
}

export type StaleSidecarDbRow = { table: ExtraFileTableName; id: number };
export type OrphanSidecarEntry = {
  filePath: string; relativePath: string; libraryRoot: string; sizeBytes: number; witness: string; staleDbRows: StaleSidecarDbRow[];
};
export type OrphanSidecarPreviewReport = {
  dryRun: true; generatedAt: string; confirmationToken: string; rootsScanned: string[];
  directoriesScanned: number; sidecarsInspected: number; orphanCount: number;
  totalBytes: number; protectedCount: number; scanTruncated: boolean; entries: OrphanSidecarEntry[];
};
export type OrphanSidecarApplyResult = {
  deleted: number; deletedDbRows: number; skippedChanged: number; skippedProtected: number;
  prunedFolders: number; errors: Array<{ filePath: string; error: string }>;
};

type CandidateProbe = { filePath: string; protected: boolean; staleDbRows: StaleSidecarDbRow[] };
type ExtraDbRow = { id: number; file_path: string; relative_path: string | null; library_root: string | null; track_file_id: number | null; file_type: string };
type MediaSibling = { stem: string; fullPath: string };

const defaultYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function lstatKey(targetPath: string, kind: "file" | "dir"): { key: string; sizeBytes: number } | null {
  try {
    const stat = fs.lstatSync(targetPath, { bigint: true });
    if (stat.isSymbolicLink()) return null;
    if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) return null;
    return {
      key: kind === "file" ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}` : `${stat.dev}:${stat.ino}`,
      sizeBytes: Number(stat.size),
    };
  } catch {
    return null;
  }
}

function dirPrefixBounds(directory: string): [string, string] {
  const lower = directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`;
  return [lower, lower.slice(0, -1) + String.fromCharCode(lower.charCodeAt(lower.length - 1) + 1)];
}

export function validateOrphanSidecarArtistScope(artistId?: string): void {
  if (artistId && !loadArtistMetadataIdentity(artistId)) {
    throw new RequestValidationError(`Unknown artistId: ${artistId}`);
  }
}

function resolveScanRoots(libraryRootFilter?: string): string[] {
  const configured = ([
    { key: "music", path: Config.getMusicPath() },
    { key: "spatial", path: Config.getSpatialPath() },
    { key: "videos", path: Config.getVideoPath() },
  ]).filter((e) => Boolean(String(e.path || "").trim())).map((e) => ({ key: e.key, path: path.resolve(e.path) }));

  const filter = String(libraryRootFilter || "").trim();
  const filterKey = filter ? resolveLibraryRootKey(filter, filter) : null;
  const filterLower = filter ? normalizeComparablePath(path.resolve(filter), true) : null;
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const entry of configured) {
    if (filter && filterKey !== entry.key && filterLower !== normalizeComparablePath(entry.path, true)) continue;
    const id = lstatKey(entry.path, "dir")?.key;
    if (id && !seen.has(id)) {
      seen.add(id);
      roots.push(entry.path);
    }
  }
  return roots;
}

function resolveArtistTopFolders(artistId: string, roots: readonly string[]): Set<string> {
  const identity = loadArtistMetadataIdentity(artistId);
  if (!identity) throw new RequestValidationError(`Unknown artistId: ${artistId}`);
  const allowed = new Set<string>();
  const addTop = (raw: string | null | undefined) => {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return;
    const top = path.isAbsolute(trimmed) ? path.basename(trimmed) : trimmed.split(/[\\/]+/).filter(Boolean)[0];
    if (top) allowed.add(top.toLowerCase());
  };
  for (const row of db.prepare("SELECT path FROM LibraryArtists WHERE artist_metadata_id = ?").all(identity.id) as Array<{ path: string | null }>) {
    addTop(row.path);
  }
  if (identity.mbid) {
    for (const row of db.prepare("SELECT DISTINCT relative_path FROM TrackFiles WHERE canonical_artist_mbid = ?").all(identity.mbid) as Array<{ relative_path: string | null }>) {
      addTop(row.relative_path);
    }
    const mbidLower = identity.mbid.toLowerCase();
    for (const root of roots) {
      try {
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.isSymbolicLink() && extractNamingMbid(entry.name)?.toLowerCase() === mbidLower) {
            allowed.add(entry.name.toLowerCase());
          }
        }
      } catch { /* unreadable root skipped during walk */ }
    }
  }
  return allowed;
}

function splitDirectoryEntries(directory: string, dirents: readonly fs.Dirent[], includeSidecars: boolean) {
  const dirs: string[] = [];
  const mediaSiblings: MediaSibling[] = [];
  const mediaStemsLower = new Set<string>();
  const sidecars: Array<{ name: string; fullPath: string; ext: string }> = [];
  for (const entry of dirents) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name.toLowerCase())) dirs.push(entry.name);
      continue;
    }
    if (!entry.isFile() || entry.name.startsWith(".") || isMediaRewriteTemporaryName(entry.name)) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (SUPPORTED_IMPORT_EXTENSIONS.has(ext)) {
      const stem = path.parse(entry.name).name;
      mediaSiblings.push({ stem, fullPath });
      mediaStemsLower.add(stem.toLowerCase());
    } else if (includeSidecars && ORPHAN_SIDECAR_EXTENSIONS.has(ext)) {
      sidecars.push({ name: entry.name, fullPath, ext });
    }
  }
  return { dirs, mediaSiblings, mediaStemsLower, sidecars };
}

function matchesAnyMediaSibling(
  sidecarPath: string,
  sidecarName: string,
  ext: string,
  directory: string,
  mediaSiblings: readonly MediaSibling[],
  mediaStemsLower: ReadonlySet<string>,
): boolean {
  const stemLower = path.parse(sidecarName).name.toLowerCase();
  if (mediaStemsLower.has(stemLower)) return true;
  const isInfoJson = ext === ".json" && stemLower.endsWith(".info");
  if (isInfoJson && mediaStemsLower.has(stemLower.slice(0, -".info".length))) return true;
  return mediaSiblings.some((m) =>
    sameDirectoryEntry(sidecarPath, m.fullPath)
    || sameDirectoryEntry(sidecarPath, path.join(directory, `${m.stem}${ext}`))
    || (isInfoJson && sameDirectoryEntry(sidecarPath, path.join(directory, `${m.stem}.info.json`))),
  );
}

function hasLiveTrackFileOnDisk(trackFileId: number, cache: Map<number, boolean>): boolean {
  const cached = cache.get(trackFileId);
  if (cached !== undefined) return cached;
  const row = db.prepare("SELECT file_path, library_root, relative_path FROM TrackFiles WHERE id = ?")
    .get(trackFileId) as { file_path: string; library_root: string | null; relative_path: string | null } | undefined;
  const live = Boolean(row && fs.existsSync(resolveStoredLibraryPath({
    filePath: row.file_path, libraryRoot: row.library_root, relativePath: row.relative_path,
  })));
  cache.set(trackFileId, live);
  return live;
}

/** Indexed-only DB protection & stale-row check (B-tree exact/prefix/FK lookups, zero table scans). */
function inspectDirectoryDbLinks(
  directory: string,
  mediaSiblingPaths: readonly string[],
  candidates: CandidateProbe[],
  liveTrackCache: Map<number, boolean>,
): void {
  if (candidates.length === 0) return;
  const [dirLo, dirHi] = dirPrefixBounds(directory);

  const trackExact = db.prepare("SELECT id FROM TrackFiles WHERE file_path = ? OR LOWER(REPLACE(file_path, '\\', '/')) = ? LIMIT 1");
  for (const c of candidates) {
    if (trackExact.get(c.filePath, normalizeComparablePath(c.filePath, true))) c.protected = true;
  }

  for (const row of db.prepare("SELECT file_path, relative_path, library_root FROM UnmappedFiles WHERE file_path >= ? AND file_path < ?")
    .all(dirLo, dirHi) as Array<{ file_path: string; relative_path: string | null; library_root: string | null }>) {
    const resolved = resolveStoredLibraryPath({ filePath: row.file_path, libraryRoot: row.library_root, relativePath: row.relative_path });
    for (const c of candidates) if (!c.protected && sameDirectoryEntry(c.filePath, resolved)) c.protected = true;
  }

  const remaining = candidates.filter((c) => !c.protected);
  if (remaining.length === 0) return;

  const siblingTrackIds = mediaSiblingPaths.length === 0 ? [] : (
    db.prepare(`SELECT id FROM TrackFiles WHERE LOWER(REPLACE(file_path, '\\', '/')) IN ${SQL_JSON_LIST}`)
      .all(jsonList(mediaSiblingPaths.map((p) => normalizeComparablePath(p, true)))) as Array<{ id: number }>
  ).map((r) => r.id);

  for (const { name: table, typeSql } of EXTRA_TABLES) {
    const byId = new Map<number, ExtraDbRow>();
    const select = `SELECT id, file_path, relative_path, library_root, track_file_id, ${typeSql} AS file_type FROM ${table}`;
    for (const row of db.prepare(`${select} WHERE file_path >= ? AND file_path < ?`).all(dirLo, dirHi) as ExtraDbRow[]) {
      byId.set(row.id, row);
    }
    if (siblingTrackIds.length > 0) {
      for (const row of db.prepare(`${select} WHERE track_file_id IN ${SQL_JSON_LIST}`).all(jsonList(siblingTrackIds)) as ExtraDbRow[]) {
        byId.set(row.id, row);
      }
    }
    for (const row of byId.values()) {
      const resolved = resolveStoredLibraryPath({ filePath: row.file_path, libraryRoot: row.library_root, relativePath: row.relative_path });
      for (const c of remaining) {
        if (c.protected || !sameDirectoryEntry(c.filePath, resolved)) continue;
        if ((row.track_file_id != null && hasLiveTrackFileOnDisk(row.track_file_id, liveTrackCache))
          || (table === "MetadataFiles" && row.track_file_id == null && FOLDER_METADATA_TYPES.has(String(row.file_type || "").toLowerCase()))) {
          c.protected = true;
        } else {
          c.staleDbRows.push({ table, id: row.id });
        }
      }
    }
  }
}

export function computeOrphanSidecarConfirmationToken(
  entries: ReadonlyArray<Pick<OrphanSidecarEntry, "filePath" | "witness">>,
): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => a.filePath.localeCompare(b.filePath))) {
    hash.update(`${entry.filePath}\0${entry.witness}\n`);
  }
  return hash.digest("hex");
}

export function loadOrphanSidecarPreviewCommand(options: { commandId?: number; requireCompleted?: boolean } = {}) {
  type CmdRow = { id: number; name: string; status: string; progress: number; error: string | null; payload: string };
  const rows: CmdRow[] = options.commandId != null
    ? ([db.prepare("SELECT id, name, status, progress, error, payload FROM commands WHERE id = ?").get(options.commandId)].filter(Boolean) as CmdRow[])
    : (db.prepare("SELECT id, name, status, progress, error, payload FROM commands WHERE name = ? ORDER BY id DESC LIMIT 25")
      .all(CommandNames.CleanupOrphanSidecars) as CmdRow[]);
  for (const row of rows) {
    if (row.name !== CommandNames.CleanupOrphanSidecars) continue;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(row.payload || "{}") as Record<string, unknown>; } catch { continue; }
    if (payload.dryRun !== true) continue;
    if (options.requireCompleted && (row.status !== "completed" || !payload.previewReport)) continue;
    return {
      commandId: row.id,
      status: row.status,
      progress: Number(row.progress || 0),
      description: typeof payload.description === "string" ? payload.description : null,
      error: row.error ?? null,
      report: (payload.previewReport as OrphanSidecarPreviewReport | undefined) ?? null,
    };
  }
  return null;
}

export async function previewOrphanSidecarCleanup(options: {
  libraryRoot?: string;
  artistId?: string;
  maxEntries?: number;
  yieldToEventLoop?: () => Promise<void>;
  onProgress?: (progress: number, description: string) => void;
} = {}): Promise<OrphanSidecarPreviewReport> {
  const yieldFn = options.yieldToEventLoop ?? defaultYield;
  const maxEntries = Math.max(1, Math.min(options.maxEntries ?? MAX_PREVIEW_ENTRIES, MAX_PREVIEW_ENTRIES));
  const roots = resolveScanRoots(options.libraryRoot);
  const allowedTopDirs = options.artistId ? resolveArtistTopFolders(options.artistId, roots) : null;

  const liveTrackCache = new Map<number, boolean>();
  const orphans: OrphanSidecarEntry[] = [];
  let directoriesScanned = 0, sidecarsInspected = 0, protectedCount = 0, totalBytes = 0, scanTruncated = false;

  for (const root of roots) {
    const rootId = lstatKey(root, "dir")?.key;
    if (!rootId) continue;
    const visited = new Set<string>([rootId]);
    const stack = [{ dir: root, depth: 0 }];

    while (stack.length > 0) {
      const { dir, depth } = stack.pop()!;
      if (!resolvedPathIsInsideRoot(dir, root)) continue;
      let dirents: fs.Dirent[];
      try { dirents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
      directoriesScanned += 1;

      const { dirs, mediaSiblings, mediaStemsLower, sidecars } = splitDirectoryEntries(dir, dirents, depth >= 1);
      for (const name of dirs) {
        if (depth === 0 && allowedTopDirs && !allowedTopDirs.has(name.toLowerCase())) continue;
        const child = path.join(dir, name);
        const childId = lstatKey(child, "dir")?.key;
        if (childId && !visited.has(childId)) { visited.add(childId); stack.push({ dir: child, depth: depth + 1 }); }
      }

      if (sidecars.length > 0) {
        const probes: Array<CandidateProbe & { sizeBytes: number; witness: string }> = [];
        for (const s of sidecars) {
          sidecarsInspected += 1;
          if (matchesAnyMediaSibling(s.fullPath, s.name, s.ext, dir, mediaSiblings, mediaStemsLower)) { protectedCount += 1; continue; }
          const stat = lstatKey(s.fullPath, "file");
          if (stat) probes.push({ filePath: s.fullPath, witness: stat.key, sizeBytes: stat.sizeBytes, protected: false, staleDbRows: [] });
        }
        if (probes.length > 0) {
          inspectDirectoryDbLinks(dir, mediaSiblings.map((m) => m.fullPath), probes, liveTrackCache);
          for (const p of probes) {
            if (p.protected) { protectedCount += 1; continue; }
            if (orphans.length >= maxEntries) { scanTruncated = true; continue; }
            totalBytes += p.sizeBytes;
            orphans.push({
              filePath: p.filePath, relativePath: path.relative(root, p.filePath), libraryRoot: root,
              sizeBytes: p.sizeBytes, witness: p.witness, staleDbRows: p.staleDbRows,
            });
          }
        }
      }
      if (directoriesScanned % 25 === 0) {
        options.onProgress?.(50, `Scanned ${directoriesScanned} folders (${orphans.length} orphan sidecar(s) found)`);
        await yieldFn();
      }
    }
  }

  orphans.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return {
    dryRun: true, generatedAt: new Date().toISOString(),
    confirmationToken: computeOrphanSidecarConfirmationToken(orphans),
    rootsScanned: roots, directoriesScanned, sidecarsInspected,
    orphanCount: orphans.length, totalBytes, protectedCount, scanTruncated, entries: orphans,
  };
}

export async function applyOrphanSidecarCleanup(options: {
  confirm: boolean;
  confirmationToken: string;
  preview: OrphanSidecarPreviewReport;
  pruneEmptyFolders?: boolean;
  filePaths?: string[];
  yieldToEventLoop?: () => Promise<void>;
  onProgress?: (progress: number, description: string) => void;
}): Promise<OrphanSidecarApplyResult> {
  if (options.confirm !== true) throw new RequestValidationError("Explicit confirm: true is required after running dry-run preview");
  const token = String(options.confirmationToken || "").trim();
  if (!token) throw new RequestValidationError("confirmationToken from the dry-run preview is required");
  if (options.preview.confirmationToken !== token || computeOrphanSidecarConfirmationToken(options.preview.entries) !== token) {
    throw new OrphanSidecarConflictError("Confirmation token does not match the dry-run preview; run preview again before applying");
  }

  let selected = options.preview.entries;
  if (options.filePaths !== undefined) {
    if (!Array.isArray(options.filePaths) || options.filePaths.length === 0) {
      throw new RequestValidationError("filePaths must be a non-empty array when provided");
    }
    const byPath = new Map(options.preview.entries.map((e) => [path.resolve(e.filePath), e]));
    const picked = new Map<string, OrphanSidecarEntry>();
    for (const rawPath of options.filePaths) {
      const match = byPath.get(path.resolve(String(rawPath || "")));
      if (!match) throw new OrphanSidecarConflictError(`Requested path is not an eligible orphan sidecar in the confirmed preview: ${rawPath}`);
      picked.set(match.filePath, match);
    }
    selected = [...picked.values()];
  }

  const yieldFn = options.yieldToEventLoop ?? defaultYield;
  const liveTrackCache = new Map<number, boolean>();
  const result: OrphanSidecarApplyResult = {
    deleted: 0, deletedDbRows: 0, skippedChanged: 0, skippedProtected: 0, prunedFolders: 0, errors: [],
  };

  for (let i = 0; i < selected.length; i += 1) {
    const entry = selected[i];
    if (lstatKey(entry.filePath, "file")?.key !== entry.witness) { result.skippedChanged += 1; continue; }
    if (!resolvedPathIsInsideRoot(entry.filePath, entry.libraryRoot)) { result.skippedProtected += 1; continue; }

    const dir = path.dirname(entry.filePath);
    let dirents: fs.Dirent[];
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { result.skippedChanged += 1; continue; }
    const { mediaSiblings, mediaStemsLower } = splitDirectoryEntries(dir, dirents, false);
    const name = path.basename(entry.filePath);
    if (matchesAnyMediaSibling(entry.filePath, name, path.extname(name).toLowerCase(), dir, mediaSiblings, mediaStemsLower)) {
      result.skippedProtected += 1;
      continue;
    }

    const probe: CandidateProbe = { filePath: entry.filePath, protected: false, staleDbRows: [] };
    inspectDirectoryDbLinks(dir, mediaSiblings.map((m) => m.fullPath), [probe], liveTrackCache);
    if (probe.protected) { result.skippedProtected += 1; continue; }

    const staleRows = new Map([...entry.staleDbRows, ...probe.staleDbRows].map((s) => [`${s.table}:${s.id}`, s]));
    try {
      fs.rmSync(entry.filePath, { force: true });
      result.deleted += 1;
      if (staleRows.size > 0) {
        result.deletedDbRows += await withSqliteWriteGate(() => db.transaction(() => {
          let removed = 0;
          for (const stale of staleRows.values()) {
            removed += db.prepare(`DELETE FROM ${stale.table} WHERE id = ? AND (track_file_id IS NULL OR track_file_id NOT IN (SELECT id FROM TrackFiles))`).run(stale.id).changes;
          }
          return removed;
        })(), "cleanup:orphan-sidecar-db");
      }
      if (options.pruneEmptyFolders === true) result.prunedFolders += removeEmptyParents(dir, entry.libraryRoot);
    } catch (error) {
      result.errors.push({ filePath: entry.filePath, error: error instanceof Error ? error.message : String(error) });
    }
    options.onProgress?.(Math.round(((i + 1) / selected.length) * 100), `Removed ${result.deleted}/${selected.length} orphan sidecar(s)`);
    await yieldFn();
  }
  return result;
}
