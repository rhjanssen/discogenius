import { streamingProviderManager } from "../providers/index.js";
import { RefreshAlbumService } from "./refresh-album-service.js";
import { RefreshArtistService } from "./refresh-artist-service.js";
import { RefreshVideoService } from "./refresh-video-service.js";
import type { RefreshOptions } from "./scan-types.js";

export class MediaSeedService {
    static async seedTrack(trackId: string, options: RefreshOptions = {}) {
        const providerTrack = await streamingProviderManager.getDefaultStreamingProvider().getTrack(trackId);
        const trackData = (providerTrack.raw && typeof providerTrack.raw === "object")
            ? providerTrack.raw as any
            : providerTrack as any;
        const artistId = trackData.artist_id?.toString?.() ?? String(trackData.artist_id ?? "");
        const albumId = trackData.album_id?.toString?.() ?? String(trackData.album_id ?? "");

        if (!artistId || !albumId) {
            throw new Error("Track missing artist or album info");
        }

        await RefreshArtistService.refreshArtistMetadata(artistId, {
            ...options,
            includeSimilarArtists: false,
            seedSimilarArtists: false,
        });

        await RefreshAlbumService.refreshMetadata(albumId, {
            ...options,
            includeSimilarAlbums: false,
            seedSimilarAlbums: false,
        });

        return trackData;
    }

    static async seedVideo(videoId: string, options: RefreshOptions = {}) {
        const providerVideo = await streamingProviderManager.getDefaultStreamingProvider().getVideo?.(videoId);
        if (!providerVideo) {
            throw new Error(`Video ${videoId} not found`);
        }
        const videoData = (providerVideo.raw && typeof providerVideo.raw === "object")
            ? providerVideo.raw as any
            : providerVideo as any;
        const artistId = videoData.artist_id?.toString?.() ?? String(videoData.artist_id ?? "");
        const albumId = videoData.album_id?.toString?.() ?? String(videoData.album_id ?? "");

        if (!artistId) {
            throw new Error("Video missing artist info");
        }

        await RefreshArtistService.refreshArtistMetadata(artistId, {
            ...options,
            includeSimilarArtists: false,
            seedSimilarArtists: false,
        });

        if (albumId) {
            await RefreshAlbumService.refreshOffer(albumId, artistId, undefined, {
                ...options,
                includeSimilarAlbums: false,
                seedSimilarAlbums: false,
            });
        }

        RefreshVideoService.upsertArtistVideos(artistId, [{ ...videoData, album_id: albumId || null }], options);
        return videoData;
    }
}
