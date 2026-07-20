import { streamingProviderManager } from "../providers/index.js";
import { RefreshAlbumService } from "./refresh-album-service.js";
import { RefreshArtistService } from "./refresh-artist-service.js";
import { RefreshVideoService } from "./refresh-video-service.js";
import type { RefreshOptions } from "./scan-types.js";

export class MediaSeedService {
    static async seedTrack(trackId: string, options: RefreshOptions = {}) {
        const providerClient = options.provider
            ? streamingProviderManager.getStreamingProvider(options.provider)
            : streamingProviderManager.getDefaultStreamingProvider();
        const providerTrack = await providerClient.getTrack(trackId);
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
            provider: providerClient.id,
            includeSimilarArtists: false,
            seedSimilarArtists: false,
        });

        await RefreshAlbumService.refreshMetadata(albumId, {
            ...options,
            provider: providerClient.id,
            includeSimilarAlbums: false,
            seedSimilarAlbums: false,
        });

        return trackData;
    }

    static async seedVideo(videoId: string, options: RefreshOptions = {}) {
        const providerClient = options.provider
            ? streamingProviderManager.getStreamingProvider(options.provider)
            : streamingProviderManager.getDefaultStreamingProvider();
        const providerVideo = await providerClient.getVideo?.(videoId);
        if (!providerVideo) {
            throw new Error(`Video ${videoId} not found`);
        }
        // Prefer mapped ProviderVideo fields so YouTube titles under
        // videoDetails are not lost when seed upserts Recordings.
        const raw = (providerVideo.raw && typeof providerVideo.raw === "object")
            ? providerVideo.raw as Record<string, any>
            : {};
        const videoData: any = {
            ...raw,
            ...providerVideo,
            title: providerVideo.title || raw.title || null,
            provider_id: providerVideo.providerId || videoId,
            artist_id: providerVideo.artist?.providerId || raw.artist_id || null,
            quality: providerVideo.quality || raw.quality || null,
            explicit: providerVideo.explicit ? 1 : 0,
        };
        // upsertArtistVideos attributes rows to `video.provider` (defaulting to
        // the default provider) — stamp the catalog that actually served this.
        videoData.provider = videoData.provider || providerClient.id;
        const artistId = videoData.artist_id?.toString?.() ?? String(videoData.artist_id ?? "");
        const albumId = videoData.album_id?.toString?.() ?? String(videoData.album_id ?? "");

        if (!artistId) {
            throw new Error("Video missing artist info");
        }

        await RefreshArtistService.refreshArtistMetadata(artistId, {
            ...options,
            provider: providerClient.id,
            includeSimilarArtists: false,
            seedSimilarArtists: false,
        });

        if (albumId) {
            await RefreshAlbumService.refreshOffer(albumId, artistId, undefined, {
                ...options,
                provider: providerClient.id,
                includeSimilarAlbums: false,
                seedSimilarAlbums: false,
            });
        }

        RefreshVideoService.upsertArtistVideos(artistId, [{ ...videoData, album_id: albumId || null }], options);
        return videoData;
    }
}
