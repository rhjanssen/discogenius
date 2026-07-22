import { db } from "../../database.js";
import { streamingProviderManager } from "../providers/index.js";
import { compareVideoOffersByQualityThenProvider } from "../music/video-offer-resolver.js";

export type RankedDownloadOffer = {
  provider: string;
  providerId: string;
  quality: string | null;
  providerAlbumId?: string | null;
};

const AVAILABILITY_SQL = `
  (availability IS NULL
   OR LOWER(CAST(availability AS TEXT)) NOT IN ('0', 'false', 'unavailable', 'no', ''))
`;

function offerKey(provider: string, providerId: string): string {
  return `${String(provider).trim().toLowerCase()}::${String(providerId).trim()}`;
}

function sortByProviderPreference(offers: RankedDownloadOffer[]): RankedDownloadOffer[] {
  return [...offers].sort((left, right) => {
    const rankDelta = streamingProviderManager.getProviderPreferenceRank(left.provider)
      - streamingProviderManager.getProviderPreferenceRank(right.provider);
    if (rankDelta !== 0) return rankDelta;
    const qualityLeft = String(left.quality || "");
    const qualityRight = String(right.quality || "");
    if (qualityLeft !== qualityRight) {
      return qualityRight.localeCompare(qualityLeft);
    }
    return left.providerId.localeCompare(right.providerId);
  });
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
    SELECT provider, CAST(provider_id AS TEXT) AS provider_id, quality, library_slot
    FROM ProviderItems
    WHERE entity_type = 'album'
      AND release_group_mbid = ?
      AND ${AVAILABILITY_SQL}
  `).all(mbid) as Array<{
    provider: string;
    provider_id: string;
    quality: string | null;
    library_slot: string | null;
  }>;

  const filtered = rows.filter((row) => {
    if (!slot || slot === "stereo") {
      // Stereo (default) accepts stereo/unset; spatial slot must match.
      const rowSlot = String(row.library_slot || "stereo").trim().toLowerCase();
      return rowSlot !== "spatial";
    }
    if (slot === "spatial") {
      return String(row.library_slot || "").trim().toLowerCase() === "spatial";
    }
    return true;
  });

  return sortByProviderPreference(dedupeOffers(filtered.map((row) => ({
    provider: row.provider,
    providerId: row.provider_id,
    quality: row.quality ?? null,
  }))));
}

export function listRankedTrackOffers(options: {
  trackMbid?: string | null;
  recordingMbid?: string | null;
}): RankedDownloadOffer[] {
  const trackMbid = String(options.trackMbid || "").trim();
  const recordingMbid = String(options.recordingMbid || "").trim();
  if (!trackMbid && !recordingMbid) return [];

  const rows = db.prepare(`
    SELECT provider, CAST(provider_id AS TEXT) AS provider_id, quality,
           CAST(provider_album_id AS TEXT) AS provider_album_id
    FROM ProviderItems
    WHERE entity_type = 'track'
      AND (
        (? != '' AND track_mbid = ?)
        OR (? != '' AND recording_mbid = ?)
      )
      AND ${AVAILABILITY_SQL}
  `).all(trackMbid, trackMbid, recordingMbid, recordingMbid) as Array<{
    provider: string;
    provider_id: string;
    quality: string | null;
    provider_album_id: string | null;
  }>;

  return sortByProviderPreference(dedupeOffers(rows.map((row) => ({
    provider: row.provider,
    providerId: row.provider_id,
    quality: row.quality ?? null,
    providerAlbumId: row.provider_album_id,
  }))));
}

export function listRankedVideoOffers(recordingRef: string | null | undefined): RankedDownloadOffer[] {
  const key = String(recordingRef || "").trim();
  if (!key) return [];

  const rows = db.prepare(`
    SELECT provider, CAST(provider_id AS TEXT) AS provider_id, quality
    FROM ProviderItems
    WHERE entity_type = 'video'
      AND (CAST(recording_id AS TEXT) = ? OR recording_mbid = ?)
      AND ${AVAILABILITY_SQL}
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
