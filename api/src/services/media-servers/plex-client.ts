export interface PlexSection {
  key: string;
  title: string;
  type: string;
  locations: string[];
}

export interface PlexLibraryItem {
  ratingKey: string;
  title: string;
  parentRatingKey?: string;
  parentTitle?: string;
  guid: string;
  guids: string[];
  locations: string[];
}

const REQUEST_TIMEOUT_MS = 15_000;

export function extractMusicBrainzIdFromPlexGuids(guid: string | undefined, guids: string[]): string | null {
  const candidates = [guid, ...guids].filter((v): v is string => typeof v === "string" && v.length > 0);
  for (const raw of candidates) {
    const mbidMatch = /(?:mbid:\/\/|musicbrainz:\/\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(raw);
    if (mbidMatch) return mbidMatch[1].toLowerCase();
  }
  return null;
}

export function isLocalPlexGuid(guid: string | undefined): boolean {
  return !guid || guid.startsWith("local://");
}

function normalizeLocations(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string") {
      out.push((entry as { path: string }).path);
    }
  }
  return out;
}

function normalizeGuids(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
      out.push((entry as { id: string }).id);
    }
  }
  return out;
}

export class PlexClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
    this.token = token.trim();
  }

  private async request<T = unknown>(
    method: "GET" | "PUT" | "POST",
    endpointPath: string,
  ): Promise<T | null> {
    if (!this.baseUrl || !this.token) {
      throw new Error("Plex URL and token are required");
    }
    const url = `${this.baseUrl}${endpointPath}`;
    const response = await fetch(url, {
      method,
      headers: {
        "X-Plex-Token": this.token,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Plex ${method} ${endpointPath} failed with HTTP ${response.status}`);
    }
    const text = await response.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  async getMusicSections(): Promise<PlexSection[]> {
    const data = await this.request<{
      MediaContainer?: {
        Directory?: Array<{
          key?: string | number;
          title?: string;
          type?: string;
          Location?: Array<{ path?: string }>;
        }>;
      };
    }>("GET", "/library/sections");
    const dirs = data?.MediaContainer?.Directory ?? [];
    return dirs
      .filter((d) => d.type === "artist" && d.key != null)
      .map((d) => ({
        key: String(d.key),
        title: String(d.title ?? "Music"),
        type: String(d.type ?? "artist"),
        locations: normalizeLocations(d.Location),
      }));
  }

  /** Targeted folder scan (never triggers a full library scan unless folderPath is empty). */
  async scanFolder(sectionId: string, folderPath: string): Promise<void> {
    const encodedSection = encodeURIComponent(sectionId);
    const encodedPath = encodeURIComponent(folderPath);
    await this.request("GET", `/library/sections/${encodedSection}/refresh?path=${encodedPath}`);
  }

  async listArtists(sectionId: string): Promise<PlexLibraryItem[]> {
    return this.listByType(sectionId, 8);
  }

  async listAlbums(sectionId: string): Promise<PlexLibraryItem[]> {
    return this.listByType(sectionId, 9);
  }

  private async listByType(sectionId: string, type: 8 | 9): Promise<PlexLibraryItem[]> {
    const encodedSection = encodeURIComponent(sectionId);
    const data = await this.request<{
      MediaContainer?: {
        Metadata?: Array<{
          ratingKey?: string | number;
          title?: string;
          parentRatingKey?: string | number;
          parentTitle?: string;
          guid?: string;
          Guid?: Array<{ id?: string }>;
          Location?: Array<{ path?: string }>;
        }>;
      };
    }>("GET", `/library/sections/${encodedSection}/all?type=${type}&includeGuids=1`);

    const metadata = data?.MediaContainer?.Metadata ?? [];
    return metadata
      .filter((item) => item.ratingKey != null)
      .map((item) => ({
        ratingKey: String(item.ratingKey),
        title: String(item.title ?? ""),
        parentRatingKey: item.parentRatingKey != null ? String(item.parentRatingKey) : undefined,
        parentTitle: item.parentTitle,
        guid: String(item.guid ?? ""),
        guids: normalizeGuids(item.Guid),
        locations: normalizeLocations(item.Location),
      }));
  }

  async mergeItems(sectionId: string, targetRatingKey: string, sourceRatingKeys: string[]): Promise<void> {
    if (sourceRatingKeys.length === 0) return;
    const encodedSection = encodeURIComponent(sectionId);
    const ids = [targetRatingKey, ...sourceRatingKeys].map((id) => encodeURIComponent(id)).join(",");
    await this.request("PUT", `/library/sections/${encodedSection}/merge?ids=${ids}`);
  }

  async fixMatch(ratingKey: string, mbid: string, name?: string): Promise<void> {
    const encodedKey = encodeURIComponent(ratingKey);
    const guid = encodeURIComponent(`mbid://${mbid}`);
    const params = new URLSearchParams({ guid: `mbid://${mbid}` });
    if (name) params.set("name", name);
    void guid;
    await this.request("PUT", `/library/metadata/${encodedKey}/match?${params.toString()}`);
  }

  async refreshItem(ratingKey: string): Promise<void> {
    const encodedKey = encodeURIComponent(ratingKey);
    await this.request("PUT", `/library/metadata/${encodedKey}/refresh`);
  }
}
