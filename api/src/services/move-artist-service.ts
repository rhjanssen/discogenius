import fs from "fs";
import path from "path";
import { db } from "../database.js";
import { RequestValidationError } from "../utils/request-validation.js";
import { findArtistPathConflict, normalizeArtistFolderInput, resolveArtistFolderFromTemplate } from "./artist-paths.js";
import { Config } from "./config.js";
import { LibraryFilesService, removeEmptyParents, type RenameStatusSummary } from "./library-files.js";
import { JobTypes, TaskQueueService } from "./queue.js";
import { RenameTrackFileService } from "./rename-track-file-service.js";

type ArtistPathRow = {
  id: number | string;
  name: string | null;
  mbid: string | null;
  path: string | null;
};

export interface MoveArtistOptions {
  artistId: string;
  path?: string;
  applyNamingTemplate?: boolean;
  moveFiles?: boolean;
}

export interface MoveArtistResult {
  artistId: string;
  artistName: string;
  oldPath: string | null;
  path: string;
  changed: boolean;
  moveFilesQueued: boolean;
  jobId: number | null;
  renameStatus: RenameStatusSummary;
}

export interface ExecuteMoveArtistJobResult {
  artistId: string;
  sourcePath: string;
  destinationPath: string;
  movedRoots: number;
  updatedFiles: number;
  cleanedDirectories: number;
}

function loadArtistPathRow(artistId: string): ArtistPathRow | null {
  const artist = db.prepare("SELECT id, name, mbid, path FROM artists WHERE id = ?").get(artistId) as ArtistPathRow | undefined;
  return artist ?? null;
}

function resolveRequestedArtistPath(artist: ArtistPathRow, options: MoveArtistOptions): string {
  const applyNamingTemplate = options.applyNamingTemplate === true;
  const hasExplicitPath = typeof options.path === "string" && options.path.trim().length > 0;

  if (!applyNamingTemplate && !hasExplicitPath) {
    throw new RequestValidationError("Either path or applyNamingTemplate must be provided");
  }

  if (applyNamingTemplate && hasExplicitPath) {
    throw new RequestValidationError("path and applyNamingTemplate cannot be combined");
  }

  if (applyNamingTemplate) {
    return resolveArtistFolderFromTemplate({
      artistId: artist.id,
      artistName: String(artist.name || "Unknown Artist"),
      artistMbId: artist.mbid || null,
    });
  }

  try {
    return normalizeArtistFolderInput(String(options.path || ""));
  } catch (error) {
    throw new RequestValidationError(error instanceof Error ? error.message : String(error));
  }
}

function moveDirectoryCrossDevice(sourcePath: string, destinationPath: string): void {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

  try {
    fs.renameSync(sourcePath, destinationPath);
  } catch {
    fs.cpSync(sourcePath, destinationPath, { recursive: true, force: true });
    fs.rmSync(sourcePath, { recursive: true, force: true });
  }
}

function getLibraryRoots() {
  const roots = [
    { key: "music", path: Config.getMusicPath() },
    { key: "music_videos", path: Config.getVideoPath() },
  ];

  const atmosPath = Config.getAtmosPath();
  if (atmosPath) {
    roots.push({ key: "spatial_music", path: atmosPath });
  }

  return roots;
}

export class MoveArtistService {
  static moveArtist(options: MoveArtistOptions): MoveArtistResult | null {
    const artist = loadArtistPathRow(options.artistId);
    if (!artist) {
      return null;
    }

    const nextPath = resolveRequestedArtistPath(artist, options);
    const conflict = findArtistPathConflict(nextPath, artist.id);
    if (conflict) {
      const relationLabel = conflict.relation === "same"
        ? "already assigned to"
        : conflict.relation === "parent"
          ? "would become a parent of"
          : "would become nested under";
      throw new RequestValidationError(
        `Artist path '${nextPath}' ${relationLabel} artist '${conflict.artistName}' (${conflict.path})`,
      );
    }

    const currentPath = String(artist.path || "").trim() || null;
    const changed = currentPath !== nextPath;

    if (changed) {
      db.prepare(`
        UPDATE artists
        SET path = ?
        WHERE id = ?
      `).run(nextPath, options.artistId);
    }

    const renameStatus = RenameTrackFileService.getRenameStatus({ artistId: options.artistId }, 10);

    let jobId: number | null = null;
    const shouldQueueMove = options.moveFiles === true && changed && Boolean(currentPath) && renameStatus.renameNeeded > 0;
    if (shouldQueueMove) {
      const queuedJobId = TaskQueueService.addJob(
        JobTypes.MoveArtist,
        {
          artistId: options.artistId,
          sourcePath: currentPath,
          destinationPath: nextPath,
          moveFiles: true,
        },
        options.artistId,
        1,
        1,
      );
      jobId = queuedJobId > 0 ? queuedJobId : null;
    }

    return {
      artistId: String(artist.id),
      artistName: String(artist.name || "Unknown Artist"),
      oldPath: currentPath,
      path: nextPath,
      changed,
      moveFilesQueued: shouldQueueMove && jobId !== null,
      jobId,
      renameStatus,
    };
  }

  static executeMoveArtistJob(options: {
    artistId: string;
    sourcePath?: string | null;
    destinationPath: string;
  }): ExecuteMoveArtistJobResult {
    const artist = loadArtistPathRow(options.artistId);
    if (!artist) {
      throw new Error(`Artist ${options.artistId} not found`);
    }

    const sourcePath = normalizeArtistFolderInput(String(options.sourcePath || ""));
    const destinationPath = normalizeArtistFolderInput(options.destinationPath);

    if (sourcePath === destinationPath) {
      return {
        artistId: String(artist.id),
        sourcePath,
        destinationPath,
        movedRoots: 0,
        updatedFiles: 0,
        cleanedDirectories: 0,
      };
    }

    const movedRoots: Array<{ sourceDir: string; destinationDir: string; rootPath: string }> = [];
    let cleanedDirectories = 0;

    try {
      for (const libraryRoot of getLibraryRoots()) {
        const sourceDir = path.join(libraryRoot.path, sourcePath);
        const destinationDir = path.join(libraryRoot.path, destinationPath);

        if (!fs.existsSync(sourceDir)) {
          continue;
        }

        if (fs.existsSync(destinationDir)) {
          const existingEntries = fs.readdirSync(destinationDir);
          if (existingEntries.length > 0) {
            throw new Error(`Destination artist folder already exists in ${libraryRoot.key}: ${destinationDir}`);
          }

          fs.rmdirSync(destinationDir);
        }
      }

      for (const libraryRoot of getLibraryRoots()) {
        const sourceDir = path.join(libraryRoot.path, sourcePath);
        const destinationDir = path.join(libraryRoot.path, destinationPath);

        if (!fs.existsSync(sourceDir)) {
          continue;
        }

        moveDirectoryCrossDevice(sourceDir, destinationDir);
        movedRoots.push({ sourceDir, destinationDir, rootPath: libraryRoot.path });

        const cleanupStart = path.dirname(sourceDir);
        const beforeCleanup = cleanupStart;
        removeEmptyParents(cleanupStart, libraryRoot.path);
        if (!fs.existsSync(beforeCleanup)) {
          cleanedDirectories += 1;
        }
      }

      const rebased = LibraryFilesService.rebaseArtistPathsAfterMove({
        artistId: String(artist.id),
        sourcePath,
        destinationPath,
      });

      return {
        artistId: String(artist.id),
        sourcePath,
        destinationPath,
        movedRoots: movedRoots.length,
        updatedFiles: rebased.updated,
        cleanedDirectories,
      };
    } catch (error) {
      for (const movedRoot of movedRoots.reverse()) {
        try {
          if (fs.existsSync(movedRoot.destinationDir)) {
            moveDirectoryCrossDevice(movedRoot.destinationDir, movedRoot.sourceDir);
          }
        } catch (rollbackError) {
          console.error("[MoveArtist] Failed to roll back moved artist folder:", rollbackError);
        }
      }

      db.prepare(`
        UPDATE artists
        SET path = ?
        WHERE id = ?
      `).run(sourcePath, options.artistId);

      throw error;
    }
  }
}
