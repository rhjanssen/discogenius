export interface JellyfinLibraryItem {
  id: string;
  name: string;
  type: string;
  path?: string;
  musicBrainzId: string | null;
}

const REQUEST_TIMEOUT_MS = 15_000;

export class JellyfinClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
    this.apiKey = apiKey.trim();
  }

  private async request<T = unknown>(
    method: "GET" | "POST",
    endpointPath: string,
    body?: unknown,
  ): Promise<T | null> {
    if (!this.baseUrl || !this.apiKey) {
      throw new Error("Jellyfin URL and API key are required");
    }
    const url = `${this.baseUrl}${endpointPath}`;
    const response = await fetch(url, {
      method,
      headers: {
        "X-Emby-Token": this.apiKey,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Jellyfin ${method} ${endpointPath} failed with HTTP ${response.status}`);
    }
    const text = await response.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  /** Targeted path update notification (avoids full library scan). */
  async notifyPathUpdated(
    folderPath: string,
    updateType: "Created" | "Modified" | "Deleted" = "Modified",
  ): Promise<void> {
    await this.request("POST", "/Library/Media/Updated", {
      Updates: [{ Path: folderPath, UpdateType: updateType }],
    });
  }

  async listMusicItems(itemType: "MusicArtist" | "MusicAlbum"): Promise<JellyfinLibraryItem[]> {
    const data = await this.request<{
      Items?: Array<{
        Id?: string;
        Name?: string;
        Type?: string;
        Path?: string;
        ProviderIds?: Record<string, string | undefined>;
      }>;
    }>("GET", `/Items?Recursive=true&IncludeItemTypes=${itemType}&Fields=ProviderIds,Path`);

    const items = data?.Items ?? [];
    return items
      .filter((item) => typeof item.Id === "string" && item.Id.length > 0)
      .map((item) => {
        const providerIds = item.ProviderIds ?? {};
        const mbid = providerIds.MusicBrainzAlbum ?? providerIds.MusicBrainzArtist ?? providerIds.MusicBrainzReleaseGroup ?? null;
        return {
          id: item.Id!,
          name: String(item.Name ?? ""),
          type: String(item.Type ?? itemType),
          path: item.Path,
          musicBrainzId: mbid ? mbid.toLowerCase() : null,
        };
      });
  }

  async refreshItem(itemId: string): Promise<void> {
    const encodedId = encodeURIComponent(itemId);
    await this.request(
      "POST",
      `/Items/${encodedId}/Refresh?Recursive=true&MetadataRefreshMode=Default&ImageRefreshMode=Default`,
    );
  }
}
