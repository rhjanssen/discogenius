import { Router, Request, Response } from "express";
import { db } from "../database.js";
import { JobTypes, TaskQueueService } from "../services/queue.js";
import { queuePlaylistSyncByUuid, PlaylistSyncServiceError } from "../services/playlist-sync.js";
import { streamingProviderManager } from "../services/providers/index.js";

const router = Router();

interface Playlist {
  uuid: string;
  tidal_id: string | null;
  title: string;
  description?: string;
  creator_name?: string;
  creator_id?: string;
  cover_id?: string;
  square_cover_id?: string;
  num_tracks: number;
  num_videos: number;
  duration: number;
  created?: string;
  last_updated?: string;
  type: string;
  public_playlist: boolean;
  monitored: boolean;
  downloaded: boolean;
}

// Get all playlists
router.get("/", (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const search = req.query.search as string;
    const monitored = req.query.monitored as string;

    const whereClauses: string[] = [];
    const whereParams: any[] = [];

    if (search) {
      whereClauses.push("(title LIKE ? OR creator_name LIKE ?)");
      whereParams.push(`%${search}%`, `%${search}%`);
    }

    if (monitored === "true") {
      whereClauses.push("monitored = 1");
    } else if (monitored === "false") {
      whereClauses.push("monitored = 0");
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const sql = `SELECT * FROM playlists ${whereSql} ORDER BY last_updated DESC LIMIT ? OFFSET ?`;
    const playlists = db.prepare(sql).all(...whereParams, limit, offset);
    const total = (db.prepare(`SELECT COUNT(*) as count FROM playlists ${whereSql}`).get(...whereParams) as any)?.count || 0;

    res.json({ playlists, total });
  } catch (error: any) {
    console.error("[PLAYLISTS] Error fetching playlists:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get single playlist
router.get("/:playlistId", (req: Request, res: Response) => {
  try {
    const { playlistId } = req.params;

    const playlist = db.prepare(
      "SELECT * FROM playlists WHERE uuid = ?"
    ).get(playlistId);

    if (!playlist) {
      return res.status(404).json({ error: "Playlist not found" });
    }

    // Get tracks in playlist
    const tracks = db.prepare(`
      SELECT m.*, pt.position
      FROM playlist_tracks pt
      JOIN ProviderMedia m ON pt.track_id = m.id
      WHERE pt.playlist_uuid = ?
      ORDER BY pt.position
    `).all((playlist as any).uuid);

    res.json({ ...playlist, tracks });
  } catch (error: any) {
    console.error("[PLAYLISTS] Error fetching playlist:", error);
    res.status(500).json({ error: error.message });
  }
});

// Add playlist from a provider.
router.post("/", async (req: Request, res: Response) => {
  try {
    const { id, url } = req.body;
    const provider = streamingProviderManager.getDefaultStreamingProvider();
    if (!provider.getPlaylist) {
      return res.status(501).json({ error: `${provider.name} playlists are not supported` });
    }

    // Extract playlist ID from URL if provided
    let playlistId = id;
    if (!playlistId && url) {
      const match = url.match(/playlist\/([a-f0-9-]+)/i);
      if (match) {
        playlistId = match[1];
      }
    }

    if (!playlistId) {
      return res.status(400).json({ error: "Playlist ID or URL required" });
    }

    // Check if already exists
    const existing = db.prepare(
      "SELECT * FROM playlists WHERE uuid = ?"
    ).get(playlistId);

    if (existing) {
      return res.json({ message: "Playlist already exists", playlist: existing });
    }

    const providerPlaylist = await provider.getPlaylist(playlistId);

    if (!providerPlaylist) {
      return res.status(404).json({ error: `Playlist not found on ${provider.name}` });
    }

    // Insert playlist
    db.prepare(`
      INSERT INTO playlists (
        uuid, tidal_id, title, description, creator_name, creator_id,
        cover_id, square_cover_id, num_tracks, num_videos, duration,
        created, last_updated, type, public_playlist, user_date_added
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      providerPlaylist.uuid,
      providerPlaylist.uuid, // provider playlist id is currently stored in the legacy tidal_id column.
      providerPlaylist.title,
      providerPlaylist.description,
      providerPlaylist.creator?.name,
      providerPlaylist.creator?.id?.toString(),
      providerPlaylist.image,
      providerPlaylist.squareImage,
      providerPlaylist.numberOfTracks || 0,
      providerPlaylist.numberOfVideos || 0,
      providerPlaylist.duration || 0,
      providerPlaylist.created,
      providerPlaylist.lastUpdated,
      providerPlaylist.type || "USER",
      providerPlaylist.publicPlaylist ? 1 : 0
    );

    // Queue job to fetch playlist tracks
    TaskQueueService.addJob(JobTypes.ScanPlaylist, { tidalId: providerPlaylist.uuid }, providerPlaylist.uuid);

    const newPlaylist = db.prepare(
      "SELECT * FROM playlists WHERE uuid = ?"
    ).get(providerPlaylist.uuid);

    res.status(201).json({ message: "Playlist added", playlist: newPlaylist });
  } catch (error: any) {
    console.error("[PLAYLISTS] Error adding playlist:", error);
    res.status(500).json({ error: error.message });
  }
});

// Update playlist (toggle monitoring)
router.patch("/:playlistId", (req: Request, res: Response) => {
  try {
    const { playlistId } = req.params;
    const { monitored, downloaded } = req.body;

    if (monitored !== undefined && typeof monitored !== "boolean") {
      return res.status(400).json({ error: "monitored must be a boolean" });
    }

    if (downloaded !== undefined && typeof downloaded !== "boolean") {
      return res.status(400).json({ error: "downloaded must be a boolean" });
    }

    const updates: string[] = [];
    const params: any[] = [];

    if (monitored !== undefined) {
      updates.push("monitored = ?");
      params.push(monitored ? 1 : 0);
    }

    if (downloaded !== undefined) {
      updates.push("downloaded = ?");
      params.push(downloaded ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No updates provided" });
    }

    updates.push("last_updated = CURRENT_TIMESTAMP");
    params.push(playlistId);

    const result = db.prepare(`
      UPDATE playlists SET ${updates.join(", ")}
      WHERE uuid = ?
    `).run(...params);

    if (result.changes === 0) {
      return res.status(404).json({ error: "Playlist not found" });
    }

    const playlist = db.prepare(
      "SELECT * FROM playlists WHERE uuid = ?"
    ).get(playlistId);

    res.json(playlist);
  } catch (error: any) {
    console.error("[PLAYLISTS] Error updating playlist:", error);
    res.status(500).json({ error: error.message });
  }
});

// Delete playlist
router.delete("/:playlistId", (req: Request, res: Response) => {
  try {
    const { playlistId } = req.params;

    // Delete playlist tracks first (cascade should handle this)
    db.prepare(
      "DELETE FROM playlist_tracks WHERE playlist_uuid = ?"
    ).run(playlistId);

    const result = db.prepare(
      "DELETE FROM playlists WHERE uuid = ?"
    ).run(playlistId);

    if (result.changes === 0) {
      return res.status(404).json({ error: "Playlist not found" });
    }

    res.json({ message: "Playlist deleted" });
  } catch (error: any) {
    console.error("[PLAYLISTS] Error deleting playlist:", error);
    res.status(500).json({ error: error.message });
  }
});

// Sync playlist (refresh tracks from Tidal)
router.post("/:playlistId/sync", (req: Request, res: Response) => {
  try {
    const playlistIdRaw = req.params.playlistId;
    const playlistId = Array.isArray(playlistIdRaw) ? playlistIdRaw[0] : playlistIdRaw;
    const result = queuePlaylistSyncByUuid(playlistId);
    return res.status(202).json(result);
  } catch (error: any) {
    if (error instanceof PlaylistSyncServiceError) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
      });
    }

    console.error("[PLAYLISTS] Error syncing playlist:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Download playlist
router.post("/:playlistId/download", async (req: Request, res: Response) => {
  try {
    const { playlistId } = req.params;

    const playlist = db.prepare(
      "SELECT * FROM playlists WHERE uuid = ?"
    ).get(playlistId) as Playlist | undefined;

    if (!playlist) {
      return res.status(404).json({ error: "Playlist not found" });
    }

    // Get all tracks in playlist that haven't been downloaded
    const tracks = db.prepare(`
      SELECT m.id, m.album_id, m.artist_id, m.title
      FROM playlist_tracks pt
      JOIN ProviderMedia m ON pt.track_id = m.id
      WHERE pt.playlist_uuid = ?
        AND m.type != 'Music Video'
        AND NOT EXISTS (
          SELECT 1
          FROM TrackFiles lf
          WHERE lf.media_id = m.id
            AND lf.file_type = 'track'
        )
    `).all(playlist.uuid) as any[];

    // Queue download jobs for each track
    let queued = 0;
    for (const track of tracks) {
      TaskQueueService.addJob(JobTypes.DownloadTrack, {
        tidalId: String(track.id),
        album_id: track.album_id,
        artist_id: track.artist_id,
        title: track.title,
        source: "playlist"
      }, String(track.id));
      queued++;
    }

    res.json({
      message: `Queued ${queued} tracks for download`,
      total_tracks: tracks.length,
      queued
    });
  } catch (error: any) {
    console.error("[PLAYLISTS] Error downloading playlist:", error);
    res.status(500).json({ error: error.message });
  }
});

// Import user's playlists from a provider.
router.post("/import-user", async (req: Request, res: Response) => {
  try {
    const provider = streamingProviderManager.getDefaultStreamingProvider();
    if (!provider.getUserPlaylists) {
      return res.status(501).json({ error: `${provider.name} user playlists are not supported` });
    }

    const playlistsResponse = await provider.getUserPlaylists();

    // Handle both array and paginated response formats
    const playlists = Array.isArray(playlistsResponse)
      ? playlistsResponse
      : (playlistsResponse as any)?.items || [];

    let imported = 0;
    let skipped = 0;

    const selectExisting = db.prepare("SELECT uuid FROM playlists WHERE uuid = ?");
    const insertPlaylist = db.prepare(`
      INSERT INTO playlists (
        uuid, tidal_id, title, description, creator_name, creator_id,
        cover_id, square_cover_id, num_tracks, num_videos, duration,
        created, last_updated, type, public_playlist, user_date_added
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    db.transaction(() => {
      for (const playlist of playlists) {
        if (selectExisting.get(playlist.uuid)) {
          skipped++;
          continue;
        }

        insertPlaylist.run(
          playlist.uuid,
          playlist.uuid,
          playlist.title,
          playlist.description,
          playlist.creator?.name,
          playlist.creator?.id?.toString(),
          playlist.image,
          playlist.squareImage,
          playlist.numberOfTracks || 0,
          playlist.numberOfVideos || 0,
          playlist.duration || 0,
          playlist.created,
          playlist.lastUpdated,
          playlist.type || "USER",
          playlist.publicPlaylist ? 1 : 0
        );
        imported++;
      }
    })();

    res.json({
      message: `Imported ${imported} playlists, skipped ${skipped} existing`,
      imported,
      skipped,
      total: playlists.length
    });
  } catch (error: any) {
    console.error("[PLAYLISTS] Error importing playlists:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
