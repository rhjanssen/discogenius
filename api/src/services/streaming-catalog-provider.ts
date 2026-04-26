import { loadToken, searchTidal } from "./tidal.js";

export const STREAMING_CATALOG_SEARCH_TYPES = ["artists", "albums", "tracks", "videos"] as const;
export type StreamingCatalogSearchType = (typeof STREAMING_CATALOG_SEARCH_TYPES)[number];
export type StreamingCatalogProviderId = "tidal" | "apple_music" | (string & {});

export interface StreamingCatalogProvider {
  id: StreamingCatalogProviderId;
  hasRemoteAuth(): boolean;
  search(query: string, types: StreamingCatalogSearchType[], limit: number): Promise<any[]>;
}

export const tidalCatalogProvider: StreamingCatalogProvider = {
  id: "tidal",
  hasRemoteAuth() {
    return Boolean(loadToken()?.access_token);
  },
  search(query, types, limit) {
    return searchTidal(query, types, limit);
  },
};

export function getDefaultStreamingCatalogProvider(): StreamingCatalogProvider {
  return tidalCatalogProvider;
}
