import { Router } from "express";
import { Config, updateConfig } from "../services/config/config.js";
import { streamingProviderManager } from "../services/providers/index.js";
import { getProviderDiagnostics } from "../services/providers/provider-diagnostics.js";
import { providerSupportsAppAuthentication } from "../services/providers/provider-auth-support.js";
import type { ProviderImportSelection, StreamingProvider } from "../services/providers/streaming-provider.js";

const router = Router();

export async function serializeProvider(provider: StreamingProvider, isDefault: boolean) {
  const locallyAuthenticated = provider.isAuthenticated ? provider.isAuthenticated() : false;
  let authenticated = locallyAuthenticated;
  let remoteCatalogAvailable = locallyAuthenticated;

  try {
    const authStatus = await provider.getAuthStatus();
    authenticated = authStatus.connected;
    remoteCatalogAvailable = authStatus.remoteCatalogAvailable;
  } catch {
    // A provider status probe should not make the complete registry unavailable.
    // Keep the synchronous local state as a conservative fallback.
  }

  return {
    id: provider.id,
    name: provider.name,
    isDefault,
    authenticated,
    remoteCatalogAvailable,
    manifest: provider.manifest,
    capabilities: provider.capabilities,
    management: {
      canAuthenticate: providerSupportsAppAuthentication(provider),
      canDisconnect: Boolean(provider.logout),
      canImportArtists: Boolean(provider.listImportSources && provider.getArtistsForImportSource),
      canPreviewTracks: provider.capabilities.audioPreviews && Boolean(provider.getPlaybackInfo),
      canPreviewVideos: provider.capabilities.videoPreviews && Boolean(provider.getVideoPlaybackInfo),
      canDownloadMusic: provider.capabilities.audioDownloads,
      canDownloadVideos: provider.capabilities.videoDownloads,
    },
  };
}

router.get("/", async (_, res) => {
  try {
    const defaultProvider = streamingProviderManager.getDefaultStreamingProvider();
    const priority = streamingProviderManager.getProviderPriority();
    const rank = (id: string) => {
      const index = priority.indexOf(id);
      return index === -1 ? priority.length : index;
    };
    const providers = (await Promise.all(
      streamingProviderManager
        .getAllStreamingProviders()
        .map((provider) => serializeProvider(provider, provider.id === defaultProvider.id)),
    )).sort((left, right) => rank(left.id) - rank(right.id));

    res.json({ providers, defaultProviderId: defaultProvider.id, providerPriority: priority });
  } catch (error: any) {
    res.status(500).json({ detail: error.message || "Unable to load provider registry" });
  }
});

// Persist the user's provider preference order. The first entry becomes the
// default provider; matching tie-breaks use the full order.
router.put("/priority", (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body as { order?: unknown } : {};
    const raw = Array.isArray(body.order) ? body.order.map((id) => String(id || "").trim()) : [];
    const known = new Set(streamingProviderManager.getAllStreamingProviders().map((provider) => provider.id));
    const order = [...new Set(raw)].filter((id) => known.has(id));
    if (order.length === 0) {
      return res.status(400).json({ detail: "order must contain at least one registered provider id" });
    }

    updateConfig("streaming", {
      ...Config.getStreamingConfig(),
      provider_priority: order,
      default_provider: order[0],
    });

    res.json({ providerPriority: streamingProviderManager.getProviderPriority(), defaultProviderId: order[0] });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/:providerId/diagnostics", async (req, res) => {
  try {
    const provider = streamingProviderManager.getStreamingProvider(req.params.providerId);
    const diagnostics = await getProviderDiagnostics(provider);
    res.json({ providerId: provider.id, providerName: provider.name, diagnostics });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
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

// Artist-import sources for the connected provider (followed artists, playlists,
// favorite tracks, home-screen mixes). Used by the "Import artists" modal.
router.get("/import-sources", async (req, res) => {
  try {
    const providerId = typeof req.query.providerId === "string" ? req.query.providerId : "";
    const provider = providerId
      ? streamingProviderManager.getStreamingProvider(providerId)
      : streamingProviderManager.getDefaultStreamingProvider();

    if (provider.isAuthenticated && !provider.isAuthenticated()) {
      return res.status(409).json({ detail: `Connect ${provider.name} to import artists` });
    }
    if (!provider.listImportSources) {
      return res.json({ providerId: provider.id, providerName: provider.name, sources: [] });
    }

    const sources = await provider.listImportSources();
    res.json({ providerId: provider.id, providerName: provider.name, sources });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/import-preview", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const providerId = typeof body.providerId === "string" ? body.providerId : "";
    const provider = providerId
      ? streamingProviderManager.getStreamingProvider(providerId)
      : streamingProviderManager.getDefaultStreamingProvider();
    if (!provider.getArtistsForImportSource) {
      return res.status(501).json({ detail: `${provider.name} does not support artist import` });
    }
    if (provider.isAuthenticated && !provider.isAuthenticated()) {
      return res.status(409).json({ detail: `Connect ${provider.name} to import artists` });
    }
    const category = typeof body.category === "string" ? body.category : "";
    const allowed = new Set(["library-artists", "followed-artists", "playlist", "favorite-tracks", "mix"]);
    if (!allowed.has(category)) {
      return res.status(400).json({ detail: `Unknown import category: ${category}` });
    }
    const listId = typeof body.listId === "string" ? body.listId : undefined;
    const artists = await provider.getArtistsForImportSource({
      category: category as ProviderImportSelection["category"],
      listId,
    });
    res.json({
      providerId: provider.id,
      providerName: provider.name,
      artists: artists.map((artist) => ({
        providerId: artist.providerId,
        name: artist.name,
        picture: artist.picture ?? null,
      })),
    });
  } catch (error: any) {
    res.status(500).json({ detail: error.message || "Failed to preview provider artists" });
  }
});

export default router;
