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
  library_slot: string | null;
  match_evidence: string | null;
  provider_album_id?: string | null;
  parent_quality?: string | null;
  parent_library_slot?: string | null;
  parent_match_evidence?: string | null;
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

function parseProviderQualityTags(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as { providerQualityTags?: unknown };
    return Array.isArray(parsed?.providerQualityTags)
      ? parsed.providerQualityTags.map((tag) => String(tag ?? "").trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function rowSlot(row: AudioOfferRow): string {
  return String(row.library_slot || "stereo").trim().toLowerCase();
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
    [
      row.quality,
      row.parent_quality,
      ...parseProviderQualityTags(row.match_evidence),
      ...parseProviderQualityTags(row.parent_match_evidence),
    ],
    rowSlot(row) === "spatial"
      || String(row.parent_library_slot || "").trim().toLowerCase() === "spatial",
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
           item.quality,
           item.library_slot,
           item.match_evidence
    FROM ProviderItems item
    WHERE item.entity_type = 'album'
      AND item.release_group_mbid = ?
      AND (item.match_status IS NULL OR LOWER(item.match_status) <> 'rejected')
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
           item.quality,
           CAST(item.provider_album_id AS TEXT) AS provider_album_id,
           item.library_slot,
           item.match_evidence,
           parent.quality AS parent_quality,
           parent.library_slot AS parent_library_slot,
           parent.match_evidence AS parent_match_evidence
    FROM ProviderItems item
    LEFT JOIN ProviderItems parent
      ON parent.provider = item.provider
     AND parent.entity_type = 'album'
     AND parent.provider_id = item.provider_album_id
    WHERE item.entity_type = 'track'
      AND (item.match_status IS NULL OR LOWER(item.match_status) <> 'rejected')
      AND (
        (? != '' AND item.track_mbid = ?)
        OR (? != '' AND item.recording_mbid = ?)
      )
      AND ${availabilitySql("item.availability")}
      AND (
        parent.rowid IS NULL
        OR (
          (parent.match_status IS NULL OR LOWER(parent.match_status) <> 'rejected')
          AND ${availabilitySql("parent.availability")}
        )
      )
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
    SELECT item.provider, CAST(item.provider_id AS TEXT) AS provider_id, item.quality
    FROM ProviderItems item
    WHERE item.entity_type = 'video'
      AND (item.match_status IS NULL OR LOWER(item.match_status) <> 'rejected')
      AND (CAST(item.recording_id AS TEXT) = ? OR item.recording_mbid = ?)
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
