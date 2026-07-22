import type {
  ProviderArtist,
  ProviderImportSelection,
  ProviderImportSource,
  ProviderImportSourceList,
} from "../streaming-provider.js";
import { appleMusicApiRequest, storefrontFor, type AppleMusicApiOptions } from "./apple-music-api.js";
import { mapAppleArtist, mapAppleTrack, renderAppleArtwork } from "./apple-music-catalog.js";

interface AppleResource<A = Record<string, unknown>> {
  id: string;
  type: string;
  href?: string;
  attributes?: A;
  relationships?: Record<string, { data?: AppleResource[] }>;
}

interface AppleDataResponse<A = Record<string, unknown>> {
  data?: AppleResource<A>[];
  next?: string;
}

interface AppleArtwork {
  url?: string;
  width?: number;
  height?: number;
}

function nextEndpoint(next: string | undefined): string | null {
  const value = String(next || "").trim();
  if (!value) {
    return null;
  }
  if (value.startsWith("http") || value.startsWith("/")) {
    return value;
  }
  return `/${value.replace(/^\/+/, "")}`;
}

async function fetchAllPages<A>(
  firstEndpoint: string,
  options: AppleMusicApiOptions,
  maxPages = 20,
): Promise<AppleResource<A>[]> {
  const rows: AppleResource<A>[] = [];
  let endpoint: string | null = firstEndpoint;
  let pages = 0;
  while (endpoint && pages < maxPages) {
    const response = await appleMusicApiRequest<AppleDataResponse<A>>(endpoint, options);
    rows.push(...(response.data ?? []));
    endpoint = nextEndpoint(response.next);
    pages += 1;
  }
  return rows;
}

function resourceCatalogRelationship(resource: AppleResource): AppleResource | null {
  return resource.relationships?.catalog?.data?.[0] ?? null;
}

function normalizeNameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function mapLibraryArtist(resource: AppleResource): ProviderArtist {
  const catalogArtist = resourceCatalogRelationship(resource);
  if (catalogArtist?.type === "artists") {
    const artist = mapAppleArtist(catalogArtist);
    return {
      ...artist,
      raw: { library: resource, catalog: catalogArtist },
    };
  }

  const attrs = (resource.attributes ?? {}) as {
    name?: string;
    artistName?: string;
    url?: string;
    artwork?: AppleArtwork;
  };
  const name = attrs.name || attrs.artistName || "Unknown Artist";
  return {
    providerId: String(resource.id || `library-artist:${normalizeNameKey(name)}`),
    name,
    picture: renderAppleArtwork(attrs.artwork, 750),
    url: attrs.url,
    raw: resource,
  };
}

function uniqueArtists(artists: ProviderArtist[]): ProviderArtist[] {
  const seen = new Set<string>();
  const result: ProviderArtist[] = [];
  for (const artist of artists) {
    const key = artist.providerId
      ? `id:${artist.providerId}`
      : `name:${normalizeNameKey(artist.name)}`;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(artist);
  }
  return result;
}

/** Apple playlist descriptions are often multi-paragraph editorial copy — keep list rows short. */
const IMPORT_LIST_SUBTITLE_MAX = 96;

function appleDescriptionText(description: { standard?: string } | string | undefined): string | null {
  if (typeof description === "string") {
    return description;
  }
  return description?.standard || null;
}

function trackCountSubtitle(trackCount: number | undefined): string | null {
  if (typeof trackCount !== "number" || !Number.isFinite(trackCount) || trackCount < 0) {
    return null;
  }
  return `${trackCount} track${trackCount === 1 ? "" : "s"}`;
}

/**
 * List-row subtitle candidate: strip HTML, take the first line, omit multi-paragraph
 * editorial blobs, and truncate leftover single-line copy.
 */
export function shortImportListSubtitle(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const withBreaks = String(raw)
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  const lines = withBreaks
    .split(/\r?\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }
  // Multi-paragraph / multi-line editorial (e.g. Made for You magazine copy) — omit.
  if (lines.length > 1) {
    return null;
  }
  const text = lines[0];
  if (text.length > IMPORT_LIST_SUBTITLE_MAX) {
    return `${text.slice(0, IMPORT_LIST_SUBTITLE_MAX - 1).trimEnd()}…`;
  }
  return text;
}

function mapPlaylistList(resource: AppleResource): ProviderImportSourceList {
  const attrs = (resource.attributes ?? {}) as {
    name?: string;
    description?: { standard?: string } | string;
    artwork?: AppleArtwork;
    trackCount?: number;
  };
  return {
    id: resource.id,
    title: attrs.name || "Apple Music playlist",
    subtitle: shortImportListSubtitle(appleDescriptionText(attrs.description)) || trackCountSubtitle(attrs.trackCount),
    image: renderAppleArtwork(attrs.artwork, 320),
    itemCount: attrs.trackCount ?? null,
  };
}

function mapRecommendationList(
  recommendation: AppleResource,
  includedById: Map<string, AppleResource>,
): ProviderImportSourceList | null {
  const playlistRef = recommendation.relationships?.contents?.data?.find((entry) => entry.type === "playlists");
  if (!playlistRef?.id) return null;
  const playlist = includedById.get(playlistRef.id) ?? playlistRef;
  const attrs = (playlist.attributes ?? {}) as {
    name?: string;
    description?: { standard?: string } | string;
    artwork?: AppleArtwork;
    trackCount?: number;
  };
  const recommendationAttrs = (recommendation.attributes ?? {}) as {
    title?: string;
    reason?: { stringForDisplay?: string };
  };
  return {
    id: playlistRef.id,
    title: attrs.name || recommendationAttrs.title || "Apple Music mix",
    subtitle:
      shortImportListSubtitle(recommendationAttrs.reason?.stringForDisplay)
      || shortImportListSubtitle(appleDescriptionText(attrs.description))
      || trackCountSubtitle(attrs.trackCount),
    image: renderAppleArtwork(attrs.artwork, 320),
    itemCount: attrs.trackCount ?? null,
  };
}

function artistFromTrackResource(resource: AppleResource): ProviderArtist | null {
  const catalog = resourceCatalogRelationship(resource);
  if (catalog?.type === "songs") {
    const track = mapAppleTrack(catalog);
    return track.artist;
  }
  if (resource.type === "songs") {
    const track = mapAppleTrack(resource);
    return track.artist;
  }

  const directArtist = resource.relationships?.artists?.data?.[0];
  if (directArtist?.type === "artists") {
    return mapAppleArtist(directArtist);
  }

  const attrs = (resource.attributes ?? {}) as { artistName?: string };
  if (!attrs.artistName) {
    return null;
  }
  return {
    providerId: `library-artist:${normalizeNameKey(attrs.artistName)}`,
    name: attrs.artistName,
    raw: resource,
  };
}

export async function getAppleImportSources(options: AppleMusicApiOptions = {}): Promise<ProviderImportSource[]> {
  const sources: ProviderImportSource[] = [
    {
      category: "library-artists",
      label: "Library artists",
      description: "Artists from your Apple Music library",
      requiresListSelection: false,
    },
    {
      category: "favorite-tracks",
      label: "Library songs",
      description: "Distinct artists from songs saved in your Apple Music library",
      requiresListSelection: false,
    },
  ];

  try {
    const playlists = await fetchAllPages<Record<string, unknown>>("/v1/me/library/playlists?limit=100", options, 10);
    if (playlists.length > 0) {
      sources.push({
        category: "playlist",
        label: "Playlists",
        description: "Artists from an Apple Music playlist",
        requiresListSelection: true,
        lists: playlists.map(mapPlaylistList),
      });
    }
  } catch (error) {
    console.warn("[AppleMusicProvider] Failed to list library playlists for import:", error);
  }

  try {
    const response = await appleMusicApiRequest<{
      data?: AppleResource[];
      included?: AppleResource[];
    }>("/v1/me/recommendations?limit=25&include=contents", options);
    const includedById = new Map((response.included ?? []).map((resource) => [resource.id, resource]));
    const lists = (response.data ?? [])
      .map((entry) => mapRecommendationList(entry, includedById))
      .filter((entry): entry is ProviderImportSourceList => Boolean(entry));
    if (lists.length > 0) {
      sources.push({
        category: "mix",
        label: "Made for You",
        description: "Artists from an Apple Music personalized mix or recommendation playlist",
        requiresListSelection: true,
        lists,
      });
    }
  } catch (error) {
    console.warn("[AppleMusicProvider] Failed to list Apple Music recommendations for import:", error);
  }

  return sources;
}

export async function getAppleArtistsForImportSource(
  selection: ProviderImportSelection,
  options: AppleMusicApiOptions = {},
): Promise<ProviderArtist[]> {
  if (selection.category === "library-artists") {
    const artists = await fetchAllPages<Record<string, unknown>>("/v1/me/library/artists?limit=100&include=catalog", options);
    return uniqueArtists(artists.map(mapLibraryArtist));
  }

  if (selection.category === "favorite-tracks") {
    const tracks = await fetchAllPages<Record<string, unknown>>("/v1/me/library/songs?limit=100&include=catalog", options);
    return uniqueArtists(tracks.map(artistFromTrackResource).filter((artist): artist is ProviderArtist => Boolean(artist)));
  }

  if (selection.category === "playlist") {
    if (!selection.listId) {
      throw new Error("An Apple Music playlist must be selected");
    }
    const tracks = await fetchAllPages<Record<string, unknown>>(
      `/v1/me/library/playlists/${encodeURIComponent(selection.listId)}/tracks?limit=100&include=catalog`,
      options,
    );
    return uniqueArtists(tracks.map(artistFromTrackResource).filter((artist): artist is ProviderArtist => Boolean(artist)));
  }

  if (selection.category === "mix") {
    if (!selection.listId) {
      throw new Error("An Apple Music mix playlist must be selected");
    }
    const storefront = storefrontFor(options.token);
    const tracks = await fetchAllPages<Record<string, unknown>>(
      `/v1/catalog/${storefront}/playlists/${encodeURIComponent(selection.listId)}/tracks?limit=100&include=artists`,
      options,
    );
    return uniqueArtists(tracks.map(artistFromTrackResource).filter((artist): artist is ProviderArtist => Boolean(artist)));
  }

  throw new Error(`Apple Music does not support import source: ${selection.category}`);
}
