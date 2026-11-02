import fs from "node:fs";
import path from "node:path";
import { ioPermitIsHeld, withAlbumFolder, withHddIoPermit, type DiskAdmissionMeta } from "../commands/disk-admission.js";
import { getConfigSection } from "../config/config.js";
import { prepareEmbeddedAudioCover } from "./audioUtils.js";
import { resolveStoredLibraryPath } from "./library-paths.js";

/** Enough of a retag row to find the album cover without a second query. */
export type AlbumCoverRow = {
  id: number;
  file_path: string;
  relative_path: string | null;
  library_root: string | null;
  canonical_release_mbid: string | null;
  canonical_release_group_mbid: string | null;
  album_mb_release_group_id: string | null;
};

export type AlbumCoverRepairContext = {
  temporaryDirectories: string[];
  warnings: string[];
  /** Preview must not delete or refetch. Apply and retag sessions repair. */
  repair: boolean;
};

const repairMeta: DiskAdmissionMeta = {
  role: "retag",
  commandId: 0,
  reason: "replace unreadable album cover",
};

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    if (!candidate) continue;
    let key = candidate;
    try { key = fs.realpathSync(candidate); } catch { /* keep the requested path */ }
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function coverFailureReason(error: unknown): string {
  const err = error as { stderr?: unknown; message?: string };
  const stderr = Buffer.isBuffer(err?.stderr) ? err.stderr.toString("utf8") : String(err?.stderr || "");
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  const detail = lines.find((line) => /invalid|error|bits/i.test(line)) || lines.at(-1);
  if (detail) return detail.slice(0, 240);
  const message = error instanceof Error ? error.message : "unreadable image";
  if (/readable JPEG or PNG/i.test(message)) return "not a readable JPEG or PNG";
  const tail = message.split("\n").map((line) => line.trim()).filter(Boolean).pop() || message;
  return tail.slice(0, 240);
}

function albumDirectory(row: AlbumCoverRow): string | null {
  if (!row.file_path) return null;
  try {
    const resolved = resolveStoredLibraryPath({
      filePath: row.file_path,
      libraryRoot: row.library_root,
      relativePath: row.relative_path,
    });
    return resolved ? path.dirname(resolved) : null;
  } catch {
    return null;
  }
}

function sidecarPath(row: AlbumCoverRow): string | null {
  const directory = albumDirectory(row);
  if (!directory) return null;
  const name = getConfigSection("metadata").album_cover_name || "cover.jpg";
  return path.join(directory, name);
}

async function tryPrepare(
  mediaPath: string,
  coverPath: string,
  temporaryDirectories: string[],
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  try {
    const prepared = await prepareEmbeddedAudioCover(
      mediaPath,
      coverPath,
      temporaryDirectories,
      getConfigSection("metadata").album_cover_resolution,
    );
    return { ok: true, path: prepared };
  } catch (error) {
    return { ok: false, reason: coverFailureReason(error) };
  }
}

async function removeCoverFile(filePath: string): Promise<void> {
  if (!fs.existsSync(filePath)) return;
  if (ioPermitIsHeld()) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  await withAlbumFolder(path.dirname(filePath), repairMeta, () => withHddIoPermit(repairMeta, async () => {
    fs.rmSync(filePath, { force: true });
  }));
}

/**
 * Validate the album cover once. A corrupt canonical file is removed. A
 * readable replacement is taken from the artwork cache or the normal
 * resolve-and-materialize path. Tags still write when no readable cover remains.
 */
export async function resolveUsableAlbumCover(
  row: AlbumCoverRow,
  mediaPath: string,
  preferredPath: string | null,
  context: AlbumCoverRepairContext,
): Promise<string | null> {
  const sidecar = sidecarPath(row);
  const releaseMbid = String(row.canonical_release_mbid || "").trim();
  const albumMbid = String(row.canonical_release_group_mbid || row.album_mb_release_group_id || "").trim();
  let cachePaths: string[] = [];
  if (context.repair) {
    const covers = await import("../metadata/media-cover-service.js");
    const ids: Array<[string, "Album" | "Edition"]> = [];
    if (releaseMbid) ids.push([releaseMbid, "Edition"]);
    const group = covers.albumMbidForEdition(releaseMbid) || albumMbid;
    if (group) ids.push([group, "Album"]);
    cachePaths = ids.flatMap(([id, entity]) => [".jpg", ".jpeg", ".png"].map((extension) => {
      try { return covers.getMediaCoverPath(id, entity, "cover", extension); }
      catch { return ""; }
    })).filter(Boolean);
  }
  const candidates = uniquePaths([preferredPath, sidecar, ...cachePaths]).filter((file) => fs.existsSync(file));
  const bad: Array<{ file: string; reason: string }> = [];
  let usable: string | null = null;
  for (const candidate of candidates) {
    const prepared = await tryPrepare(mediaPath, candidate, context.temporaryDirectories);
    if (prepared.ok && !usable) usable = prepared.path;
    else if (!prepared.ok) bad.push({ file: candidate, reason: prepared.reason });
  }
  if (bad.length === 0) return usable;
  if (!context.repair) return usable;
  const reason = bad[0]?.reason || "not a readable JPEG or PNG";
  for (const item of bad) await removeCoverFile(item.file);
  if (usable) {
    context.warnings.push(`Album cover was unreadable (${reason}); embedded art uses a readable artwork source`);
    return usable;
  }
  let refreshedPreferred = preferredPath;
  if (!ioPermitIsHeld()) {
    try {
      const covers = await import("../metadata/media-cover-service.js");
      const { materializeMediaCoverToFile } = await import("../metadata/media-cover-materialization.js");
      const group = covers.albumMbidForEdition(releaseMbid) || albumMbid || null;
      if (group) await covers.resolveAlbumArtwork({ albumMbid: group });
      if (group && releaseMbid && covers.releaseGroupHasMultipleMonitoredEditions(group)) {
        await covers.resolveEditionArtwork({ releaseMbid });
        covers.discardEditionCoverIfDuplicateOfAlbum(releaseMbid, group);
      }
      refreshedPreferred = covers.getPreferredCachedAlbumCoverPath({
        releaseMbid: releaseMbid || null,
        albumMbid: group,
        libraryRoot: row.library_root,
      });
      if (sidecar && releaseMbid) {
        let materialized = await materializeMediaCoverToFile({
          entityId: releaseMbid,
          coverEntity: "Edition",
          coverTypes: "cover",
          outputPath: sidecar,
          libraryRoot: row.library_root,
        });
        if (materialized === "missing" && group) {
          materialized = await materializeMediaCoverToFile({
            entityId: group,
            coverEntity: "Album",
            coverTypes: "cover",
            outputPath: sidecar,
            libraryRoot: row.library_root,
          });
        }
      }
    } catch (error) {
      console.warn(`[Retag] Could not re-materialize an unreadable album cover: ${error instanceof Error ? error.message : String(error)}`);
    }
    const refreshed = uniquePaths([sidecar, refreshedPreferred]).filter((file) => fs.existsSync(file));
    for (const candidate of refreshed) {
      const prepared = await tryPrepare(mediaPath, candidate, context.temporaryDirectories);
      if (prepared.ok) {
        context.warnings.push(`Album cover was unreadable (${reason}) and was replaced from the artwork source`);
        return prepared.path;
      }
      await removeCoverFile(candidate);
    }
  }
  context.warnings.push(`Album cover is unreadable (${reason}); tags were written without an embedded cover`);
  return null;
}
