import type {
  ProviderArtist,
  ProviderImportSelection,
  ProviderImportSource,
  ProviderImportSourceList,
} from "../streaming-provider.js";
import {
  createDeezerGwSession,
  deezerGwCall,
  type DeezerGwFetchLike,
  type DeezerGwSession,
} from "./deezer-gw-api.js";

type GwTrack = Record<string, unknown>;
type GwArtist = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function deezerPictureUrl(value: unknown, kind: "artist" | "cover" = "artist"): string | null {
  const raw = text(value);
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://e-cdns-images.dzcdn.net/images/${kind}/${raw}/500x500-000000-80-0-0.jpg`;
}

function mapGwArtist(raw: GwArtist): ProviderArtist | null {
  const providerId = String(raw.ART_ID ?? raw.id ?? "").trim();
  const name = text(raw.ART_NAME ?? raw.name);
  if (!providerId || !name) return null;
  return {
    providerId,
    name,
    picture: deezerPictureUrl(raw.ART_PICTURE ?? raw.picture, "artist") || null,
    url: `https://www.deezer.com/artist/${providerId}`,
    raw,
  };
}

function artistsFromGwTracks(tracks: GwTrack[]): ProviderArtist[] {
  const seen = new Set<string>();
  const artists: ProviderArtist[] = [];
  for (const track of tracks) {
    const candidates = [
      track,
      ...(Array.isArray(track.artists) ? track.artists as GwArtist[] : []),
      ...(Array.isArray(track.contributors) ? track.contributors as GwArtist[] : []),
    ];
    for (const candidate of candidates) {
      const artist = mapGwArtist(candidate);
      if (!artist || seen.has(artist.providerId)) continue;
      seen.add(artist.providerId);
      artists.push(artist);
    }
  }
  return artists;
}

function mapGwPlaylist(raw: GwTrack): ProviderImportSourceList | null {
  const id = String(raw.PLAYLIST_ID ?? raw.id ?? "").trim();
  const title = text(raw.TITLE ?? raw.title) || "Deezer playlist";
  if (!id) return null;
  return {
    id,
    title,
    subtitle: text(raw.DESCRIPTION ?? raw.description) || null,
    image: deezerPictureUrl(raw.PLAYLIST_PICTURE ?? raw.picture, "cover") || null,
    itemCount: Number(raw.NB_SONG ?? raw.nb_song ?? raw.NB_TRACK ?? raw.nb_tracks ?? 0) || null,
  };
}

async function fetchFavoriteArtists(session: DeezerGwSession, fetchImpl?: DeezerGwFetchLike): Promise<ProviderArtist[]> {
  const profile = await deezerGwCall(session, "deezer.pageProfile", {
    USER_ID: session.userId,
    tab: "artists",
    nb: 2000,
    lang: session.language,
  }, fetchImpl);
  const tab = profile.TAB as Record<string, unknown> | undefined;
  const artists = tab?.artists as Record<string, unknown> | undefined;
  const rows = Array.isArray(artists?.data) ? artists.data as GwArtist[] : [];
  return rows.map(mapGwArtist).filter((entry): entry is ProviderArtist => Boolean(entry));
}

async function fetchUserPlaylists(session: DeezerGwSession, fetchImpl?: DeezerGwFetchLike): Promise<ProviderImportSourceList[]> {
  const profile = await deezerGwCall(session, "deezer.pageProfile", {
    USER_ID: session.userId,
    tab: "playlists",
    nb: 200,
    lang: session.language,
  }, fetchImpl);
  const tab = profile.TAB as Record<string, unknown> | undefined;
  const playlists = tab?.playlists as Record<string, unknown> | undefined;
  const rows = Array.isArray(playlists?.data) ? playlists.data as GwTrack[] : [];
  return rows.map(mapGwPlaylist).filter((entry): entry is ProviderImportSourceList => Boolean(entry));
}

async function fetchFavoriteTracks(session: DeezerGwSession, fetchImpl?: DeezerGwFetchLike): Promise<GwTrack[]> {
  const idsPage = await deezerGwCall(session, "song.getFavoriteIds", { nb: 2000, start: 0 }, fetchImpl);
  const idRows = Array.isArray(idsPage.data) ? idsPage.data as GwTrack[] : [];
  // Some Deezer envelopes return bare numeric ids instead of `{ SNG_ID }` rows.
  const songIds = idRows
    .map((row) => {
      if (typeof row === "number" || typeof row === "string") return Number(row);
      return Number(row.SNG_ID ?? row.sng_id ?? 0);
    })
    .filter((value) => value > 0);
  if (songIds.length === 0) {
    // Loved-tracks playlist id is still useful when the id list is empty but the
    // playlist itself has songs (observed on some ARL sessions).
    const lovedPlaylistId = String(idsPage.playlist_id || "").trim();
    if (lovedPlaylistId) {
      return fetchPlaylistTracks(session, lovedPlaylistId, fetchImpl);
    }
    return [];
  }

  const tracksPage = await deezerGwCall(session, "song.getListData", { sng_ids: songIds }, fetchImpl);
  return Array.isArray(tracksPage.data) ? tracksPage.data as GwTrack[] : [];
}

async function fetchPlaylistTracks(
  session: DeezerGwSession,
  playlistId: string,
  fetchImpl?: DeezerGwFetchLike,
): Promise<GwTrack[]> {
  const page = await deezerGwCall(session, "deezer.pagePlaylist", {
    playlist_id: playlistId,
    lang: session.language,
    nb: 2000,
    start: 0,
    tab: 0,
    tags: true,
    header: true,
  }, fetchImpl);
  const songs = page.SONGS as Record<string, unknown> | undefined;
  return Array.isArray(songs?.data) ? songs.data as GwTrack[] : [];
}

export async function getDeezerImportSources(fetchImpl?: DeezerGwFetchLike): Promise<ProviderImportSource[]> {
  // Session bootstrap validates the ARL up front so callers get a clear auth
  // error instead of an empty source list.
  const session = await createDeezerGwSession(undefined, fetchImpl);
  const sources: ProviderImportSource[] = [
    {
      category: "followed-artists",
      label: "Favorite artists",
      description: "Artists you favorited on Deezer",
      requiresListSelection: false,
    },
    {
      category: "favorite-tracks",
      label: "Favorite tracks",
      description: "Distinct artists from your Deezer loved tracks",
      requiresListSelection: false,
    },
  ];

  try {
    const playlists = await fetchUserPlaylists(session, fetchImpl);
    if (playlists.length > 0) {
      sources.push({
        category: "playlist",
        label: "Playlists",
        description: "Artists from one of your Deezer playlists",
        requiresListSelection: true,
        lists: playlists,
      });
    }
  } catch (error) {
    console.warn("[DeezerProvider] Failed to list user playlists for import:", error);
  }

  // Deezer Flow is a continuous radio stream without a stable track list suitable
  // for artist import, so we intentionally omit a discovery/mix import source.

  return sources;
}

export async function getDeezerArtistsForImportSource(
  selection: ProviderImportSelection,
  fetchImpl?: DeezerGwFetchLike,
): Promise<ProviderArtist[]> {
  const session = await createDeezerGwSession(undefined, fetchImpl);

  if (selection.category === "followed-artists") {
    return fetchFavoriteArtists(session, fetchImpl);
  }

  if (selection.category === "favorite-tracks") {
    return artistsFromGwTracks(await fetchFavoriteTracks(session, fetchImpl));
  }

  if (selection.category === "playlist") {
    if (!selection.listId) {
      throw new Error("A Deezer playlist must be selected");
    }
    return artistsFromGwTracks(await fetchPlaylistTracks(session, selection.listId, fetchImpl));
  }

  throw new Error(`Deezer does not support import source: ${selection.category}`);
}
