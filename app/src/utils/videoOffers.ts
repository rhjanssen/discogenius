export type VideoOfferIdentity = {
  provider?: string | null;
  provider_id?: string | null;
  available?: boolean;
  can_preview?: boolean;
  can_download?: boolean;
};

export function videoOfferSelectionKey(
  provider?: string | null,
  providerId?: string | null,
): string | null {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const normalizedProviderId = String(providerId || "").trim();
  return normalizedProvider && normalizedProviderId
    ? JSON.stringify([normalizedProvider, normalizedProviderId])
    : null;
}

export function selectVideoOffer<T extends VideoOfferIdentity>(
  offers: readonly T[],
  selectedKey: string | null,
): T | null {
  return offers.find((offer) =>
    videoOfferSelectionKey(offer.provider, offer.provider_id) === selectedKey)
    ?? offers[0]
    ?? null;
}

function selectVideoOfferForCapability<T extends VideoOfferIdentity>(
  offers: readonly T[],
  selectedKey: string | null,
  capability: "can_preview" | "can_download",
): T | null {
  const selected = offers.find((offer) =>
    videoOfferSelectionKey(offer.provider, offer.provider_id) === selectedKey);
  if (selected && selected.available !== false && selected[capability] !== false) return selected;
  return offers.find((offer) => offer.available !== false && offer[capability] !== false) ?? null;
}

export function selectVideoPreviewOffer<T extends VideoOfferIdentity>(
  offers: readonly T[],
  selectedKey: string | null,
): T | null {
  return selectVideoOfferForCapability(offers, selectedKey, "can_preview");
}

export function selectVideoDownloadOffer<T extends VideoOfferIdentity>(
  offers: readonly T[],
  selectedKey: string | null,
): T | null {
  return selectVideoOfferForCapability(offers, selectedKey, "can_download");
}

export function videoQueueTarget(
  canonicalRecordingId: string,
  selectedOffer: VideoOfferIdentity | null | undefined,
): { provider: string | null; providerId: string } {
  return {
    provider: String(selectedOffer?.provider || "").trim() || null,
    providerId: String(selectedOffer?.provider_id || "").trim() || canonicalRecordingId,
  };
}
