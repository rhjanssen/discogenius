/**
 * Catalog-source abstraction barrel — see `docs/DATA_MODEL_TARGET.md` §3.
 *
 * Runtime-wired catalog provider registry. The active source is resolved from
 * config and can be refreshed after Settings changes without a restart.
 *
 * The `catalogProviderRegistry` mirrors `streamingProviderManager`'s shape so a
 * The Servarr provider is always registered. The MusicBrainz-local provider is
 * constructed on demand from the configured host so its Postgres pool follows
 * Settings/env changes.
 */
import type { CatalogProvider } from "./catalog-provider.js";
import { servarrMetadataCatalogProvider } from "./servarr-metadata-catalog-provider.js";
import { createPostgresMusicBrainzCatalogProvider, PostgresMusicBrainzCatalogProvider } from "./postgres-musicbrainz-catalog-provider.js";
import { getConfigSection } from "../config/config.js";
import { buildMbPostgresDsn, buildMbSearchWebUrl } from "./mb-connection.js";

export * from "./catalog-provider.js";
export { ServarrMetadataCatalogProvider, servarrMetadataCatalogProvider } from "./servarr-metadata-catalog-provider.js";
export {
  LocalMusicBrainzCatalogProvider,
  createLocalMusicBrainzCatalogProvider,
} from "./local-musicbrainz-catalog-provider.js";
export * from "./musicbrainz-ws-mapping.js";

const SERVARR_SOURCE_ID = "servarr-metadata";
const MUSICBRAINZ_SOURCE_ID = "musicbrainz-local";

class CatalogProviderRegistry {
  private readonly providers = new Map<string, CatalogProvider>();
  // Active source, resolved from config (`catalog.source`). Defaults to the
  // Servarr Metadata Server; `refreshFromConfig()` flips it to the local
  // MusicBrainz mirror when the user selects it.
  private activeId = SERVARR_SOURCE_ID;
  private musicBrainzHost: string | null = null;

  constructor() {
    this.register(servarrMetadataCatalogProvider);
    this.refreshFromConfig();
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
   * Re-resolve the active catalog source from `catalog.source` config. When
   * MusicBrainz is selected, (re)constructs the local MB provider bound to the
   * configured `musicbrainz_host` and registers it. Safe to call after a config
   * save so the change takes effect without a restart. Falls back to Servarr on
   * any read error so a bad config never leaves the app without a catalog source.
   */
  refreshFromConfig(): void {
    try {
      const cfg = getConfigSection("catalog");
      if (cfg.source === "musicbrainz") {
        if (!this.providers.has(MUSICBRAINZ_SOURCE_ID) || this.musicBrainzHost !== cfg.musicbrainz_host) {
          // Reconstructing on host change — close the previous pool first.
          const previous = this.providers.get(MUSICBRAINZ_SOURCE_ID);
          if (previous instanceof PostgresMusicBrainzCatalogProvider) {
            void previous.dispose().catch(() => { /* best effort */ });
          }
          this.register(createPostgresMusicBrainzCatalogProvider({
            connectionString: buildMbPostgresDsn(cfg.musicbrainz_host),
            searchWebUrl: buildMbSearchWebUrl(cfg.musicbrainz_host),
          }));
          this.musicBrainzHost = cfg.musicbrainz_host;
        }
        this.activeId = MUSICBRAINZ_SOURCE_ID;
      } else {
        this.activeId = SERVARR_SOURCE_ID;
      }
    } catch {
      this.activeId = SERVARR_SOURCE_ID;
    }
  }

  /** The currently-active catalog source (Servarr Metadata Server or MB-local). */
  getActive(): CatalogProvider {
    return this.get(this.activeId);
  }

  getActiveId(): string {
    return this.activeId;
  }
}

export const catalogProviderRegistry = new CatalogProviderRegistry();
