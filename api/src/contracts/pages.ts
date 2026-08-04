import { expectNullableString, expectRecord } from "./runtime.js";
import type { AlbumContract } from "./catalog.js";
import { parseAlbumContract } from "./catalog.js";
import type {
  AlbumAssociatedVideoContract,
  AlbumTrackContract,
  AlbumVersionContract,
} from "./media.js";
import {
  parseAlbumAssociatedVideosContract,
  parseAlbumTracksContract,
  parseAlbumVersionsContract,
} from "./media.js";

export interface TrackListTabContract {
  editionId: number;
  releaseMbid: string;
  title: string;
  disambiguation: string | null;
  country: string | null;
  mediaFormats: string[];
  trackCount: number | null;
  default: boolean;
}

export interface AlbumPageContract {
  album: AlbumContract;
  tracks: AlbumTrackContract[];
  otherVersions: AlbumVersionContract[];
  /** Videos linked to this release group's tracks (provider_video_for / on-RG). */
  associatedVideos?: AlbumAssociatedVideoContract[];
  artistPicture: string | null;
  artistCoverImageUrl: string | null;
  trackListTabs?: TrackListTabContract[];
  initialTrackListEditionId?: number;
}

export function parseTrackListTabContract(value: unknown): TrackListTabContract {
  const record = expectRecord(value, "Track list tab");
  return {
    editionId: Number(record.editionId ?? record.id),
    releaseMbid: String(record.releaseMbid || ""),
    title: String(record.title || ""),
    disambiguation: expectNullableString(record.disambiguation, "trackListTab.disambiguation") ?? null,
    country: expectNullableString(record.country, "trackListTab.country") ?? null,
    mediaFormats: Array.isArray(record.mediaFormats) ? record.mediaFormats.map(String) : [],
    trackCount: record.trackCount != null ? Number(record.trackCount) : null,
    default: Boolean(record.default),
  };
}

export function parseAlbumPageContract(value: unknown): AlbumPageContract {
  const record = expectRecord(value, "Album page");

  return {
    album: parseAlbumContract(record.album, 0),
    tracks: parseAlbumTracksContract(record.tracks),
    otherVersions: parseAlbumVersionsContract(record.otherVersions),
    associatedVideos: record.associatedVideos === undefined
      ? undefined
      : parseAlbumAssociatedVideosContract(record.associatedVideos),
    artistPicture: expectNullableString(record.artistPicture, "albumPage.artistPicture") ?? null,
    artistCoverImageUrl: expectNullableString(record.artistCoverImageUrl, "albumPage.artistCoverImageUrl") ?? null,
    trackListTabs: record.trackListTabs === undefined
      ? undefined
      : (Array.isArray(record.trackListTabs) ? record.trackListTabs.map(parseTrackListTabContract) : []),
    initialTrackListEditionId: record.initialTrackListEditionId != null ? Number(record.initialTrackListEditionId) : undefined,
  };
}
