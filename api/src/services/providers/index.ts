import type { StreamingProvider } from "./streaming-provider.js";
import { tidalStreamingProvider } from "./tidal/tidal-provider.js";

class StreamingProviderManager {
  private readonly providers = new Map<string, StreamingProvider>();

  constructor() {
    this.registerStreamingProvider(tidalStreamingProvider);
  }

  registerStreamingProvider(provider: StreamingProvider): void {
    this.providers.set(provider.id, provider);
  }

  getStreamingProvider(id: string): StreamingProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(`Provider not found: ${id}`);
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

  getDefaultStreamingProvider(): StreamingProvider {
    return this.getStreamingProvider("tidal");
  }
}

export const streamingProviderManager = new StreamingProviderManager();
