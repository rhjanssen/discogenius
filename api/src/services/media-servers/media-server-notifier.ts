import path from "node:path";
import { getConfigSection } from "../config/config.js";
import { PlexClient } from "./plex-client.js";
import { JellyfinClient } from "./jellyfin-client.js";

export type MediaServerNotifyReason = "import" | "rename" | "retag";

export function collectTargetFolders(filePaths: string[]): string[] {
  const seen = new Set<string>();
  const folders: string[] = [];
  for (const rawPath of filePaths) {
    if (!rawPath || typeof rawPath !== "string") continue;
    const dir = path.dirname(path.resolve(rawPath));
    const key = process.platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    folders.push(dir);
  }
  return folders;
}

export async function notifyMediaServersForPaths(
  filePaths: string[],
  reason: MediaServerNotifyReason,
): Promise<{ plexScanned: number; jellyfinNotified: number }> {
  const folders = collectTargetFolders(filePaths);
  if (folders.length === 0) {
    return { plexScanned: 0, jellyfinNotified: 0 };
  }

  const config = getConfigSection("media_servers");
  if (!config) {
    return { plexScanned: 0, jellyfinNotified: 0 };
  }

  let plexScanned = 0;
  let jellyfinNotified = 0;

  if (config.plex_enabled && config.plex_url && config.plex_token) {
    try {
      const plex = new PlexClient(config.plex_url, config.plex_token);
      const sectionIds = config.plex_music_section_id
        ? [config.plex_music_section_id]
        : (await plex.getMusicSections()).map((s) => s.key);

      for (const sectionId of sectionIds) {
        for (const folder of folders) {
          await plex.scanFolder(sectionId, folder);
          plexScanned += 1;
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[MediaServers] Plex targeted scan failed after ${reason}: ${msg}`);
    }
  }

  if (config.jellyfin_enabled && config.jellyfin_url && config.jellyfin_api_key) {
    try {
      const jellyfin = new JellyfinClient(config.jellyfin_url, config.jellyfin_api_key);
      for (const folder of folders) {
        await jellyfin.notifyPathUpdated(folder, "Modified");
        jellyfinNotified += 1;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[MediaServers] Jellyfin targeted notify failed after ${reason}: ${msg}`);
    }
  }

  return { plexScanned, jellyfinNotified };
}
