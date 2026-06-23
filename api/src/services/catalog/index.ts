/**
 * Catalog-source abstraction barrel — see `docs/DATA_MODEL_TARGET.md` §3.
 *
 * U3 scaffolding: additive, NOT wired into the live request path. The live app
 * still calls `ServarrMetadataProxy` directly. Importing this barrel has no side effects
 * and performs no network/DB I/O.
 *
 * The `catalogProviderRegistry` mirrors `streamingProviderManager`'s shape so a
 * future unit can flip the active catalog source via config (Servarr Metadata Server ↔ MB-local)
 * without touching call sites. Today only `ServarrMetadataCatalogProvider` is
 * registered; `LocalMusicBrainzCatalogProvider` is constructed on demand and is
 * deliberately left unregistered until MB-local mode is provisioned.
 */
import type { CatalogProvider } from "./catalog-provider.js";
import { servarrMetadataCatalogProvider } from "./servarr-metadata-catalog-provider.js";

export * from "./catalog-provider.js";
export { ServarrMetadataCatalogProvider, servarrMetadataCatalogProvider } from "./servarr-metadata-catalog-provider.js";
export {
  LocalMusicBrainzCatalogProvider,
  createLocalMusicBrainzCatalogProvider,
} from "./local-musicbrainz-catalog-provider.js";
export * from "./musicbrainz-ws-mapping.js";

class CatalogProviderRegistry {
  private readonly providers = new Map<string, CatalogProvider>();
  // Active source — Servarr Metadata Server today. MB-local flips this once provisioned.
  private activeId = "servarr-metadata";

  constructor() {
    this.register(servarrMetadataCatalogProvider);
  }

  register(provider: CatalogProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): CatalogProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(`catalog provider not found: ${id}`);
    }
    return provider;
  }

  getAll(): CatalogProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * The currently-active catalog source. Returns Servarr Metadata Server until MB-local mode is
   * wired. NOT consulted by the live request path yet.
   */
  getActive(): CatalogProvider {
    return this.get(this.activeId);
  }
}

export const catalogProviderRegistry = new CatalogProviderRegistry();
