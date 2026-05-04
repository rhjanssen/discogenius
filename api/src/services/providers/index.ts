import type { IProvider } from "./provider-interface.js";
import { tidalProvider } from "./tidal/tidal-provider.js";

class ProviderManager {
  private readonly providers = new Map<string, IProvider>();

  constructor() {
    this.registerProvider(tidalProvider);
  }

  registerProvider(provider: IProvider): void {
    this.providers.set(provider.id, provider);
  }

  getProvider(id: string): IProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(`Provider not found: ${id}`);
    }
    return provider;
  }

  getAllProviders(): IProvider[] {
    return Array.from(this.providers.values());
  }

  getDefaultProvider(): IProvider {
    return this.getProvider("tidal");
  }
}

export const providerManager = new ProviderManager();
