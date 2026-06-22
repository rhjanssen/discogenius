/**
 * Pure mappers: MusicBrainz web-service (`/ws/2`, `fmt=json`) JSON → the
 * SkyHook/Lidarr DTOs the rest of Discogenius consumes.
 *
 * The local MB-docker `:5000` mirror serves the *same* JSON shape as
 * musicbrainz.org's `/ws/2` API (just without the 1-req/s limit), so this
 * mapping is what makes `LocalMusicBrainzCatalogProvider` a drop-in for SkyHook.
 *
 * These functions are deliberately side-effect-free and network-free so they can
 * be unit-tested against recorded fixture responses.
 *
 * Key shape differences handled here:
 *  - MB uses lower-case `id` for MBIDs; Lidarr DTOs use `Id` / `id`.
 *  - MB embeds `artist-credit` arrays; Lidarr flattens to an artist id + name.
 *  - MB release-group `first-release-date` ↔ Lidarr `releasedate` / `ReleaseDate`.
 *  - MB `media[].tracks[]` carry the recording inline; Lidarr `Tracks[]` flatten
 *    recording id + name + length onto the track.
 *  - MB track length is in ms (same as Lidarr `DurationMs`).
 */
import type {
  LidarrArtist,
  LidarrAlbum,
  LidarrReleaseGroupDetail,
  LidarrRelease,
  LidarrTrack,
} from "../metadata/skyhook-proxy.js";
import type { CatalogRecording } from "./catalog-provider.js";

/* ---- MB ws/2 response shapes (the subset we read) ---- */

export interface MbArtistCreditName {
  name?: string;
  joinphrase?: string;
  artist?: { id?: string; name?: string; "sort-name"?: string };
}

export interface MbReleaseGroupStub {
  id?: string;
  title?: string;
  "primary-type"?: string | null;
  "secondary-types"?: string[];
  "first-release-date"?: string | null;
  disambiguation?: string | null;
}

export interface MbArtist {
  id?: string;
  name?: string;
  "sort-name"?: string;
  disambiguation?: string | null;
  type?: string | null;
  "release-groups"?: MbReleaseGroupStub[];
}

export interface MbTrack {
  id?: string;
  number?: string;
  position?: number;
  title?: string;
  length?: number | null;
  recording?: {
    id?: string;
    title?: string;
    length?: number | null;
    video?: boolean;
    isrcs?: string[];
    "artist-credit"?: MbArtistCreditName[];
  };
}

export interface MbMedium {
  position?: number;
  format?: string | null;
  title?: string | null;
  "track-count"?: number;
  tracks?: MbTrack[];
}

export interface MbRelease {
  id?: string;
  title?: string;
  status?: string | null;
  country?: string | null;
  barcode?: string | null;
  date?: string | null;
  disambiguation?: string | null;
  "label-info"?: Array<{ label?: { name?: string } }>;
  relations?: Array<{ url?: { resource?: string | null } | null }>;
  "release-group"?: MbReleaseGroupStub & { "artist-credit"?: MbArtistCreditName[] };
  media?: MbMedium[];
}

export interface MbReleaseGroup {
  id?: string;
  title?: string;
  "primary-type"?: string | null;
  "secondary-types"?: string[];
  "first-release-date"?: string | null;
  disambiguation?: string | null;
  "artist-credit"?: MbArtistCreditName[];
  releases?: MbRelease[];
}

export interface MbRecording {
  id?: string;
  title?: string;
  length?: number | null;
  video?: boolean;
  isrcs?: string[];
  "artist-credit"?: MbArtistCreditName[];
}

/* ---- helpers ---- */

export function flattenArtistCredit(credit?: MbArtistCreditName[] | null): string | null {
  if (!Array.isArray(credit) || credit.length === 0) {
    return null;
  }
  const text = credit
    .map((part) => `${part.name ?? part.artist?.name ?? ""}${part.joinphrase ?? ""}`)
    .join("")
    .trim();
  return text.length > 0 ? text : null;
}

function primaryArtistId(credit?: MbArtistCreditName[] | null): string | null {
  for (const part of credit || []) {
    const id = String(part.artist?.id || "").trim();
    if (id) {
      return id;
    }
  }
  return null;
}

/* ---- mappers ---- */

export function mapReleaseGroupStubToLidarrAlbum(rg: MbReleaseGroupStub): LidarrAlbum {
  return {
    Id: String(rg.id ?? ""),
    Title: rg.title ?? "",
    Type: rg["primary-type"] ?? undefined,
    SecondaryTypes: Array.isArray(rg["secondary-types"]) ? rg["secondary-types"] : [],
    ReleaseDate: rg["first-release-date"] ?? undefined,
    Disambiguation: rg.disambiguation ?? undefined,
  };
}

export function mapMbArtistToLidarr(artist: MbArtist): LidarrArtist {
  return {
    id: String(artist.id ?? ""),
    artistname: artist.name ?? "",
    sortname: artist["sort-name"] ?? artist.name ?? "",
    disambiguation: artist.disambiguation ?? undefined,
    type: artist.type ?? undefined,
    images: [],
    Albums: (artist["release-groups"] || []).map(mapReleaseGroupStubToLidarrAlbum),
  };
}

export function mapMbTrackToLidarr(track: MbTrack, mediumNumber: number): LidarrTrack {
  const recording = track.recording;
  const lengthMs = track.length ?? recording?.length ?? 0;
  return {
    Id: String(track.id ?? ""),
    RecordingId: String(recording?.id ?? ""),
    TrackName: track.title ?? recording?.title ?? "",
    TrackNumber: String(track.number ?? track.position ?? ""),
    TrackPosition: Number(track.position ?? 0),
    MediumNumber: mediumNumber,
    DurationMs: Number(lengthMs || 0),
  };
}

export function mapMbReleaseToLidarr(release: MbRelease): LidarrRelease {
  const media = release.media || [];
  const tracks: LidarrTrack[] = [];
  for (const medium of media) {
    const mediumNumber = Number(medium.position ?? 1);
    for (const track of medium.tracks || []) {
      tracks.push(mapMbTrackToLidarr(track, mediumNumber));
    }
  }

  const labels = (release["label-info"] || [])
    .map((info) => String(info.label?.name || "").trim())
    .filter(Boolean);
  const country = String(release.country || "").trim();

  return {
    Id: String(release.id ?? ""),
    Title: release.title ?? "",
    Status: release.status ?? "",
    Country: country ? [country] : [],
    Barcode: release.barcode ?? undefined,
    Label: labels,
    Media: media.map((medium) => ({
      Position: Number(medium.position ?? 1),
      Format: medium.format ?? "",
      Name: medium.title ?? "",
    })),
    ReleaseDate: release.date ?? "",
    TrackCount: tracks.length,
    MediumCount: media.length,
    MediaCount: media.length,
    Disambiguation: release.disambiguation ?? "",
    ExternalUrls: (release.relations || [])
      .map((relation) => String(relation.url?.resource || "").trim())
      .filter(Boolean),
    Tracks: tracks,
  };
}

export function mapMbReleaseGroupToLidarrDetail(rg: MbReleaseGroup): LidarrReleaseGroupDetail {
  return {
    id: String(rg.id ?? ""),
    artistid: primaryArtistId(rg["artist-credit"]) ?? undefined,
    title: rg.title ?? "",
    type: rg["primary-type"] ?? undefined,
    secondarytypes: Array.isArray(rg["secondary-types"]) ? rg["secondary-types"] : [],
    releasedate: rg["first-release-date"] ?? undefined,
    disambiguation: rg.disambiguation ?? undefined,
    Releases: (rg.releases || []).map(mapMbReleaseToLidarr),
  };
}

export function mapMbRecordingToCatalog(recording: MbRecording): CatalogRecording {
  return {
    mbid: String(recording.id ?? ""),
    title: recording.title ?? "",
    lengthMs: typeof recording.length === "number" ? recording.length : null,
    isVideo: recording.video === true,
    isrcs: Array.isArray(recording.isrcs) ? recording.isrcs.filter(Boolean) : [],
    artistCredit: flattenArtistCredit(recording["artist-credit"]),
    raw: recording,
  };
}
