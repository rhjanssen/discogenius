import { db } from "../../database.js";
import { compareVideoOffersByQualityThenProvider } from "../music/video-offer-resolver.js";
import {
  compareAudioOffersByQualityThenProvider,
  compareSpatialOffersByQualityThenProvider,
  projectProviderSpatialOffer,
} from "../providers/provider-offer-ranking.js";

export type RankedDownloadOffer = {
  provider: string;
  providerId: string;
  quality: string | null;
  providerAlbumId?: string | null;
};

type AudioOfferRow = {
  provider: string;
  provider_id: string;
  quality: string | null;
  quality_class: string | null;
  spatial_format: string | null;
  provider_album_id?: string | null;
};

type SpatialRankedDownloadOffer = RankedDownloadOffer & {
  spatialRank: number;
};

function availabilitySql(column: string): string {
  return `(
    ${column} IS NULL
    OR LOWER(CAST(${column} AS TEXT)) NOT IN ('0', 'false', 'unavailable', 'no', '')
  )`;
}

function offerKey(provider: string, providerId: string): string {
  return `${String(provider).trim().toLowerCase()}::${String(providerId).trim()}`;
}

function sortAudioOffers(offers: RankedDownloadOffer[]): RankedDownloadOffer[] {
  return [...offers].sort((left, right) => compareAudioOffersByQualityThenProvider(
    { provider: left.provider, quality: left.quality, providerId: left.providerId },
    { provider: right.provider, quality: right.quality, providerId: right.providerId },
  ));
}

function sortSpatialOffers(offers: SpatialRankedDownloadOffer[]): RankedDownloadOffer[] {
  return [...offers]
    .sort((left, right) => compareSpatialOffersByQualityThenProvider(
      {
        provider: left.provider,
        quality: left.quality,
        providerId: left.providerId,
        spatialRank: left.spatialRank,
      },
      {
        provider: right.provider,
        quality: right.quality,
        providerId: right.providerId,
        spatialRank: right.spatialRank,
      },
    ))
    .map(({ spatialRank: _spatialRank, ...offer }) => offer);
}

function rowSlot(row: AudioOfferRow): string {
  return row.quality_class === "spatial" ? "spatial" : "stereo";
}

function toDownloadOffer(row: AudioOfferRow): RankedDownloadOffer {
  return {
    provider: row.provider,
    providerId: row.provider_id,
    quality: row.quality ?? null,
    ...(row.provider_album_id === undefined
      ? {}
      : { providerAlbumId: row.provider_album_id }),
  };
}

function toSpatialDownloadOffer(row: AudioOfferRow): SpatialRankedDownloadOffer | null {
  const projection = projectProviderSpatialOffer(
    row.provider,
    [row.quality, row.spatial_format],
    rowSlot(row) === "spatial",
  );
  if (!projection) return null;

  return {
    ...toDownloadOffer(row),
    // Backends branch on the quality tag as well as the slot, so do not pass a
    // stereo scalar (for example Apple HIRES_LOSSLESS) into a spatial job.
    quality: projection.quality,
    spatialRank: projection.rank,
  };
}

function dedupeOffers(offers: RankedDownloadOffer[]): RankedDownloadOffer[] {
  const seen = new Set<string>();
  const out: RankedDownloadOffer[] = [];
  for (const offer of offers) {
    const key = offerKey(offer.provider, offer.providerId);
    if (!offer.provider || !offer.providerId || seen.has(key)) continue;
    seen.add(key);
    out.push(offer);
  }
  return out;
}

export function listRankedAlbumOffers(
  releaseGroupMbid: string | null | undefined,
  librarySlot?: string | null,
): RankedDownloadOffer[] {
  const mbid = String(releaseGroupMbid || "").trim();
  if (!mbid) return [];

  const slot = String(librarySlot || "").trim().toLowerCase();
  const rows = db.prepare(`
    SELECT item.provider,
           CAST(item.provider_id AS TEXT) AS provider_id,
           COALESCE(
             variant.provider_quality_label,
             variant.spatial_format,
             variant.quality_class
           ) AS quality,
           variant.quality_class,
           variant.spatial_format
    FROM ProviderItems item
    JOIN ProviderEditionMatches release_match
      ON release_match.provider_edition_item_id = item.id
     AND release_match.match_state = 'accepted'
    JOIN AlbumEditions release ON release.id = release_match.edition_id
    JOIN Albums release_group ON release_group.id = release.release_group_id
    LEFT JOIN ProviderItemAudioVariants variant
      ON variant.provider_item_id = item.id
     AND ${availabilitySql("variant.availability")}
    WHERE item.entity_type = 'release'
      AND release_group.mbid = ?
      AND ${availabilitySql("item.availability")}
  `).all(mbid) as AudioOfferRow[];

  if (slot === "spatial") {
    return dedupeOffers(sortSpatialOffers(
      rows
        .map(toSpatialDownloadOffer)
        .filter((offer): offer is SpatialRankedDownloadOffer => Boolean(offer)),
    ));
  }

  // Album offers are audio resources. A spatial-only album remains a valid
  // last-resort stereo-library acquisition per the configured slot semantics.
  return dedupeOffers(sortAudioOffers(rows.map(toDownloadOffer)));
}

export function listRankedTrackOffers(options: {
  trackMbid?: string | null;
  recordingMbid?: string | null;
  librarySlot?: string | null;
}): RankedDownloadOffer[] {
  const trackMbid = String(options.trackMbid || "").trim();
  const recordingMbid = String(options.recordingMbid || "").trim();
  if (!trackMbid && !recordingMbid) return [];

  const rows = db.prepare(`
    SELECT item.provider,
           CAST(item.provider_id AS TEXT) AS provider_id,
           COALESCE(
             variant.provider_quality_label,
             variant.spatial_format,
             variant.quality_class
           ) AS quality,
           variant.quality_class,
           variant.spatial_format,
           CAST(parent.provider_id AS TEXT) AS provider_album_id
    FROM ProviderItems item
    JOIN ProviderEditionMembers member ON member.member_item_id = item.id
    JOIN ProviderItems parent ON parent.id = member.provider_edition_item_id
    JOIN ProviderTrackMatches track_match
      ON track_match.provider_edition_member_id = member.id
     AND track_match.match_state = 'accepted'
    LEFT JOIN Tracks track ON track.id = track_match.track_id
    JOIN Recordings recording ON recording.id = track_match.recording_id
    LEFT JOIN ProviderItemAudioVariants variant
      ON variant.provider_item_id = item.id
     AND ${availabilitySql("variant.availability")}
    WHERE item.entity_type = 'track'
      AND (
        (? != '' AND track.mbid = ?)
        OR (? != '' AND recording.mbid = ?)
      )
      AND ${availabilitySql("item.availability")}
      AND ${availabilitySql("parent.availability")}
  `).all(trackMbid, trackMbid, recordingMbid, recordingMbid) as AudioOfferRow[];

  const slot = String(options.librarySlot || "stereo").trim().toLowerCase();
  if (slot === "spatial") {
    return dedupeOffers(sortSpatialOffers(
      rows
        .map(toSpatialDownloadOffer)
        .filter((offer): offer is SpatialRankedDownloadOffer => Boolean(offer)),
    ));
  }

  // Sort before deduplication: stereo/spatial variants can share a provider id,
  // and retaining the first SQLite row made the chosen quality nondeterministic.
  return dedupeOffers(sortAudioOffers(
    rows
      .filter((row) => rowSlot(row) !== "video")
      .map(toDownloadOffer),
  ));
}

export function listRankedVideoOffers(recordingRef: string | null | undefined): RankedDownloadOffer[] {
  const key = String(recordingRef || "").trim();
  if (!key) return [];

  const rows = db.prepare(`
    SELECT item.provider,
           CAST(item.provider_id AS TEXT) AS provider_id,
           item.video_quality AS quality
    FROM ProviderItems item
    JOIN ProviderVideoMatches video_match
      ON video_match.provider_video_item_id = item.id
     AND video_match.match_state = 'accepted'
    JOIN Recordings recording ON recording.id = video_match.recording_id
    WHERE item.entity_type = 'video'
      AND (CAST(video_match.recording_id AS TEXT) = ? OR recording.mbid = ?)
      AND ${availabilitySql("item.availability")}
  `).all(key, key) as Array<{
    provider: string;
    provider_id: string;
    quality: string | null;
  }>;

  const offers = dedupeOffers(rows.map((row) => ({
    provider: row.provider,
    providerId: row.provider_id,
    quality: row.quality ?? null,
  })));

  return offers.sort((left, right) => compareVideoOffersByQualityThenProvider(
    { provider: left.provider, quality: left.quality, providerId: left.providerId },
    { provider: right.provider, quality: right.quality, providerId: right.providerId },
  ));
}

export function nextOfferAfterTried(
  ranked: readonly RankedDownloadOffer[],
  triedKeys: ReadonlySet<string>,
): RankedDownloadOffer | null {
  for (const offer of ranked) {
    if (!triedKeys.has(offerKey(offer.provider, offer.providerId))) {
      return offer;
    }
  }
  return null;
}

export function makeOfferAttemptKey(provider: string, providerId: string): string {
  return offerKey(provider, providerId);
}
