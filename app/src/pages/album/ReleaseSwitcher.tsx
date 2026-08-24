import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  Checkbox,
  Link,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { useState } from "react";
import { AppTooltip } from "@/components/ui/AppTooltip";
import {
  editionCountLabel,
  editionMediaLabel,
  editionMediaRank,
  editionRegionLabel,
} from "@/pages/album/editionDisplay";
import {
  ProviderQualityRow,
  type ProviderQualityOffer,
} from "@/components/ui/ProviderQualityPill";
import {
  acquisitionPlanDisplayQuality,
  formatAcquisitionPlanCoverageSummary,
} from "@/utils/acquisitionPlanCoverage";
import type { ReleaseGroupAvailability } from "@/hooks/useAlbumPage";
import { isSamePlanOffer } from "@/utils/providerOfferSelection";

type Release = ReleaseGroupAvailability["releases"][number];
type Library = ReleaseGroupAvailability["libraries"][number];
type Offer = Release["offers"][number];
type Selection = Library["selections"][number];
type AcquisitionPlan = Selection["plans"][number];
type AudioQuality = Offer["variants"][number]["qualityClass"];

const AUDIO_QUALITIES = new Set<AudioQuality>([
  "lossy",
  "lossless",
  "hires-lossless",
  "spatial",
]);

const UNAVAILABLE_STATES = new Set([
  "unavailable",
  "no_longer_available",
  "geography_restricted",
  "entitlement_restricted",
  "explicit_policy_ineligible",
  "quality_unavailable",
]);

const QUALITY_RANK: Record<AudioQuality, number> = {
  lossy: 1,
  lossless: 2,
  "hires-lossless": 3,
  spatial: 4,
};

function releaseYear(date?: string | null): string | null {
  if (!date) return null;
  const year = new Date(date).getFullYear();
  return Number.isFinite(year) ? String(year) : date.slice(0, 4) || null;
}

/** Media type · year · disc/track counts · region (status when not Official). */
function releaseMeta(release: Release): string {
  const counts = [
    editionCountLabel(release.mediumCount, "medium", "media"),
    editionCountLabel(release.trackCount, "track", "tracks"),
  ].filter(Boolean).join(" · ");
  return [
    editionMediaLabel(release.mediaFormats),
    releaseYear(release.date),
    counts || null,
    editionRegionLabel(release.country),
    release.status?.toLowerCase() === "official" ? null : release.status,
  ].filter(Boolean).join(" · ");
}

/**
 * Resolve exclusive vs additive plan selection from an explicit checkbox or
 * an optional desktop keyboard modifier.
 *
 * - Ctrl/Cmd on an *inactive* plan or unmonitored edition: additive.
 * - Ctrl/Cmd on the *active* plan of a monitored edition: unmonitor (caller).
 * - Already-monitored edition without Ctrl: plan switch only.
 * - Plain click on an unmonitored edition: exclusive.
 */
function planSelectionMode(
  event: { ctrlKey?: boolean; metaKey?: boolean },
  editionAlreadyMonitored: boolean,
  keepOtherEditions: boolean,
): "exclusive" | "additive" {
  if (keepOtherEditions || event.ctrlKey || event.metaKey || editionAlreadyMonitored) return "additive";
  return "exclusive";
}

function isAvailable(value: string): boolean {
  return !UNAVAILABLE_STATES.has(value.trim().toLowerCase());
}

function selectableOffers(release: Release): Offer[] {
  return release.offers.filter((offer) =>
    offer.matchState === "accepted"
    && isAvailable(offer.availability)
    && offer.variants.some((variant) => isAvailable(variant.availability)));
}

function libraryQualities(library: Library): Set<AudioQuality> {
  return new Set(library.allowedSourceFormats.filter(
    (quality): quality is AudioQuality => AUDIO_QUALITIES.has(quality as AudioQuality),
  ));
}

function librarySlot(library: Library): "stereo" | "spatial" {
  const allowed = libraryQualities(library);
  return allowed.has("spatial") && allowed.size === 1 ? "spatial" : "stereo";
}

function providerLabel(provider: string): string {
  const key = provider.trim().toLowerCase();
  if (key === "tidal") return "TIDAL";
  if (key.startsWith("apple")) return "Apple Music";
  if (key.includes("amazon")) return "Amazon Music";
  if (key.includes("youtube")) return "YouTube Music";
  if (key === "deezer") return "Deezer";
  if (key === "soundcloud") return "SoundCloud";
  if (key === "spotify") return "Spotify";
  return provider;
}

/** Map a plan's normalized quality_tier onto the badge vocabulary. */
function planQualityTag(plan: AcquisitionPlan): string {
  return acquisitionPlanDisplayQuality(plan);
}

const QUALITY_TIER_LABEL: Record<string, string> = {
  "hires-lossless": "Hi-Res",
  lossless: "Lossless",
  lossy: "High",
  spatial: "Spatial",
};

const EXPLICIT_LABEL: Record<string, string> = {
  explicit: "Explicit",
  clean: "Clean",
  unknown: "Explicitness unknown",
};

/** MB edition title/disambiguation clearly says clean or explicit (else null). */
function editionExplicitGate(
  release: Release,
): "explicit" | "clean" | null {
  const text = `${release.title || ""} ${release.disambiguation || ""}`.toLowerCase();
  if (/\bexplicit\b/.test(text)) return "explicit";
  if (/\bclean\b|\bcensored\b/.test(text)) return "clean";
  return null;
}

function planMatchesEditionGate(
  plan: AcquisitionPlan,
  gate: "explicit" | "clean" | null,
): boolean {
  if (!gate) return true;
  if (plan.explicitContent === "unknown") return true;
  if (gate === "explicit" && plan.explicitContent === "clean") return false;
  if (gate === "clean" && plan.explicitContent === "explicit") return false;
  return true;
}

/**
 * Providers ordered by best (lowest) rank; within a provider keep rank order so
 * explicit and clean from the same service sit side-by-side (one icon group).
 */
function sortPlansGroupedByProvider(plans: readonly AcquisitionPlan[]): AcquisitionPlan[] {
  const byRank = [...plans].sort((left, right) =>
    left.rank - right.rank || left.id - right.id);
  const groups = new Map<string, AcquisitionPlan[]>();
  const order: string[] = [];
  for (const plan of byRank) {
    const list = groups.get(plan.provider);
    if (!list) {
      order.push(plan.provider);
      groups.set(plan.provider, [plan]);
    } else {
      list.push(plan);
    }
  }
  return order.flatMap((provider) => groups.get(provider) || []);
}

/**
 * One badge per acquisition plan — not one badge per raw provider-release
 * quality variant. The plan already collapsed the offer to the quality tier it
 * delivers; exploding variants again made the row look like several plans.
 */
function planToQualityOffer(
  plan: AcquisitionPlan,
  release: Release,
  library: Library,
): ProviderQualityOffer {
  const slot = librarySlot(library);
  const sourceOffers = plan.providerEditionMatchIds
    .map((matchId) => release.offers.find((offer) => offer.providerEditionMatchId === matchId))
    .filter((offer): offer is Offer => Boolean(offer));
  // Primary first so the quality-pill tooltip leads with the main album id,
  // not a 1-track EP that only fills a hole in a composite.
  const ordered = [...sourceOffers].sort((left, right) => {
    const leftPrimary = left.providerEditionMatchId === plan.primaryProviderEditionMatchId ? 0 : 1;
    const rightPrimary = right.providerEditionMatchId === plan.primaryProviderEditionMatchId ? 0 : 1;
    return leftPrimary - rightPrimary;
  });
  const albumIds = ordered
    .map((offer) => String(offer.providerId || "").trim())
    .filter(Boolean);
  const primary = ordered[0];
  const isComposite = plan.composition === "composite" || albumIds.length > 1;
  return {
    slot,
    // A plan is what the user selects, and provider + album id does not
    // identify one: two plans on the same edition can share both.
    planKey: plan.planKey,
    quality: planQualityTag(plan),
    provider: plan.provider,
    matchStatus: "verified",
    matchKind: isComposite ? "composite" : "direct",
    coverageSummary: formatAcquisitionPlanCoverageSummary({
      composition: isComposite ? "composite" : "single_source",
      relation: primary?.relation ?? null,
      coverage: plan.coverage,
      targetTrackCount: plan.targetTrackCount,
    }),
    providerAlbumId: albumIds.join(";"),
    providerAlbumIds: albumIds,
    providerUrl: primary?.providerUrl ?? null,
    selectedReleaseMbid: release.mbid,
    explicit: plan.explicitContent === "explicit"
      ? true
      : plan.explicitContent === "clean"
        ? false
        : null,
    available: plan.state !== "unavailable" && plan.state !== "failed",
  };
}

/** Fallback when plans have not been computed yet: one badge per offer, best quality only. */
function bestOfferViewsForLibrary(release: Release, library: Library): ProviderQualityOffer[] {
  const allowed = libraryQualities(library);
  const slot = librarySlot(library);
  const byProviderAlbum = new Map<string, ProviderQualityOffer>();
  for (const offer of selectableOffers(release)) {
    const variants = offer.variants
      .filter((variant) => allowed.has(variant.qualityClass) && isAvailable(variant.availability))
      .sort((left, right) => (QUALITY_RANK[right.qualityClass] || 0) - (QUALITY_RANK[left.qualityClass] || 0));
    const best = variants[0];
    if (!best) continue;
    const key = `${offer.provider}\0${offer.providerId}`;
    byProviderAlbum.set(key, {
      slot,
      quality: best.qualityClass === "hires-lossless"
        ? "HIRES_LOSSLESS"
        : best.qualityClass === "spatial"
          ? (best.spatialFormat === "atmos" ? "DOLBY_ATMOS" : "SPATIAL")
          : best.qualityClass === "lossless"
            ? "LOSSLESS"
            : "HIGH",
      provider: offer.provider,
      matchStatus: offer.matchState === "accepted" ? "verified" : offer.matchState,
      matchKind: "direct",
      coverageSummary: formatAcquisitionPlanCoverageSummary({
        composition: "single_source",
        relation: offer.relation,
        // Pre-plan fallback: treat as full coverage when we only know the offer.
        coverage: 1,
        targetTrackCount: 1,
      }),
      providerAlbumId: offer.providerId,
      providerAlbumIds: [offer.providerId],
      providerUrl: offer.providerUrl,
      selectedReleaseMbid: release.mbid,
      available: true,
    });
  }
  return [...byProviderAlbum.values()];
}

function bestQualityRank(release: Release): number {
  return Math.max(
    0,
    ...selectableOffers(release).flatMap((offer) =>
      offer.variants.map((variant) => QUALITY_RANK[variant.qualityClass] || 0)),
  );
}

/** Compact one-line summary of the plan currently in use. */
function selectedPlanSummary(plan: AcquisitionPlan, release: Release): {
  headline: string;
  detail: string;
  tooltip: string;
} {
  const sourceOffers = plan.providerEditionMatchIds
    .map((matchId) => release.offers.find((offer) => offer.providerEditionMatchId === matchId))
    .filter((offer): offer is Offer => Boolean(offer));
  const ordered = [...sourceOffers].sort((left, right) => {
    const leftPrimary = left.providerEditionMatchId === plan.primaryProviderEditionMatchId ? 0 : 1;
    const rightPrimary = right.providerEditionMatchId === plan.primaryProviderEditionMatchId ? 0 : 1;
    return leftPrimary - rightPrimary;
  });
  const ids = ordered.map((offer) => String(offer.providerId || "").trim()).filter(Boolean);
  const primary = ordered[0];
  const isComposite = plan.composition === "composite" || ids.length > 1;
  const detail = formatAcquisitionPlanCoverageSummary({
    composition: isComposite ? "composite" : "single_source",
    relation: primary?.relation ?? null,
    coverage: plan.coverage,
    targetTrackCount: plan.targetTrackCount,
  });
  const tier = QUALITY_TIER_LABEL[plan.qualityTier] ?? plan.qualityTier;
  const explicit = EXPLICIT_LABEL[plan.explicitContent] ?? plan.explicitContent;
  const headline = `${providerLabel(plan.provider)} · ${tier} · ${explicit}`;
  const idLine = ids.length === 0
    ? ""
    : ids.length === 1
      ? `${providerLabel(plan.provider)} album ID: ${ids[0]}`
      : `${providerLabel(plan.provider)} album IDs (primary first):\n${ids.map((id, i) => `${i === 0 ? "•" : "·"} ${id}`).join("\n")}`;
  const tooltip = [
    detail,
    idLine,
    release.mbid ? `MusicBrainz edition ${release.mbid}` : null,
    plan.state === "stale" ? "Plan is stale — re-curate to refresh." : null,
    plan.state === "unavailable" || plan.state === "failed" ? "Plan is currently unavailable." : null,
  ].filter(Boolean).join("\n");
  return { headline, detail, tooltip };
}

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    width: "100%",
  },
  /**
   * Shared two-column track on desktop so every edition's left (facts) column
   * is the same width — sized to the widest content, capped at 50%.
   * Each .release uses subgrid to join that track while keeping its own glass.
   */
  list: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    width: "100%",
    "@media (min-width: 768px)": {
      display: "grid",
      // fit-content(50%) = min(max-content, 50%) for the shared left track
      gridTemplateColumns: "fit-content(50%) minmax(0, 1fr)",
      columnGap: tokens.spacingHorizontalL,
      rowGap: tokens.spacingVerticalS,
    },
  },
  /**
   * Resting glass by default (not hover-only) — same layer as the sticky nav:
   * colorNeutralBackgroundAlpha2 + blur over UltraBlur. Selection still lives
   * only on the active plan pill, not as a heavier outer border.
   */
  release: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
    boxSizing: "border-box",
    color: tokens.colorNeutralForeground1,
    // Always-on glass (nav surface), not transparent-until-hover like glass buttons.
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    backdropFilter: "blur(30px) saturate(125%)",
    WebkitBackdropFilter: "blur(30px) saturate(125%)",
    borderRadius: tokens.borderRadiusLarge,
    overflow: "hidden",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha}`,
    boxShadow: tokens.shadow4,
    width: "100%",
    "@media (min-width: 768px)": {
      display: "grid",
      gridTemplateColumns: "subgrid",
      gridColumn: "1 / -1",
      alignItems: "center",
      // Space between edition facts and Stereo/Spatial plans (subgrid must set
      // its own gap — parent list gap alone does not separate the text).
      columnGap: tokens.spacingHorizontalM,
      padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
    },
  },
  details: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    // Title → meta → MBID hierarchy with tight secondary gaps
    gap: tokens.spacingVerticalXXS,
  },
  titleRow: {
    display: "flex",
    alignItems: "baseline",
    flexWrap: "wrap",
    columnGap: tokens.spacingHorizontalS,
    rowGap: tokens.spacingVerticalXXS,
  },
  version: {
    color: tokens.colorNeutralForeground2,
    fontWeight: tokens.fontWeightRegular,
  },
  metadata: {
    color: tokens.colorNeutralForeground2,
  },
  mbid: {
    color: tokens.colorNeutralForeground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    wordBreak: "break-all",
  },
  /** Edition MBID as a plain-looking link; brand colour only on hover. */
  mbidLink: {
    color: "inherit",
    textDecorationLine: "none",
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    wordBreak: "break-all",
    ":hover": {
      color: tokens.colorBrandForegroundLinkHover,
      textDecorationLine: "none",
    },
    ":hover:active": {
      color: tokens.colorBrandForegroundLinkPressed,
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
    },
  },
  // Slot rows: label + plans on one horizontal line.
  libraries: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    minWidth: 0,
    width: "100%",
  },
  // Empty plan cell still occupies the right track so columns stay aligned.
  librariesEmpty: {
    minWidth: 0,
    width: "100%",
  },
  // Stereo + Spatial both present — more space so the two plan rows read as separate.
  librariesMultiSlot: {
    gap: tokens.spacingVerticalM,
  },
  libraryRow: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    // Keep label + pills on one row; pills wrap inside planInline if needed.
    flexWrap: "nowrap",
    columnGap: tokens.spacingHorizontalS,
    minWidth: 0,
    width: "100%",
  },
  libraryLabel: {
    flex: "0 0 auto",
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightBase200,
  },
  planInline: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: tokens.spacingHorizontalXS,
    rowGap: tokens.spacingVerticalXXS,
    minWidth: 0,
    flex: "1 1 auto",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    flexWrap: "nowrap",
    columnGap: tokens.spacingHorizontalXS,
    flex: "0 0 auto",
  },
  additiveChoice: {
    flex: "0 0 auto",
    "& label": {
      fontSize: tokens.fontSizeBase200,
    },
  },
  unavailable: {
    color: tokens.colorNeutralForeground3,
  },
  catalogAccordion: {
    backgroundColor: "transparent",
    borderRadius: tokens.borderRadiusMedium,
    marginTop: tokens.spacingVerticalS,
  },
  catalogPanel: {
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalM,
  },
});

export interface ReleaseSwitcherProps {
  availability: ReleaseGroupAvailability;
  /** @deprecated Kept for call-site compatibility; no longer rendered as a badge. */
  currentReleaseMbid?: string | null;
  pendingSelectionKey?: string | null;
  onSelect: (libraryId: number, editionId: number, providerEditionMatchId: number) => void;
  /**
   * Use this edition and execute this plan for the library.
   *
   * - Plain click on an unmonitored edition: exclusive — only this edition
   *   stays monitored for the album in this library.
   * - Select "Keep other editions" before choosing an inactive plan for
   *   additive multi-edition monitoring. Ctrl/Cmd+click remains a shortcut.
   * - Use the visible Stop monitoring action to remove one edition.
   * - Click on an already-monitored edition without Ctrl: plan switch only.
   */
  onSelectPlan?: (
    libraryId: number,
    editionId: number,
    planKey: string,
    mode: "exclusive" | "additive",
  ) => void;
  onRevertPlan?: (libraryId: number, editionId: number) => void;
  /** Unmonitor this edition from the selected library. */
  onRemoveEdition?: (libraryId: number, editionId: number) => void;
}

export function ReleaseSwitcher({
  availability,
  pendingSelectionKey,
  onSelect,
  onSelectPlan,
  onRevertPlan,
  onRemoveEdition,
}: ReleaseSwitcherProps) {
  const styles = useStyles();
  const [keepOtherEditions, setKeepOtherEditions] = useState<Set<string>>(() => new Set());
  if (availability.releases.length === 0) return null;

  // Stereo first, then Spatial. API only returns enabled libraries (Spatial off
  // ⇒ no spatial library row). Drop Video — not an audio acquisition slot.
  const audioLibraries = availability.libraries
    .filter((library) => {
      const qualities = libraryQualities(library);
      if (qualities.size === 0) return false;
      const onlyVideo = [...qualities].every((q) => String(q) === "video");
      return !onlyVideo;
    })
    .sort((left, right) => {
      const leftSlot = librarySlot(left) === "spatial" ? 1 : 0;
      const rightSlot = librarySlot(right) === "spatial" ? 1 : 0;
      return leftSlot - rightSlot || left.id - right.id;
    });
  // Single audio library (typical: Stereo only) — no redundant "Stereo" label.
  const showSlotLabels = audioLibraries.length > 1;

  const selectedReleaseIds = new Set(
    audioLibraries.flatMap((library) =>
      library.selections
        .filter((selection) => selection.monitored)
        .map((selection) => selection.editionId)),
  );
  // Monitored first, then media type (Digital > CD > Vinyl), larger tracklists
  // before smaller, then quality / confidence / date as soft tie-breaks.
  const sorted = [...availability.releases].sort((left, right) =>
    Number(selectedReleaseIds.has(right.id)) - Number(selectedReleaseIds.has(left.id))
    || Number(selectableOffers(right).length > 0) - Number(selectableOffers(left).length > 0)
    || editionMediaRank(left.mediaFormats) - editionMediaRank(right.mediaFormats)
    || (right.trackCount || 0) - (left.trackCount || 0)
    || bestQualityRank(right) - bestQualityRank(left)
    || Math.max(0, ...right.offers.map((offer) => offer.confidence))
      - Math.max(0, ...left.offers.map((offer) => offer.confidence))
    || String(left.date || "9999").localeCompare(String(right.date || "9999"))
    || left.id - right.id);
  // Matched = has an accepted provider offer and/or is already monitored.
  // Catalog-only = pure MusicBrainz editions with no usable provider offer yet
  // (shown collapsed so they remain discoverable).
  const matched = sorted.filter((release) =>
    selectableOffers(release).length > 0 || selectedReleaseIds.has(release.id));
  const catalogOnly = sorted.filter((release) =>
    !matched.some((entry) => entry.id === release.id));

  /** One compact row: "Stereo" | "Spatial" + provider plan pills inline. */
  const renderLibraryRow = (release: Release, library: Library) => {
    const selection = library.selections.find(
      (candidate) => candidate.editionId === release.id,
    );
    const explicitGate = editionExplicitGate(release);
    const gatedPlans = sortPlansGroupedByProvider(
      (selection?.plans ?? []).filter((plan) => planMatchesEditionGate(plan, explicitGate)),
    );
    const planOffers = gatedPlans.map((plan) =>
      planToQualityOffer(plan, release, library));
    const badgeOffers = planOffers.length > 0
      ? planOffers
      : bestOfferViewsForLibrary(release, library).filter((offer) => {
        if (!explicitGate || offer.explicit == null) return true;
        if (explicitGate === "explicit" && offer.explicit === false) return false;
        if (explicitGate === "clean" && offer.explicit === true) return false;
        return true;
      });
    const monitored = Boolean(selection?.monitored);
    // A selected Edition can temporarily lose every usable provider offer.
    // Keep the row and its remove action available, or the user has no way to
    // withdraw that exact LibraryEditions row from the UI.
    if (badgeOffers.length === 0 && !monitored) return null;

    // Only highlight a plan when this edition is monitored in this library.
    // Prefer a gated plan that is still chosen; never highlight a clean plan on
    // an explicit MB edition (and vice versa).
    const chosenPlan = selection?.monitored
      ? (gatedPlans.find((plan) => plan.chosen)
        ?? (selection.plan && planMatchesEditionGate(selection.plan, explicitGate)
          ? selection.plan
          : null)
        ?? null)
      : null;
    const chosenView = chosenPlan
      ? planToQualityOffer(chosenPlan, release, library)
      : null;
    const rowPending = Boolean(pendingSelectionKey?.startsWith(`${library.id}:${release.id}:`));
    const summary = chosenPlan ? selectedPlanSummary(chosenPlan, release) : null;
    const slot = librarySlot(library);
    const slotLabel = slot === "spatial" ? "Spatial" : "Stereo";
    const additiveKey = `${library.id}:${release.id}`;
    const keepOthers = keepOtherEditions.has(additiveKey);
    const labelHint = rowPending
      ? "Saving…"
      : monitored
        ? (selection?.planSelectionMode === "manual" ? "Chosen by you" : "Automatic")
        : "Choose a plan to monitor this edition";

    const tooltipBody = [
      showSlotLabels ? slotLabel : null,
      library.qualityProfile,
      labelHint,
      selection?.locked
        ? "Locked — automatic curation will not change this album."
        : null,
      summary?.tooltip,
    ].filter(Boolean).join("\n") || slotLabel;

    return (
      <div key={library.id} className={styles.libraryRow}>
        {showSlotLabels ? (
          <AppTooltip content={tooltipBody} relationship="description">
            <Text className={styles.libraryLabel}>{slotLabel}</Text>
          </AppTooltip>
        ) : null}

        <div className={styles.planInline}>
          {!monitored && onSelectPlan ? (
            <Checkbox
              className={styles.additiveChoice}
              checked={keepOthers}
              label="Keep other editions"
              aria-label={`Keep other monitored ${slotLabel.toLowerCase()} editions when adding ${release.title || "this edition"}`}
              onChange={(_event, data) => {
                setKeepOtherEditions((current) => {
                  const next = new Set(current);
                  if (data.checked === true) next.add(additiveKey);
                  else next.delete(additiveKey);
                  return next;
                });
              }}
            />
          ) : null}
          {(() => {
            const plans = badgeOffers.length > 0 ? (
              <ProviderQualityRow
                offers={badgeOffers}
                size="small"
                selectedOfferAlbumId={chosenView?.providerAlbumId ?? null}
                selectedOfferProvider={chosenPlan?.provider ?? null}
                selectedOfferPlanKey={chosenPlan?.planKey ?? null}
                onSelectOffer={pendingSelectionKey || !onSelectPlan
                  ? undefined
                  : (picked, event) => {
                    const plan = (selection?.plans ?? []).find((candidate) => {
                      const view = planToQualityOffer(candidate, release, library);
                      return isSamePlanOffer(view, picked);
                    });
                    if (plan) {
                      const isActive = Boolean(
                        chosenView && isSamePlanOffer(chosenView, picked),
                      );
                      // Keep the keyboard modifier as a desktop shortcut. The
                      // checkbox and explicit remove button make every action
                      // available to touch and assistive-technology users.
                      if (
                        isActive
                        && monitored
                        && (event.ctrlKey || event.metaKey)
                        && onRemoveEdition
                      ) {
                        onRemoveEdition(library.id, release.id);
                        return;
                      }
                      onSelectPlan(
                        library.id,
                        release.id,
                        plan.planKey,
                        planSelectionMode(event, monitored, keepOthers),
                      );
                      return;
                    }
                    const offer = selectableOffers(release).find((candidate) =>
                      candidate.provider === picked.provider
                      && candidate.providerId === picked.providerAlbumId);
                    if (offer) {
                      onSelect(library.id, release.id, offer.providerEditionMatchId);
                    }
                  }}
              />
            ) : (
              <Text size={200} className={styles.unavailable}>No current plan</Text>
            );
            // When the slot label is hidden, put the context tooltip on the plans.
            return showSlotLabels
              ? plans
              : (
                <AppTooltip content={tooltipBody} relationship="description">
                  {plans}
                </AppTooltip>
              );
          })()}
          {selection?.locked ? (
            <Badge appearance="tint" color="warning" size="small">Locked</Badge>
          ) : null}
          {monitored && selection?.planSelectionMode === "manual" && onRevertPlan ? (
            <div className={styles.actions}>
              <Button
                size="small"
                appearance="subtle"
                onClick={() => onRevertPlan(library.id, release.id)}
              >
                Use automatic
              </Button>
            </div>
          ) : null}
          {monitored && onRemoveEdition ? (
            <Button
              size="small"
              appearance="subtle"
              onClick={() => onRemoveEdition(library.id, release.id)}
              aria-label={`Stop monitoring ${release.title || "this edition"} in the ${slotLabel.toLowerCase()} library`}
            >
              Stop monitoring
            </Button>
          ) : null}
        </div>
      </div>
    );
  };

  const renderRelease = (release: Release) => {
    const offers = selectableOffers(release);
    const meta = releaseMeta(release);
    const title = release.title || "Untitled edition";
    const version = release.disambiguation
      && release.disambiguation !== release.title
      ? release.disambiguation
      : null;

    const libraryRows = audioLibraries
      .map((library) => renderLibraryRow(release, library))
      .filter(Boolean);

    return (
      <div key={release.id} className={styles.release}>
        <div className={styles.details}>
          <div className={styles.titleRow}>
            <Text weight="semibold">{title}</Text>
            {version ? (
              <Text size={200} className={styles.version}>{version}</Text>
            ) : null}
          </div>
          {meta ? <Text size={200} className={styles.metadata}>{meta}</Text> : null}
          {release.mbid ? (
            <Link
              href={`https://musicbrainz.org/release/${release.mbid}`}
              target="_blank"
              rel="noreferrer noopener"
              className={mergeClasses(styles.mbid, styles.mbidLink)}
            >
              {release.mbid}
            </Link>
          ) : null}
          {offers.length === 0 ? (
            <Text size={200} className={styles.unavailable}>No accepted provider match</Text>
          ) : libraryRows.length === 0 ? (
            <Text size={200} className={styles.unavailable}>No plan for current libraries</Text>
          ) : null}
        </div>

        {libraryRows.length > 0 ? (
          <div
            className={mergeClasses(
              styles.libraries,
              showSlotLabels && styles.librariesMultiSlot,
            )}
          >
            {libraryRows}
          </div>
        ) : (
          // Keep the right grid track so left columns stay aligned across rows.
          <div className={styles.librariesEmpty} aria-hidden="true" />
        )}
      </div>
    );
  };

  return (
    <div className={styles.root}>
      {matched.length > 0 ? (
        <div className={styles.list}>{matched.map(renderRelease)}</div>
      ) : (
        <Text className={styles.unavailable}>
          No provider matches are available yet. Use Refresh &amp; Scan on the artist when you want to discover offers.
        </Text>
      )}
      {catalogOnly.length > 0 ? (
        <Accordion collapsible className={styles.catalogAccordion}>
          <AccordionItem value="catalog-only">
            <AccordionHeader>
              Other MusicBrainz editions ({catalogOnly.length})
            </AccordionHeader>
            <AccordionPanel className={styles.catalogPanel}>
              <div className={styles.list}>{catalogOnly.map(renderRelease)}</div>
            </AccordionPanel>
          </AccordionItem>
        </Accordion>
      ) : null}
    </div>
  );
}
