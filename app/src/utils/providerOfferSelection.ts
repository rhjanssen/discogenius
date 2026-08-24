import { providerKey } from "@/components/ui/providerMarks";

type OfferIdentity = {
  planKey?: string | null;
  provider?: string | null;
  providerAlbumId?: string | null;
};

type SelectedOfferIdentity = {
  planKey?: string | null;
  provider?: string | null;
  albumId?: string | null;
};

function providerAlbumIds(value?: string | null): string[] {
  return String(value || "")
    .split(";")
    .map((id) => id.trim())
    .filter(Boolean)
    .sort();
}

function sameProviderAlbumIdSet(left?: string | null, right?: string | null): boolean {
  const leftIds = providerAlbumIds(left);
  const rightIds = providerAlbumIds(right);
  return leftIds.length > 0
    && leftIds.length === rightIds.length
    && leftIds.every((id, index) => id === rightIds[index]);
}

/** Compare the exact acquisition-plan identity, falling back to a raw provider edition. */
export function isOfferSelected(
  offer: OfferIdentity,
  selected: SelectedOfferIdentity,
): boolean {
  const offerPlanKey = String(offer.planKey || "").trim();
  const selectedPlanKey = String(selected.planKey || "").trim();
  if (offerPlanKey || selectedPlanKey) {
    return offerPlanKey.length > 0 && offerPlanKey === selectedPlanKey;
  }
  return providerKey(selected.provider) === providerKey(offer.provider)
    && sameProviderAlbumIdSet(selected.albumId, offer.providerAlbumId);
}

type PlanOfferIdentity = {
  planKey?: string | null;
  provider?: string | null;
  quality?: string | null;
  providerAlbumId?: string | null;
  providerAlbumIds?: string[];
};

/** Compare the plan represented by two selectable provider-quality pills. */
export function isSamePlanOffer(view: PlanOfferIdentity, picked: PlanOfferIdentity): boolean {
  if (view.planKey || picked.planKey) {
    return Boolean(view.planKey) && view.planKey === picked.planKey;
  }
  return view.provider === picked.provider
    && view.quality === picked.quality
    && (
      view.providerAlbumId === picked.providerAlbumId
      || Boolean(
        picked.providerAlbumIds?.length
        && view.providerAlbumIds?.join(";") === picked.providerAlbumIds.join(";"),
      )
    );
}
