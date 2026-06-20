/**
 * Catalog-source abstraction barrel — see `docs/DATA_MODEL_TARGET.md` §3.
 *
 * U3 scaffolding: additive, NOT wired into the live request path. The live app
 * still calls `skyHookProxy` directly. Importing this barrel has no side effects
 * and performs no network/DB I/O.
 *
 * The `catalogProviderRegistry` mirrors `streamingProviderManager`'s shape so a
 * future unit can flip the active catalog source via config (SkyHook ↔ MB-local)
 * without touching call sites. Today only `SkyhookCatalogProvider` is
 * registered; `LocalMusicBrainzCatalogProvider` is constructed on demand and is
 * deliberately left unregistered until MB-local mode is provisioned.
 */
import type { CatalogProvider } from "./catalog-provider.js";
import { skyhookCatalogProvider } from "./skyhook-catalog-provider.js";

export * from "./catalog-provider.js";
export { SkyhookCatalogProvider, skyhookCatalogProvider } from "./skyhook-catalog-provider.js";
export {
  LocalMusicBrainzCatalogProvider,
  createLocalMusicBrainzCatalogProvider,
} from "./local-musicbrainz-catalog-provider.js";
export * from "./musicbrainz-ws-mapping.js";
export * from "./musicbrainz-postgres-queries.js";
export { MusicBrainzPostgresCatalogReader } from "./musicbrainz-postgres-client.js";
export type { PgPool, PgQueryResult } from "./musicbrainz-postgres-client.js";

class CatalogProviderRegistry {
  private readonly providers = new Map<string, CatalogProvider>();
  // Active source — SkyHook today. MB-local flips this once provisioned.
  private activeId = "skyhook";

  constructor() {
    this.register(skyhookCatalogProvider);
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
   * The currently-active catalog source. Returns SkyHook until MB-local mode is
   * wired. NOT consulted by the live request path yet.
   */
  getActive(): CatalogProvider {
    return this.get(this.activeId);
  }
}

export const catalogProviderRegistry = new CatalogProviderRegistry();
