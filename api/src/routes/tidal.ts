import { Router } from "express";
import { getArtist, getArtistAlbums, getArtistVideos, getAlbumTracks } from "../services/providers/tidal/tidal.js";

const router = Router();

// Direct Tidal API access endpoints (no database required)
// These are used for dynamic artist viewing from search results

router.get("/artists/:artistId", async (req, res) => {
  try {
    const artistData = await getArtist(req.params.artistId);
    res.json(artistData);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/artists/:artistId/albums", async (req, res) => {
  try {
    const albumsData = await getArtistAlbums(req.params.artistId);
    res.json(albumsData);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/artists/:artistId/videos", async (req, res) => {
  try {
    const videosData = await getArtistVideos(req.params.artistId);
    res.json(videosData);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/albums/:albumId/tracks", async (req, res) => {
  try {
    const tracksData = await getAlbumTracks(req.params.albumId);
    res.json(tracksData);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;
