import { expectNullableString, expectRecord } from "./runtime.js";
import type { AlbumContract } from "./catalog.js";
import { parseAlbumContract } from "./catalog.js";
import type {
  AlbumTrackContract,
  AlbumVersionContract,
  SimilarAlbumContract,
} from "./media.js";
import {
  parseAlbumTracksContract,
  parseAlbumVersionsContract,
  parseSimilarAlbumsContract,
} from "./media.js";

export interface AlbumPageContract {
  album: AlbumContract;
  tracks: AlbumTrackContract[];
  similarAlbums: SimilarAlbumContract[];
  otherVersions: AlbumVersionContract[];
  artistPicture: string | null;
  artistCoverImageUrl: string | null;
}

export function parseAlbumPageContract(value: unknown): AlbumPageContract {
  const record = expectRecord(value, "Album page");

  return {
    album: parseAlbumContract(record.album, 0),
    tracks: parseAlbumTracksContract(record.tracks),
    similarAlbums: parseSimilarAlbumsContract(record.similarAlbums),
    otherVersions: parseAlbumVersionsContract(record.otherVersions),
    artistPicture: expectNullableString(record.artistPicture, "albumPage.artistPicture") ?? null,
    artistCoverImageUrl: expectNullableString(record.artistCoverImageUrl, "albumPage.artistCoverImageUrl") ?? null,
  };
}
