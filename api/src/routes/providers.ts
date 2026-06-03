import { Router } from "express";
import { streamingProviderManager } from "../services/providers/index.js";

const router = Router();

function serializeProvider(provider: ReturnType<typeof streamingProviderManager.getDefaultStreamingProvider>, isDefault: boolean) {
  const authenticated = provider.isAuthenticated ? provider.isAuthenticated() : false;

  return {
    id: provider.id,
    name: provider.name,
    isDefault,
    authenticated,
    remoteCatalogAvailable: authenticated,
    capabilities: provider.capabilities,
    management: {
      canAuthenticate: provider.capabilities.providerIds && provider.id === "tidal",
      canDisconnect: Boolean(provider.logout),
      canImportFollowedArtists: provider.capabilities.followedArtists && Boolean(provider.getFollowedArtists),
      canPreviewTracks: provider.capabilities.audioPreviews && Boolean(provider.getPlaybackInfo),
      canPreviewVideos: provider.capabilities.videoPreviews && Boolean(provider.getVideoPlaybackInfo),
      canDownloadMusic: provider.capabilities.audioDownloads,
      canDownloadVideos: provider.capabilities.videoDownloads,
    },
  };
}

router.get("/", (_, res) => {
  const defaultProvider = streamingProviderManager.getDefaultStreamingProvider();
  const providers = streamingProviderManager
    .getAllStreamingProviders()
    .map((provider) => serializeProvider(provider, provider.id === defaultProvider.id));

  res.json({ providers, defaultProviderId: defaultProvider.id });
});

router.get("/:providerId/albums/:albumId/tracks", async (req, res) => {
  try {
    const provider = streamingProviderManager.getStreamingProvider(req.params.providerId);
    const tracks = await provider.getAlbumTracks(req.params.albumId);
    res.json(tracks);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/:providerId/logout", async (req, res) => {
  try {
    const provider = streamingProviderManager.getStreamingProvider(req.params.providerId);
    if (!provider.logout) {
      return res.status(501).json({ detail: `${provider.name} does not support disconnecting` });
    }

    await provider.logout();
    res.json({ success: true, provider: provider.id });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;
