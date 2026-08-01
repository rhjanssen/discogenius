import {
  expectArray,
  expectBoolean,
  expectNullableString,
  expectNumber,
  expectOptionalBoolean,
  expectOptionalNumber,
  expectOptionalString,
  expectRecord,
  expectString,
} from "./runtime.js";

export interface LibraryFileContract {
  id: number;
  artist_id?: string | null;
  album_id?: string | null;
  media_id?: string | null;
  canonical_artist_mbid?: string | null;
  canonical_release_group_mbid?: string | null;
  canonical_release_mbid?: string | null;
  canonical_track_mbid?: string | null;
  canonical_recording_mbid?: string | null;
  provider?: string | null;
  provider_entity_type?: string | null;
  provider_id?: string | null;
  library_slot?: string | null;
  file_type: string;
  file_path: string;
  relative_path?: string;
  filename?: string;
  extension?: string;
  quality?: string | null;
  library_root?: string;
  file_size?: number;
  bitrate?: number;
  sample_rate?: number;
  bit_depth?: number;
  channels?: number;
  codec?: string;
  /** Video stream codec (h264/hevc/av1/…) when the file is a music video. */
  video_codec?: string;
  /** Probed video frame width in pixels. */
  width?: number;
  /** Probed video frame height in pixels. */
  height?: number;
  duration?: number;
  qualityTarget?: string | null;
  qualityChangeWanted?: boolean;
  qualityChangeDirection?: string;
  qualityCutoffNotMet?: boolean;
  qualityChangeReason?: string | null;
}

export interface LibraryFilesListResponseContract {
  items: LibraryFileContract[];
  limit: number;
  offset: number;
}

export interface AlbumTrackContract {
  id: string;
  preview_provider?: string | null;
  preview_provider_track_id?: string | null;
  title: string;
  version?: string | null;
  duration: number;
  track_number: number;
  volume_number: number;
  quality: string;
  qualityTags?: string[];
  /** Selected remote offers that make this canonical release track available. */
  remoteOffers?: TrackRemoteOfferContract[];
  artist_name?: string;
  artist_credits?: Array<{ id: string; name: string; join_phrase: string }>;
  album_title?: string;
  album_cover?: string | null;
  cover_url?: string | null;
  musicbrainz_track_id?: string | null;
  musicbrainz_recording_id?: string | null;
  musicbrainz_release_id?: string | null;
  downloaded: boolean;
  is_downloaded: boolean;
  is_monitored: boolean;
  monitored_lock: boolean;
  explicit?: boolean;
  album_id?: string | null;
  files: LibraryFileContract[];
}

export interface TrackRemoteOfferContract {
  slot: string;
  provider: string;
  providerAlbumId: string;
  /** Human-facing permalink for the provider album/playlist. */
  providerUrl?: string | null;
  quality: string | null;
  /** Typed provider-match conviction (verified / probable / …). */
  matchStatus?: string | null;
  selectedReleaseMbid?: string | null;
  /** Provider track id when known for this slot. */
  providerTrackId?: string | null;
  /** Human-facing permalink for the provider track. */
  providerTrackUrl?: string | null;
}

export interface AlbumCardContract {
  id: string;
  title: string;
  cover_id?: string | null;
  provider_cover_id?: string | null;
  artist_name?: string;
  release_date?: string | null;
  popularity?: number;
  quality?: string | null;
  explicit?: boolean;
  is_monitored?: boolean;
}

export interface AlbumVersionContract extends AlbumCardContract {
  version?: string | null;
  stereo_provider_id?: string | null;
  stereo_quality?: string | null;
  spatial_provider_id?: string | null;
  spatial_quality?: string | null;
}

export type LibraryAcquisitionPlanContract = {
  id: number;
  planKey: string;
  provider: string;
  primaryProviderEditionMatchId: number | null;
  providerEditionMatchIds: number[];
  composition: "single_source" | "composite";
  downloadMode: "album" | "tracks";
  state: "current" | "stale" | "unavailable" | "failed";
  chosen: boolean;
  selectionMode: "auto" | "manual";
  rank: number;
  coverage: number;
  targetTrackCount: number;
  qualityTier: string;
  explicitContent: "explicit" | "clean" | "unknown";
};

export interface LibraryReleaseGroupAvailabilityContract {
  releaseGroupId: number;
  releaseGroupMbid: string;
  libraries: Array<{
    id: number;
    name: string;
    qualityProfile: string;
    allowedSourceFormats: string[];
    selections: Array<{
      libraryEditionId: number | null;
      editionId: number;
      releaseMbid: string;
      monitored: boolean;
      representative: boolean;
      selectionMode: "auto" | "manual";
      locked: boolean;
      planSelectionMode: "auto" | "manual";
      plan: LibraryAcquisitionPlanContract | null;
      plans: LibraryAcquisitionPlanContract[];
    }>;
  }>;
  releases: Array<{
    id: number;
    mbid: string;
    title: string;
    disambiguation: string | null;
    status: string | null;
    date: string | null;
    country: string | null;
    mediumCount: number | null;
    trackCount: number | null;
    offers: Array<{
      providerEditionMatchId: number;
      providerItemId: number;
      provider: string;
      providerId: string;
      providerUrl: string | null;
      availability: string;
      relation: "exact" | "source_superset" | "source_subset" | "overlap";
      matchState: "candidate" | "accepted" | "ambiguous" | "rejected";
      confidence: number;
      variants: Array<{
        id: number;
        qualityClass: "lossy" | "lossless" | "hires-lossless" | "spatial";
        availability: string;
        codec: string | null;
        container: string | null;
        spatialFormat: string | null;
      }>;
    }>;
  }>;
}

export interface VideoProviderOfferContract {
  provider: string;
  provider_id: string;
  quality?: string | null;
  url?: string | null;
  available: boolean;
  can_preview: boolean;
  can_download: boolean;
}

export interface VideoAlbumRefContract {
  id: string;
  title: string;
  /** Local /media-cover URL (alias of cover_art_url for older clients). */
  cover_id?: string | null;
  cover_art_url?: string | null;
  /** MusicBrainz track MBID when the video sits on a release tracklist (album deep-link). */
  track_mbid?: string | null;
  track_number?: number | null;
  volume_number?: number | null;
  /** Total tracks on the matched release (for "Track N of M"). */
  track_count?: number | null;
  /** Disc/medium count on the matched release (for multi-volume labels). */
  media_count?: number | null;
}

/**
 * Music video associated with an album via provider_video_for (or an on-RG
 * video track), including the audio track it belongs to for album UX.
 */
export interface AlbumAssociatedVideoContract {
  id: string;
  title: string;
  cover?: string | null;
  cover_id?: string | null;
  cover_art_url?: string | null;
  video_variant?: string | null;
  explicit?: boolean;
  release_date?: string | null;
  /** Selected/best provider offer for the download + quality badge. */
  provider?: string | null;
  quality?: string | null;
  provider_id?: string | null;
  /** Human-facing permalink for the selected provider video offer. */
  provider_url?: string | null;
  is_monitored: boolean;
  monitored_lock: boolean;
  downloaded: boolean;
  is_downloaded: boolean;
  /** MusicBrainz track MBID of the related audio (or video) track on this album. */
  track_mbid?: string | null;
  /** Display title of the related album track. */
  track_title?: string | null;
  track_number?: number | null;
  volume_number?: number | null;
  /** Audio recording MBID when linked via provider_video_for. */
  audio_recording_mbid?: string | null;
}

export interface VideoDetailContract {
  id: string;
  title: string;
  duration: number;
  artist_id: string;
  artist_name?: string;
  release_date?: string | null;
  version?: string | null;
  /**
   * Discogenius catalog class from Recordings.video_variant
   * (video / official / lyric / live / audio / visualizer).
   */
  video_variant?: string | null;
  explicit?: boolean;
  quality?: string | null;
  cover?: string | null;
  cover_id?: string | null;
  cover_art_url?: string | null;
  is_monitored: boolean;
  monitored_lock: boolean;
  downloaded: boolean;
  is_downloaded: boolean;
  /** All provider VIDEO offers for this canonical recording, preference-ordered. */
  offers?: VideoProviderOfferContract[];
  /** Albums (release groups) this video appears on, e.g. Apple bundled MVs. */
  albums?: VideoAlbumRefContract[];
}

export interface VideoUpdateContract {
  monitored?: boolean;
  monitored_lock?: boolean;
}

function parseLibraryFileContract(value: unknown, indexLabel: string): LibraryFileContract {
  const record = expectRecord(value, indexLabel);
  const artistId = record.artist_id;
  const albumId = record.album_id;
  const mediaId = record.media_id;

  return {
    id: expectNumber(record.id, `${indexLabel}.id`),
    artist_id: artistId === undefined ? undefined : artistId === null ? null : String(artistId),
    album_id: albumId === undefined ? undefined : albumId === null ? null : String(albumId),
    media_id: mediaId === undefined ? undefined : mediaId === null ? null : String(mediaId),
    canonical_artist_mbid: expectNullableString(record.canonical_artist_mbid, `${indexLabel}.canonical_artist_mbid`),
    canonical_release_group_mbid: expectNullableString(record.canonical_release_group_mbid, `${indexLabel}.canonical_release_group_mbid`),
    canonical_release_mbid: expectNullableString(record.canonical_release_mbid, `${indexLabel}.canonical_release_mbid`),
    canonical_track_mbid: expectNullableString(record.canonical_track_mbid, `${indexLabel}.canonical_track_mbid`),
    canonical_recording_mbid: expectNullableString(record.canonical_recording_mbid, `${indexLabel}.canonical_recording_mbid`),
    provider: expectNullableString(record.provider, `${indexLabel}.provider`),
    provider_entity_type: expectNullableString(record.provider_entity_type, `${indexLabel}.provider_entity_type`),
    provider_id: expectNullableString(record.provider_id, `${indexLabel}.provider_id`),
    library_slot: expectNullableString(record.library_slot, `${indexLabel}.library_slot`),
    file_type: expectString(record.file_type, `${indexLabel}.file_type`),
    file_path: expectString(record.file_path, `${indexLabel}.file_path`),
    relative_path: expectOptionalString(record.relative_path, `${indexLabel}.relative_path`),
    filename: expectOptionalString(record.filename, `${indexLabel}.filename`),
    extension: expectOptionalString(record.extension, `${indexLabel}.extension`),
    quality: expectNullableString(record.quality, `${indexLabel}.quality`),
    library_root: expectOptionalString(record.library_root, `${indexLabel}.library_root`),
    file_size: expectOptionalNumber(record.file_size, `${indexLabel}.file_size`),
    bitrate: expectOptionalNumber(record.bitrate, `${indexLabel}.bitrate`),
    sample_rate: expectOptionalNumber(record.sample_rate, `${indexLabel}.sample_rate`),
    bit_depth: expectOptionalNumber(record.bit_depth, `${indexLabel}.bit_depth`),
    channels: expectOptionalNumber(record.channels, `${indexLabel}.channels`),
    codec: expectOptionalString(record.codec, `${indexLabel}.codec`),
    video_codec: expectOptionalString(record.video_codec, `${indexLabel}.video_codec`),
    width: expectOptionalNumber(record.width, `${indexLabel}.width`),
    height: expectOptionalNumber(record.height, `${indexLabel}.height`),
    duration: expectOptionalNumber(record.duration, `${indexLabel}.duration`),
    qualityTarget: expectNullableString(record.qualityTarget, `${indexLabel}.qualityTarget`),
    qualityChangeWanted: expectOptionalBoolean(record.qualityChangeWanted, `${indexLabel}.qualityChangeWanted`),
    qualityChangeDirection: expectOptionalString(record.qualityChangeDirection, `${indexLabel}.qualityChangeDirection`),
    qualityCutoffNotMet: expectOptionalBoolean(record.qualityCutoffNotMet, `${indexLabel}.qualityCutoffNotMet`),
    qualityChangeReason: expectNullableString(record.qualityChangeReason, `${indexLabel}.qualityChangeReason`),
  };
}

export function parseLibraryFilesListResponseContract(value: unknown): LibraryFilesListResponseContract {
  const record = expectRecord(value, "Library files response");
  return {
    items: expectArray(record.items, "libraryFiles.items", (item, index) =>
      parseLibraryFileContract(item, `libraryFiles.items[${index}]`)),
    limit: expectNumber(record.limit, "libraryFiles.limit"),
    offset: expectNumber(record.offset, "libraryFiles.offset"),
  };
}

function parseAlbumTrackContract(value: unknown, index: number): AlbumTrackContract {
  const label = `albumTracks[${index}]`;
  const record = expectRecord(value, label);

  return {
    id: expectString(record.id, `${label}.id`),
    preview_provider: expectOptionalString(record.preview_provider, `${label}.preview_provider`) ?? null,
    preview_provider_track_id: expectOptionalString(record.preview_provider_track_id, `${label}.preview_provider_track_id`) ?? null,
    title: expectString(record.title, `${label}.title`),
    version: expectNullableString(record.version, `${label}.version`),
    duration: expectNumber(record.duration, `${label}.duration`),
    track_number: expectNumber(record.track_number, `${label}.track_number`),
    volume_number: expectNumber(record.volume_number, `${label}.volume_number`),
    quality: expectString(record.quality, `${label}.quality`),
    qualityTags: record.qualityTags === undefined
      ? undefined
      : expectArray(record.qualityTags, `${label}.qualityTags`, (quality, qualityIndex) =>
          expectString(quality, `${label}.qualityTags[${qualityIndex}]`)),
    remoteOffers: record.remoteOffers === undefined
      ? undefined
      : expectArray(record.remoteOffers, `${label}.remoteOffers`, (offer, offerIndex) => {
          const offerLabel = `${label}.remoteOffers[${offerIndex}]`;
          const offerRecord = expectRecord(offer, offerLabel);
          return {
            slot: expectString(offerRecord.slot, `${offerLabel}.slot`),
            provider: expectString(offerRecord.provider, `${offerLabel}.provider`),
            providerAlbumId: expectString(offerRecord.providerAlbumId, `${offerLabel}.providerAlbumId`),
            providerUrl: expectNullableString(offerRecord.providerUrl, `${offerLabel}.providerUrl`) ?? null,
            quality: expectNullableString(offerRecord.quality, `${offerLabel}.quality`) ?? null,
            matchStatus: expectOptionalString(offerRecord.matchStatus, `${offerLabel}.matchStatus`) ?? null,
            selectedReleaseMbid: expectOptionalString(offerRecord.selectedReleaseMbid, `${offerLabel}.selectedReleaseMbid`) ?? null,
            providerTrackId: expectOptionalString(offerRecord.providerTrackId, `${offerLabel}.providerTrackId`) ?? null,
            providerTrackUrl: expectNullableString(offerRecord.providerTrackUrl, `${offerLabel}.providerTrackUrl`) ?? null,
          };
        }),
    artist_name: expectOptionalString(record.artist_name, `${label}.artist_name`),
    artist_credits: record.artist_credits === undefined
      ? undefined
      : expectArray(record.artist_credits, `${label}.artist_credits`, (credit, creditIndex) => {
          const creditRecord = expectRecord(credit, `${label}.artist_credits[${creditIndex}]`);
          return {
            id: expectString(creditRecord.id, `${label}.artist_credits[${creditIndex}].id`),
            name: expectString(creditRecord.name, `${label}.artist_credits[${creditIndex}].name`),
            join_phrase: expectString(creditRecord.join_phrase, `${label}.artist_credits[${creditIndex}].join_phrase`),
          };
        }),
    album_title: expectOptionalString(record.album_title, `${label}.album_title`),
    album_cover: expectOptionalString(record.album_cover, `${label}.album_cover`) ?? null,
    cover_url: expectOptionalString(record.cover_url, `${label}.cover_url`) ?? null,
    musicbrainz_track_id: expectOptionalString(record.musicbrainz_track_id, `${label}.musicbrainz_track_id`) ?? null,
    musicbrainz_recording_id: expectOptionalString(record.musicbrainz_recording_id, `${label}.musicbrainz_recording_id`) ?? null,
    musicbrainz_release_id: expectOptionalString(record.musicbrainz_release_id, `${label}.musicbrainz_release_id`) ?? null,
    downloaded: expectBoolean(record.downloaded, `${label}.downloaded`),
    is_downloaded: expectBoolean(record.is_downloaded, `${label}.is_downloaded`),
    is_monitored: expectBoolean(record.is_monitored, `${label}.is_monitored`),
    monitored_lock: expectOptionalBoolean(record.monitored_lock, `${label}.monitored_lock`) ?? false,
    explicit: expectOptionalBoolean(record.explicit, `${label}.explicit`),
    album_id: expectNullableString(record.album_id, `${label}.album_id`),
    files: expectArray(record.files, `${label}.files`, (item, fileIndex) =>
      parseLibraryFileContract(item, `${label}.files[${fileIndex}]`)),
  };
}

export function parseAlbumTracksContract(value: unknown): AlbumTrackContract[] {
  return expectArray(value, "Album tracks", parseAlbumTrackContract);
}

function parseAlbumAssociatedVideoContract(value: unknown, index: number): AlbumAssociatedVideoContract {
  const label = `albumAssociatedVideos[${index}]`;
  const record = expectRecord(value, label);
  return {
    id: expectString(record.id, `${label}.id`),
    title: expectString(record.title, `${label}.title`),
    cover: expectNullableString(record.cover, `${label}.cover`),
    cover_id: expectNullableString(record.cover_id, `${label}.cover_id`),
    cover_art_url: expectNullableString(record.cover_art_url, `${label}.cover_art_url`),
    video_variant: expectNullableString(record.video_variant, `${label}.video_variant`),
    explicit: expectOptionalBoolean(record.explicit, `${label}.explicit`),
    release_date: expectNullableString(record.release_date, `${label}.release_date`),
    provider: expectNullableString(record.provider, `${label}.provider`),
    quality: expectNullableString(record.quality, `${label}.quality`),
    provider_id: expectNullableString(record.provider_id, `${label}.provider_id`),
    provider_url: expectNullableString(record.provider_url, `${label}.provider_url`),
    is_monitored: expectBoolean(record.is_monitored, `${label}.is_monitored`),
    monitored_lock: expectOptionalBoolean(record.monitored_lock, `${label}.monitored_lock`) ?? false,
    downloaded: expectBoolean(record.downloaded, `${label}.downloaded`),
    is_downloaded: expectBoolean(record.is_downloaded, `${label}.is_downloaded`),
    track_mbid: expectNullableString(record.track_mbid, `${label}.track_mbid`),
    track_title: expectNullableString(record.track_title, `${label}.track_title`),
    track_number: expectOptionalNumber(record.track_number, `${label}.track_number`) ?? null,
    volume_number: expectOptionalNumber(record.volume_number, `${label}.volume_number`) ?? null,
    audio_recording_mbid: expectNullableString(record.audio_recording_mbid, `${label}.audio_recording_mbid`),
  };
}

export function parseAlbumAssociatedVideosContract(value: unknown): AlbumAssociatedVideoContract[] {
  return expectArray(value, "Album associated videos", parseAlbumAssociatedVideoContract);
}

function parseAlbumListItemContract<T extends AlbumCardContract | AlbumVersionContract>(
  value: unknown,
  index: number,
): T {
  const label = `albumList[${index}]`;
  const record = expectRecord(value, label);

  return {
    id: expectString(record.id, `${label}.id`),
    title: expectString(record.title, `${label}.title`),
    cover_id: expectNullableString(record.cover_id, `${label}.cover_id`),
    provider_cover_id: expectNullableString(record.provider_cover_id, `${label}.provider_cover_id`),
    artist_name: expectOptionalString(record.artist_name, `${label}.artist_name`),
    release_date: expectNullableString(record.release_date, `${label}.release_date`),
    popularity: expectOptionalNumber(record.popularity, `${label}.popularity`),
    quality: expectNullableString(record.quality, `${label}.quality`),
    explicit: expectOptionalBoolean(record.explicit, `${label}.explicit`),
    is_monitored: expectOptionalBoolean(record.is_monitored, `${label}.is_monitored`),
    version: expectNullableString(record.version, `${label}.version`),
    stereo_provider_id: expectOptionalString(record.stereo_provider_id, `${label}.stereo_provider_id`) ?? null,
    stereo_quality: expectOptionalString(record.stereo_quality, `${label}.stereo_quality`) ?? null,
    spatial_provider_id: expectOptionalString(record.spatial_provider_id, `${label}.spatial_provider_id`) ?? null,
    spatial_quality: expectOptionalString(record.spatial_quality, `${label}.spatial_quality`) ?? null,
  } as T;
}

export function parseAlbumVersionsContract(value: unknown): AlbumVersionContract[] {
  return expectArray(value, "Album versions", (item, index) => parseAlbumListItemContract<AlbumVersionContract>(item, index));
}

export function parseLibraryReleaseGroupAvailabilityContract(
  value: unknown,
): LibraryReleaseGroupAvailabilityContract {
  const record = expectRecord(value, "libraryReleaseAvailability");
  return {
    releaseGroupId: expectNumber(record.releaseGroupId, "libraryReleaseAvailability.releaseGroupId"),
    releaseGroupMbid: expectString(record.releaseGroupMbid, "libraryReleaseAvailability.releaseGroupMbid"),
    libraries: expectArray(record.libraries, "libraryReleaseAvailability.libraries", (item, libraryIndex) => {
      const library = expectRecord(item, `libraryReleaseAvailability.libraries[${libraryIndex}]`);
      return {
        id: expectNumber(library.id, `libraryReleaseAvailability.libraries[${libraryIndex}].id`),
        name: expectString(library.name, `libraryReleaseAvailability.libraries[${libraryIndex}].name`),
        qualityProfile: expectString(
          library.qualityProfile,
          `libraryReleaseAvailability.libraries[${libraryIndex}].qualityProfile`,
        ),
        allowedSourceFormats: expectArray(
          library.allowedSourceFormats,
          `libraryReleaseAvailability.libraries[${libraryIndex}].allowedSourceFormats`,
          (format, formatIndex) => expectString(
            format,
            `libraryReleaseAvailability.libraries[${libraryIndex}].allowedSourceFormats[${formatIndex}]`,
          ),
        ),
        selections: expectArray(
          library.selections,
          `libraryReleaseAvailability.libraries[${libraryIndex}].selections`,
          (selectionItem, selectionIndex) => {
            const label = `libraryReleaseAvailability.libraries[${libraryIndex}].selections[${selectionIndex}]`;
            const selection = expectRecord(selectionItem, label);
            const parsePlan = (value: unknown, planLabel: string): LibraryAcquisitionPlanContract => {
              const plan = expectRecord(value, planLabel);
              return {
                id: expectNumber(plan.id, `${planLabel}.id`),
                planKey: expectString(plan.planKey, `${planLabel}.planKey`),
                provider: expectString(plan.provider, `${planLabel}.provider`),
                primaryProviderEditionMatchId: plan.primaryProviderEditionMatchId == null
                  ? null
                  : expectNumber(plan.primaryProviderEditionMatchId, `${planLabel}.primaryProviderEditionMatchId`),
                providerEditionMatchIds: expectArray(
                  plan.providerEditionMatchIds,
                  `${planLabel}.providerEditionMatchIds`,
                  (matchId, matchIndex) =>
                    expectNumber(matchId, `${planLabel}.providerEditionMatchIds[${matchIndex}]`),
                ),
                composition: expectString(plan.composition, `${planLabel}.composition`) as "single_source" | "composite",
                downloadMode: expectString(plan.downloadMode, `${planLabel}.downloadMode`) as "album" | "tracks",
                state: expectString(plan.state, `${planLabel}.state`) as "current" | "stale" | "unavailable" | "failed",
                chosen: expectBoolean(plan.chosen, `${planLabel}.chosen`),
                selectionMode: expectString(plan.selectionMode, `${planLabel}.selectionMode`) as "auto" | "manual",
                rank: expectNumber(plan.rank, `${planLabel}.rank`),
                coverage: expectNumber(plan.coverage, `${planLabel}.coverage`),
                targetTrackCount: expectNumber(plan.targetTrackCount, `${planLabel}.targetTrackCount`),
                qualityTier: expectString(plan.qualityTier, `${planLabel}.qualityTier`),
                explicitContent: expectString(plan.explicitContent, `${planLabel}.explicitContent`) as "explicit" | "clean" | "unknown",
              };
            };
            return {
              libraryEditionId: selection.libraryEditionId == null
                ? null
                : expectNumber(selection.libraryEditionId, `${label}.libraryEditionId`),
              editionId: expectNumber(selection.editionId, `${label}.editionId`),
              releaseMbid: expectString(selection.releaseMbid, `${label}.releaseMbid`),
              monitored: expectBoolean(selection.monitored, `${label}.monitored`),
              representative: expectBoolean(selection.representative, `${label}.representative`),
              selectionMode: expectString(selection.selectionMode, `${label}.selectionMode`) as "auto" | "manual",
              locked: expectBoolean(selection.locked, `${label}.locked`),
              planSelectionMode: expectString(
                selection.planSelectionMode,
                `${label}.planSelectionMode`,
              ) as "auto" | "manual",
              plan: selection.plan == null ? null : parsePlan(selection.plan, `${label}.plan`),
              plans: expectArray(selection.plans, `${label}.plans`, (planItem, planIndex) =>
                parsePlan(planItem, `${label}.plans[${planIndex}]`)),
            };
          },
        ),
      };
    }),
    releases: expectArray(record.releases, "libraryReleaseAvailability.releases", (item, releaseIndex) => {
      const label = `libraryReleaseAvailability.releases[${releaseIndex}]`;
      const release = expectRecord(item, label);
      return {
        id: expectNumber(release.id, `${label}.id`),
        mbid: expectString(release.mbid, `${label}.mbid`),
        title: expectString(release.title, `${label}.title`),
        disambiguation: expectNullableString(release.disambiguation, `${label}.disambiguation`) ?? null,
        status: expectNullableString(release.status, `${label}.status`) ?? null,
        date: expectNullableString(release.date, `${label}.date`) ?? null,
        country: expectNullableString(release.country, `${label}.country`) ?? null,
        mediumCount: expectOptionalNumber(release.mediumCount, `${label}.mediumCount`) ?? null,
        trackCount: expectOptionalNumber(release.trackCount, `${label}.trackCount`) ?? null,
        offers: expectArray(release.offers, `${label}.offers`, (offerItem, offerIndex) => {
          const offerLabel = `${label}.offers[${offerIndex}]`;
          const offer = expectRecord(offerItem, offerLabel);
          return {
            providerEditionMatchId: expectNumber(offer.providerEditionMatchId, `${offerLabel}.providerEditionMatchId`),
            providerItemId: expectNumber(offer.providerItemId, `${offerLabel}.providerItemId`),
            provider: expectString(offer.provider, `${offerLabel}.provider`),
            providerId: expectString(offer.providerId, `${offerLabel}.providerId`),
            providerUrl: expectNullableString(offer.providerUrl, `${offerLabel}.providerUrl`) ?? null,
            availability: expectString(offer.availability, `${offerLabel}.availability`),
            relation: expectString(offer.relation, `${offerLabel}.relation`) as "exact" | "source_superset" | "source_subset" | "overlap",
            matchState: expectString(offer.matchState, `${offerLabel}.matchState`) as "candidate" | "accepted" | "ambiguous" | "rejected",
            confidence: expectNumber(offer.confidence, `${offerLabel}.confidence`),
            variants: expectArray(offer.variants, `${offerLabel}.variants`, (variantItem, variantIndex) => {
              const variantLabel = `${offerLabel}.variants[${variantIndex}]`;
              const variant = expectRecord(variantItem, variantLabel);
              return {
                id: expectNumber(variant.id, `${variantLabel}.id`),
                qualityClass: expectString(variant.qualityClass, `${variantLabel}.qualityClass`) as "lossy" | "lossless" | "hires-lossless" | "spatial",
                availability: expectString(variant.availability, `${variantLabel}.availability`),
                codec: expectNullableString(variant.codec, `${variantLabel}.codec`) ?? null,
                container: expectNullableString(variant.container, `${variantLabel}.container`) ?? null,
                spatialFormat: expectNullableString(variant.spatialFormat, `${variantLabel}.spatialFormat`) ?? null,
              };
            }),
          };
        }),
      };
    }),
  };
}

export function parseVideoDetailContract(value: unknown): VideoDetailContract {
  const record = expectRecord(value, "Video detail");
  return {
    id: expectString(record.id, "video.id"),
    title: expectString(record.title, "video.title"),
    duration: expectNumber(record.duration, "video.duration"),
    artist_id: expectString(record.artist_id, "video.artist_id"),
    artist_name: expectOptionalString(record.artist_name, "video.artist_name"),
    release_date: expectNullableString(record.release_date, "video.release_date"),
    version: expectNullableString(record.version, "video.version"),
    video_variant: expectNullableString(record.video_variant, "video.video_variant"),
    explicit: expectOptionalBoolean(record.explicit, "video.explicit"),
    quality: expectNullableString(record.quality, "video.quality"),
    cover: expectNullableString(record.cover, "video.cover"),
    cover_id: expectNullableString(record.cover_id, "video.cover_id"),
    cover_art_url: expectNullableString(record.cover_art_url, "video.cover_art_url"),
    is_monitored: expectBoolean(record.is_monitored, "video.is_monitored"),
    monitored_lock: expectOptionalBoolean(record.monitored_lock, "video.monitored_lock") ?? false,
    downloaded: expectBoolean(record.downloaded, "video.downloaded"),
    is_downloaded: expectBoolean(record.is_downloaded, "video.is_downloaded"),
    offers: record.offers === undefined
      ? undefined
      : expectArray(record.offers, "video.offers", (item, index) => parseVideoProviderOfferContract(item, `video.offers[${index}]`)),
    albums: record.albums === undefined
      ? undefined
      : expectArray(record.albums, "video.albums", (item, index) => parseVideoAlbumRefContract(item, `video.albums[${index}]`)),
  };
}

function parseVideoProviderOfferContract(value: unknown, indexLabel: string): VideoProviderOfferContract {
  const record = expectRecord(value, indexLabel);
  return {
    provider: expectString(record.provider, `${indexLabel}.provider`),
    provider_id: expectString(record.provider_id, `${indexLabel}.provider_id`),
    quality: expectNullableString(record.quality, `${indexLabel}.quality`),
    url: expectNullableString(record.url, `${indexLabel}.url`),
    available: expectOptionalBoolean(record.available, `${indexLabel}.available`) ?? true,
    can_preview: expectOptionalBoolean(record.can_preview, `${indexLabel}.can_preview`) ?? true,
    can_download: expectOptionalBoolean(record.can_download, `${indexLabel}.can_download`) ?? true,
  };
}

function parseVideoAlbumRefContract(value: unknown, indexLabel: string): VideoAlbumRefContract {
  const record = expectRecord(value, indexLabel);
  return {
    id: expectString(record.id, `${indexLabel}.id`),
    title: expectString(record.title, `${indexLabel}.title`),
    cover_id: expectNullableString(record.cover_id, `${indexLabel}.cover_id`),
    cover_art_url: expectNullableString(record.cover_art_url, `${indexLabel}.cover_art_url`),
    track_mbid: expectNullableString(record.track_mbid, `${indexLabel}.track_mbid`),
    track_number: expectOptionalNumber(record.track_number, `${indexLabel}.track_number`) ?? null,
    volume_number: expectOptionalNumber(record.volume_number, `${indexLabel}.volume_number`) ?? null,
    track_count: expectOptionalNumber(record.track_count, `${indexLabel}.track_count`) ?? null,
    media_count: expectOptionalNumber(record.media_count, `${indexLabel}.media_count`) ?? null,
  };
}
