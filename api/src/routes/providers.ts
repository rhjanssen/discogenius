import { Router } from "express";
import { db } from "../database.js";
import { Config, updateConfig } from "../services/config/config.js";
import { looksLikeMusicBrainzMbid } from "../services/metadata/provider-track-resolver.js";
import { streamingProviderManager } from "../services/providers/index.js";
import { getProviderDiagnostics } from "../services/providers/provider-diagnostics.js";
import { providerSupportsAppAuthentication } from "../services/providers/provider-auth-support.js";
import type { ProviderImportSelection, StreamingProvider } from "../services/providers/streaming-provider.js";
import { markAcquisitionPlanningStale } from "../services/music/acquisition-planning-control.js";

const router = Router();

export type ProviderPreferenceRepair = {
  providerPriority: string[];
  defaultProviderId: string;
};

/**
 * Keep the configured default aligned with the first connected provider after
 * a disconnect. Inactive providers remain persisted, but only after the active
 * group so a hidden Settings row can never retain first priority.
 */
export function buildProviderPreferenceAfterDisconnect(
  priority: readonly string[],
  disconnectedProviderId: string,
  isConnected: (providerId: string) => boolean,
): ProviderPreferenceRepair | null {
  const order = [...new Set(priority.map((id) => String(id || "").trim()).filter(Boolean))];
  const connected = order.filter((id) => id !== disconnectedProviderId && isConnected(id));
  if (connected.length === 0) return null;

  const connectedSet = new Set(connected);
  return {
    providerPriority: [
      ...connected,
      ...order.filter((id) => !connectedSet.has(id)),
    ],
    defaultProviderId: connected[0],
  };
}

/**
 * Use the same authoritative remote connection state that Settings renders.
 * A locally present but expired credential must not become the hidden default;
 * only probe failures fall back to the adapter's local credential check.
 */
export async function providerConnectedForPreference(
  provider: StreamingProvider,
): Promise<boolean> {
  const locallyAuthenticated = provider.isAuthenticated ? provider.isAuthenticated() : false;
  try {
    return (await provider.getAuthStatus()).connected;
  } catch {
    return locallyAuthenticated;
  }
}

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

    markAcquisitionPlanningStale();

    res.json({
      providerPriority: streamingProviderManager.getProviderPriority(),
      defaultProviderId: order[0],
      plansPendingCuration: true,
    });
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
    let albumId = req.params.albumId;
    const requestedReleaseMbid = typeof req.query.releaseMbid === "string" ? req.query.releaseMbid.trim() : "";

    if (looksLikeMusicBrainzMbid(albumId) || albumId.startsWith("mbid-")) {
      const cleanMbid = albumId.replace(/^mbid-/, "");

      // If a specific release MBID or release group MBID is in our database, query canonical tracks first
      const releaseFilter = requestedReleaseMbid
        ? "WHERE rel.mbid = ?"
        : "WHERE rel.release_group_mbid = ? OR rel.mbid = ?";
      const params = requestedReleaseMbid ? [requestedReleaseMbid] : [cleanMbid, cleanMbid];

      // Select release with the largest track count if not explicitly pinned
      const localTracks = db.prepare(`
        SELECT
          t.mbid AS id,
          t.mbid AS providerId,
          t.title,
          t.position,
          t.medium_position,
          COALESCE(r.length_ms, t.length_ms, 0) AS length_ms,
          t.release_mbid
        FROM Tracks t
        JOIN AlbumEditions rel ON rel.mbid = t.release_mbid
        LEFT JOIN Recordings r ON r.mbid = t.recording_mbid
        ${releaseFilter}
        ORDER BY
          (SELECT COUNT(*) FROM Tracks t2 WHERE t2.release_mbid = rel.mbid) DESC,
          t.medium_position ASC,
          t.position ASC
      `).all(...params) as any[];

      if (localTracks.length > 0) {
        // Group tracks by the top release_mbid
        const targetReleaseMbid = requestedReleaseMbid || localTracks[0].release_mbid;
        const filteredTracks = localTracks
          .filter((t) => !targetReleaseMbid || t.release_mbid === targetReleaseMbid)
          .map((t) => ({
            id: String(t.id),
            providerId: String(t.providerId || t.id),
            title: String(t.title),
            trackNumber: Number(t.medium_position || 1) > 1
              ? (Number(t.medium_position) * 100 + Number(t.position))
              : Number(t.position || 0),
            rawTrackNumber: Number(t.position || 0),
            volumeNumber: Number(t.medium_position || 1),
            duration: Math.round(Number(t.length_ms || 0) / 1000),
            releaseMbid: String(t.release_mbid),
          }));

        if (filteredTracks.length > 0) {
          return res.json(filteredTracks);
        }
      }

      // Try resolving provider ID fallback
      const item = db.prepare(`
        SELECT provider_release.provider_id
        FROM ProviderItems provider_release
        JOIN ProviderEditionMatches release_match
          ON release_match.provider_edition_item_id = provider_release.id
         AND release_match.match_state = 'accepted'
        JOIN AlbumEditions release
          ON release.id = release_match.edition_id
        JOIN Albums release_group
          ON release_group.id = release.release_group_id
        LEFT JOIN AcquisitionPlanSources source
          ON source.provider_edition_match_id = release_match.id
        LEFT JOIN SelectedAcquisitionPlans plan
          ON plan.id = source.plan_id
         AND plan.state = 'current'
        WHERE provider_release.provider = ?
          AND provider_release.entity_type = 'release'
          AND (release_group.mbid = ? OR release.mbid = ?)
        ORDER BY
          CASE WHEN plan.id IS NOT NULL THEN 0 ELSE 1 END,
          CASE WHEN release_match.decision_source = 'manual' THEN 0 ELSE 1 END,
          release_match.confidence DESC,
          release_match.id
        LIMIT 1
      `).get(
        req.params.providerId,
        cleanMbid,
        cleanMbid,
      ) as { provider_id: string } | undefined;

      if (item?.provider_id) {
        albumId = item.provider_id;
      }
    }

    const provider = streamingProviderManager.getStreamingProvider(req.params.providerId);
    const tracks = await provider.getAlbumTracks(albumId);
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
    const connectedByProvider = new Map(await Promise.all(
      streamingProviderManager.getAllStreamingProviders().map(async (candidate) => ([
        candidate.id,
        candidate.id !== provider.id && await providerConnectedForPreference(candidate),
      ] as const)),
    ));
    const repairedPreference = buildProviderPreferenceAfterDisconnect(
      streamingProviderManager.getProviderPriority(),
      provider.id,
      (providerId) => connectedByProvider.get(providerId) === true,
    );
    let plansPendingCuration = false;
    if (repairedPreference) {
      updateConfig("streaming", {
        ...Config.getStreamingConfig(),
        provider_priority: repairedPreference.providerPriority,
        default_provider: repairedPreference.defaultProviderId,
      });
      markAcquisitionPlanningStale();
      plansPendingCuration = true;
    }

    res.json({
      success: true,
      provider: provider.id,
      ...(repairedPreference ?? {}),
      ...(plansPendingCuration ? { plansPendingCuration: true } : {}),
    });
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
