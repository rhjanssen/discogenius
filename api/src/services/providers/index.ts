import type { StreamingProvider } from "./streaming-provider.js";
import { tidalStreamingProvider } from "./tidal/tidal-provider.js";
import { appleMusicStreamingProvider } from "./apple-music/apple-music-provider.js";
import { Config } from "../config/config.js";

const FALLBACK_DEFAULT_PROVIDER_ID = "tidal";

class StreamingProviderManager {
  private readonly providers = new Map<string, StreamingProvider>();
  private readonly registrationOrder: string[] = [];

  constructor() {
    this.registerStreamingProvider(tidalStreamingProvider);
    this.registerStreamingProvider(appleMusicStreamingProvider);
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
}

export const streamingProviderManager = new StreamingProviderManager();
