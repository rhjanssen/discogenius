import type { StreamingProvider } from "./types.js";
import { tidalStreamingProvider } from "../services/providers/tidal/tidal-provider.js";
import { appleMusicStreamingProvider } from "../services/providers/apple-music/apple-music-provider.js";
import { amazonMusicStreamingProvider } from "../services/providers/amazon-music/amazon-music-provider.js";
import { deezerStreamingProvider } from "../services/providers/deezer/deezer-provider.js";
import { soundcloudStreamingProvider } from "../services/providers/soundcloud/soundcloud-provider.js";
import { spotifyStreamingProvider } from "../services/providers/spotify/spotify-provider.js";
import { youtubeMusicStreamingProvider } from "../services/providers/youtube-music/youtube-music-provider.js";
import { Config } from "../services/config/config.js";

const FALLBACK_DEFAULT_PROVIDER_ID = "tidal";

/**
 * Compile-time streaming provider registry.
 *
 * Lives at `api/src/providers/` (2.6 modularity phase 1) so core code can depend
 * on registry + types without importing provider-private modules. Concrete
 * adapters remain under `services/providers/<id>/` until incremental moves.
 */
class StreamingProviderManager {
  private readonly providers = new Map<string, StreamingProvider>();
  private readonly registrationOrder: string[] = [];

  constructor() {
    // Registration order is the factory default preference when
    // `streaming.provider_priority` is unset (first = most preferred).
    // Saved user order in config overrides this.
    // SoundCloud sits after Deezer (another lossy/catalog-friendly source) and
    // before YouTube Music / Amazon / Spotify so experimental SC offers do not
    // outrank the primary storefronts by default.
    this.registerStreamingProvider(tidalStreamingProvider);
    this.registerStreamingProvider(appleMusicStreamingProvider);
    this.registerStreamingProvider(deezerStreamingProvider);
    this.registerStreamingProvider(soundcloudStreamingProvider);
    this.registerStreamingProvider(youtubeMusicStreamingProvider);
    this.registerStreamingProvider(amazonMusicStreamingProvider);
    this.registerStreamingProvider(spotifyStreamingProvider);
  }

  registerStreamingProvider(provider: StreamingProvider): void {
    if (!this.providers.has(provider.id)) {
      this.registrationOrder.push(provider.id);
    }
    this.providers.set(provider.id, provider);
  }

  getStreamingProvider(id: string): StreamingProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(`provider not found: ${id}`);
    }
    return provider;
  }

  getAllStreamingProviders(): StreamingProvider[] {
    return Array.from(this.providers.values());
  }

  async syncProviderSettings(downloadPath?: string): Promise<void> {
    for (const provider of this.providers.values()) {
      if (provider.syncSettings) {
        await provider.syncSettings(downloadPath);
      }
    }
  }

  async syncProviderCredentials(): Promise<void> {
    for (const provider of this.providers.values()) {
      if (provider.syncCredentials) {
        await provider.syncCredentials();
      }
    }
  }

  getDefaultProviderId(): string {
    let configured: string | undefined;
    try {
      configured = Config.getStreamingConfig().default_provider?.trim() || undefined;
    } catch {
      configured = undefined;
    }
    if (configured && this.providers.has(configured)) {
      return configured;
    }
    if (configured) {
      throw new Error(`configured default provider is not registered: ${configured}`);
    }
    if (this.providers.has(FALLBACK_DEFAULT_PROVIDER_ID)) {
      return FALLBACK_DEFAULT_PROVIDER_ID;
    }
    return this.registrationOrder[0] ?? FALLBACK_DEFAULT_PROVIDER_ID;
  }

  getDefaultStreamingProvider(): StreamingProvider {
    return this.getStreamingProvider(this.getDefaultProviderId());
  }

  /**
   * User-ordered provider preference (first = most preferred). Configured via
   * `streaming.provider_priority`; unknown ids are dropped and unlisted
   * registered providers append in registration order. Without a configured
   * list, the default provider leads and the rest follow registration order.
   */
  getProviderPriority(): string[] {
    let configured: string[] = [];
    try {
      configured = (Config.getStreamingConfig().provider_priority || [])
        .map((id) => String(id || "").trim())
        .filter((id) => this.providers.has(id));
    } catch {
      configured = [];
    }
    const priority = [...new Set(configured)];
    const defaultId = this.getDefaultProviderId();
    if (!priority.includes(defaultId)) {
      priority.push(defaultId);
    }
    for (const id of this.registrationOrder) {
      if (!priority.includes(id)) {
        priority.push(id);
      }
    }
    return priority;
  }

  /** Rank for tie-breaks: lower = more preferred; unknown providers rank last. */
  getProviderPreferenceRank(providerId: string): number {
    const priority = this.getProviderPriority();
    const index = priority.indexOf(String(providerId || "").trim());
    return index === -1 ? priority.length : index;
  }

  /**
   * Human-facing provider label for naming tokens / conflict messages.
   * Uses each provider's registered `name` (not a hardcoded map).
   */
  getProviderDisplayName(providerId: string | null | undefined): string {
    const raw = String(providerId || "").trim();
    if (!raw) return "Unknown";
    const lower = raw.toLowerCase();
    const aliases: Record<string, string> = {
      apple: "apple-music",
      applemusic: "apple-music",
      youtube: "youtube-music",
      youtubemusic: "youtube-music",
      amazon: "amazon-music",
      amazonmusic: "amazon-music",
      sc: "soundcloud",
    };
    const resolvedId = aliases[lower] || lower;
    try {
      return this.getStreamingProvider(resolvedId).name;
    } catch {
      return raw.charAt(0).toUpperCase() + raw.slice(1);
    }
  }
}

export const streamingProviderManager = new StreamingProviderManager();
