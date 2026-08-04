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
  id: number;
  title: string;
  isRepresentative: boolean;
  isMonitored: boolean;
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
    id: Number(record.id),
    title: String(record.title || ""),
    isRepresentative: Boolean(record.isRepresentative),
    isMonitored: Boolean(record.isMonitored),
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
