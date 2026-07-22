import {
  Badge,
  Card,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { AppTooltip } from "@/components/ui/AppTooltip";
import { ProviderQualityRow, type ProviderQualityOffer } from "@/components/ui/ProviderQualityPill";
import { formatDurationSeconds } from "@/utils/format";
import type { ReleaseGroupAvailability } from "@/hooks/useAlbumPage";

const SWITCHABLE_SLOTS = ["stereo", "spatial"] as const;
export type SwitchableSlot = (typeof SWITCHABLE_SLOTS)[number];

function activeSwitchableSlots(includeSpatial: boolean): SwitchableSlot[] {
  return includeSpatial ? [...SWITCHABLE_SLOTS] : ["stereo"];
}

function slotLabel(slot: SwitchableSlot): string {
  return slot === "spatial" ? "Spatial" : "Stereo";
}

function releaseYear(date?: string | null): string | null {
  if (!date) return null;
  const year = new Date(date).getFullYear();
  return Number.isFinite(year) ? String(year) : date.slice(0, 4) || null;
}

function releaseCountryLabel(country?: string | null): string | null {
  const text = String(country || "").trim();
  if (!text || text === "[]") return null;

  const normalizeList = (values: unknown[]): string[] => values
    .map((item) => String(item || "").replace(/^\[|\]$/g, "").trim())
    .filter(Boolean);

  let countries: string[] = [];
  if (text.startsWith("[") && text.endsWith("]")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        countries = normalizeList(parsed);
      }
    } catch {
      countries = normalizeList(text.replace(/^\[|\]$/g, "").split(","));
    }
  } else {
    countries = normalizeList(text.split(","));
  }

  if (countries.length === 0) {
    return null;
  }
  if (countries.length > 4) {
    return `${countries.length} countries`;
  }
  return countries.join(", ");
}

function releaseDisambiguationLabel(disambiguation?: string | null): string | null {
  const text = String(disambiguation || "").trim();
  if (!text) return null;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function releaseCountLabel(count: number | null | undefined, singular: string, plural: string): string | null {
  if (count == null || !Number.isFinite(count) || count <= 0) return null;
  return `${count} ${count === 1 ? singular : plural}`;
}

function releaseStatusLabel(status?: string | null): string | null {
  const text = String(status || "").trim();
  if (!text || text.toLowerCase() === "official") return null;
  return text;
}

function releaseMetaParts(release: ReleaseGroupAvailability["releases"][number]): string[] {
  return [
    releaseYear(release.date),
    releaseCountryLabel(release.country),
    releaseCountLabel(release.mediumCount, "medium", "media"),
    releaseCountLabel(release.trackCount, "track", "tracks"),
    release.format ? `[${release.format}]` : null,
    release.duration ? formatDurationSeconds(release.duration) : null,
    releaseStatusLabel(release.status),
  ].filter((part): part is string => Boolean(part));
}

function isSpatialQuality(quality?: string | null): boolean {
  const normalized = String(quality || "").toUpperCase();
  return normalized.includes("ATMOS") || normalized.includes("SPATIAL") || normalized.includes("360");
}

function sameProviderAlbumSelection(left: string | null | undefined, right: string | null | undefined): boolean {
  const split = (value: string | null | undefined) => String(value || "")
    .split(/[;+]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .sort();
  const a = split(left);
  const b = split(right);
  return a.length > 0 && a.length === b.length && a.every((id, index) => id === b[index]);
}

function offersForSlot(
  release: ReleaseGroupAvailability["releases"][number],
  slot: SwitchableSlot,
): Array<ReleaseGroupAvailability["releases"][number]["availability"][number]> {
  const exact = release.availability.filter((offer) => String(offer.librarySlot || "").toLowerCase() === slot);
  const pool = exact.length > 0
    ? exact
    : release.availability.filter((offer) => slot === "spatial" ? isSpatialQuality(offer.quality) : !isSpatialQuality(offer.quality));
  const deduped = new Map<string, ReleaseGroupAvailability["releases"][number]["availability"][number]>();
  for (const offer of pool) {
    const key = `${offer.provider || ""}|${String(offer.providerAlbumId || "")}`;
    if (!deduped.has(key)) {
      deduped.set(key, offer);
    }
  }
  return Array.from(deduped.values());
}

export function selectedOfferExplicitForSlot(
  availability: ReleaseGroupAvailability | null,
  slot: SwitchableSlot,
  fallback: { provider?: string | null; providerAlbumId?: string | null; releaseMbid?: string | null },
): boolean | null {
  if (!availability) {
    return null;
  }

  const selectedReleaseMbid = availability.selectedReleaseBySlot[slot] || fallback.releaseMbid;
  const selectedOffer = availability.selectedOfferBySlot?.[slot];
  const provider = selectedOffer?.provider || fallback.provider;
  const providerAlbumId = selectedOffer?.providerAlbumId || fallback.providerAlbumId;
  if (!selectedReleaseMbid || !provider || !providerAlbumId) {
    return null;
  }

  const release = availability.releases.find((candidate) => candidate.releaseMbid === selectedReleaseMbid);
  const offer = release && offersForSlot(release, slot).find((candidate) => (
    candidate.provider === provider
    && sameProviderAlbumSelection(candidate.providerAlbumId, providerAlbumId)
  ));
  return offer?.explicit ?? null;
}

function sortReleasesForSwitcher(
  releases: ReleaseGroupAvailability["releases"],
  selectedReleaseBySlot: ReleaseGroupAvailability["selectedReleaseBySlot"],
  includeSpatial: boolean,
): ReleaseGroupAvailability["releases"] {
  const slots = activeSwitchableSlots(includeSpatial);
  return releases
    .map((release, index) => {
      const selected = slots.some((slot) => selectedReleaseBySlot[slot] === release.releaseMbid);
      const available = release.availability.length > 0;
      return { release, index, rank: selected ? 0 : available ? 1 : 2 };
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.release);
}

const useStyles = makeStyles({
  releaseSwitcher: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    width: "100%",
  },
  releaseRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingBottom: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackgroundAlpha,
    backdropFilter: "blur(10px)",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
    "@media (min-width: 820px)": {
      gridTemplateColumns: "minmax(0, 1fr) auto",
      alignItems: "center",
      gap: tokens.spacingHorizontalL,
    },
  },
  releaseMain: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
  },
  releaseTitleRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  releaseTitle: {
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  releaseMeta: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
    color: tokens.colorNeutralForeground2,
    minWidth: 0,
  },
  releaseAvailability: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: tokens.spacingVerticalXS,
    minWidth: 0,
    width: "100%",
  },
  slotOfferRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
    width: "100%",
  },
  slotOfferLabel: {
    color: tokens.colorNeutralForeground3,
    minWidth: "52px",
    flexShrink: 0,
    paddingTop: tokens.spacingVerticalXXS,
  },
  slotOfferPills: {
    flex: "1 1 0",
    minWidth: 0,
  },
  unavailableText: {
    color: tokens.colorNeutralForeground3,
  },
});

export interface ReleaseSwitcherProps {
  availability: ReleaseGroupAvailability;
  currentReleaseMbid?: string | null;
  includeSpatial: boolean;
  pendingSelectionKey?: string | null;
  onSelect: (slot: SwitchableSlot, releaseMbid: string, offer: ReleaseGroupAvailability["releases"][number]["availability"][number]) => void;
}

export function ReleaseSwitcher({
  availability,
  currentReleaseMbid,
  includeSpatial,
  pendingSelectionKey,
  onSelect,
}: ReleaseSwitcherProps) {
  const styles = useStyles();
  const slots = activeSwitchableSlots(includeSpatial);
  const releases = sortReleasesForSwitcher(availability.releases, availability.selectedReleaseBySlot, includeSpatial);

  if (releases.length === 0) {
    return null;
  }

  return (
    <div className={styles.releaseSwitcher}>
      {releases.map((release) => {
        const disambiguation = releaseDisambiguationLabel(release.disambiguation);
        const metaParts = releaseMetaParts(release);
        const selectedSlots = slots.filter((slot) => availability.selectedReleaseBySlot[slot] === release.releaseMbid);
        const providerOffers = Array.from(release.availability.reduce((deduped, offer) => {
          const slot = String(offer.librarySlot || "").toLowerCase();
          if (slot !== "stereo" && slot !== "spatial") {
            return deduped;
          }
          if (!includeSpatial && slot === "spatial") {
            return deduped;
          }
          const key = `${offer.provider || ""}|${slot}|${offer.quality || ""}`;
          if (!deduped.has(key)) {
            deduped.set(key, {
              slot,
              quality: offer.quality,
              provider: offer.provider,
              matchStatus: offer.status,
              matchKind: offer.matchKind,
              coverageSummary: offer.coverageSummary,
              providerAlbumId: offer.providerAlbumId,
              providerAlbumIds: offer.providerAlbumIds,
              selectedReleaseMbid: release.releaseMbid,
            } satisfies ProviderQualityOffer);
          }
          return deduped;
        }, new Map<string, ProviderQualityOffer>()).values());

        return (
          <Card key={release.releaseMbid} className={styles.releaseRow}>
            <div className={styles.releaseMain}>
              <div className={styles.releaseTitleRow}>
                <Text weight="semibold" className={styles.releaseTitle}>
                  {release.title || "Untitled release"}
                </Text>
                {disambiguation ? (
                  <Badge appearance="outline" color="subtle">{disambiguation}</Badge>
                ) : null}
                {release.releaseMbid === currentReleaseMbid ? (
                  <Badge appearance="outline" color="subtle">Current page</Badge>
                ) : null}
                {selectedSlots.map((slot) => (
                  <Badge key={slot} appearance="tint" color="success">{slotLabel(slot)}</Badge>
                ))}
              </div>
              <div className={styles.releaseMeta}>
                {metaParts.length > 0 ? <Text size={200}>{metaParts.join(" · ")}</Text> : null}
                <AppTooltip content={release.releaseMbid} relationship="label">
                  <Text size={100}>{release.releaseMbid}</Text>
                </AppTooltip>
              </div>
              <div className={styles.releaseAvailability}>
                {providerOffers.length === 0 ? (
                  <Text size={200} className={styles.unavailableText}>No matched provider offer</Text>
                ) : slots.map((slot) => {
                  const slotOffers = offersForSlot(release, slot);
                  if (slotOffers.length === 0) {
                    return null;
                  }
                  const releaseSelectedForSlot = availability.selectedReleaseBySlot[slot] === release.releaseMbid;
                  const selectedOffer = availability.selectedOfferBySlot?.[slot];
                  const rowOffers: ProviderQualityOffer[] = slotOffers.map((offer) => ({
                    slot,
                    quality: offer.quality,
                    provider: offer.provider,
                    matchStatus: offer.status,
                    matchKind: offer.matchKind,
                    coverageSummary: offer.coverageSummary,
                    providerAlbumId: offer.providerAlbumId,
                    providerAlbumIds: offer.providerAlbumIds,
                    selectedReleaseMbid: release.releaseMbid,
                    explicit: offer.explicit,
                  }));
                  const pending = pendingSelectionKey === `${slot}:${release.releaseMbid}`;
                  return (
                    <div key={slot} className={styles.slotOfferRow}>
                      <Text size={200} className={styles.slotOfferLabel}>
                        {pending ? "Saving..." : slotLabel(slot)}
                      </Text>
                      <div className={styles.slotOfferPills}>
                        <ProviderQualityRow
                          offers={rowOffers}
                          size="small"
                          onSelectOffer={pendingSelectionKey ? undefined : (picked) => {
                            const source = slotOffers.find((offer) =>
                              offer.provider === picked.provider
                              && sameProviderAlbumSelection(offer.providerAlbumId, picked.providerAlbumId));
                            if (source) {
                              onSelect(slot, release.releaseMbid, source);
                            }
                          }}
                          selectedOfferAlbumId={releaseSelectedForSlot ? selectedOffer?.providerAlbumId ?? null : null}
                          selectedOfferProvider={releaseSelectedForSlot ? selectedOffer?.provider ?? null : null}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
