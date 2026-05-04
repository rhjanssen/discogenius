import { getTrack, getVideo } from "./providers/tidal/tidal.js";
import { RefreshAlbumService } from "./refresh-album-service.js";
import { RefreshArtistService } from "./refresh-artist-service.js";
import { RefreshVideoService } from "./refresh-video-service.js";
import type { ScanOptions } from "./scan-types.js";

export class MediaSeedService {
    static async seedTrack(trackId: string, options: ScanOptions = {}) {
        const trackData = await getTrack(trackId);
        const artistId = trackData.artist_id?.toString?.() ?? String(trackData.artist_id ?? "");
        const albumId = trackData.album_id?.toString?.() ?? String(trackData.album_id ?? "");

        if (!artistId || !albumId) {
            throw new Error("Track missing artist or album info");
        }

        await RefreshArtistService.scanBasic(artistId, {
            ...options,
            includeSimilarArtists: false,
            seedSimilarArtists: false,
        });

        await RefreshAlbumService.scanShallow(albumId, {
            ...options,
            includeSimilarAlbums: false,
            seedSimilarAlbums: false,
        });

        return trackData;
    }

    static async seedVideo(videoId: string, options: ScanOptions = {}) {
        const videoData = await getVideo(videoId);
        const artistId = videoData.artist_id?.toString?.() ?? String(videoData.artist_id ?? "");
        const albumId = videoData.album_id?.toString?.() ?? String(videoData.album_id ?? "");

        if (!artistId) {
            throw new Error("Video missing artist info");
        }

        await RefreshArtistService.scanBasic(artistId, {
            ...options,
            includeSimilarArtists: false,
            seedSimilarArtists: false,
        });

        if (albumId) {
            await RefreshAlbumService.scanBasic(albumId, artistId, undefined, {
                ...options,
                includeSimilarAlbums: false,
                seedSimilarAlbums: false,
            });
        }

        RefreshVideoService.upsertArtistVideos(artistId, [{ ...videoData, album_id: albumId || null }], options);
        return videoData;
    }
}
