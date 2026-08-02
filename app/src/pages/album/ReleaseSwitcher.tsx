import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  Card,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { AppTooltip } from "@/components/ui/AppTooltip";
import {
  ProviderQualityRow,
  type ProviderQualityOffer,
} from "@/components/ui/ProviderQualityPill";
import type { ReleaseGroupAvailability } from "@/hooks/useAlbumPage";

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

function releaseCountryLabel(country?: string | null): string | null {
  const text = String(country || "").trim();
  if (!text || text === "[]") return null;
  let countries: string[];
  try {
    const parsed = JSON.parse(text);
    countries = Array.isArray(parsed) ? parsed.map(String) : [text];
  } catch {
    countries = text.split(",");
  }
  const normalized = countries.map((value) => value.trim()).filter(Boolean);
  if (normalized.length === 0) return null;
  if (normalized.length > 4) return `${normalized.length} territories`;
  return normalized.join(", ");
}

function countLabel(count: number | null, singular: string, plural: string): string | null {
  if (count == null || count <= 0) return null;
  return `${count} ${count === 1 ? singular : plural}`;
}

function releaseMeta(release: Release): string {
  return [
    releaseYear(release.date),
    releaseCountryLabel(release.country),
    countLabel(release.mediumCount, "medium", "media"),
    countLabel(release.trackCount, "track", "tracks"),
    release.status?.toLowerCase() === "official" ? null : release.status,
  ].filter(Boolean).join(" · ");
}

/**
 * Resolve exclusive vs additive plan selection from the click modifiers.
 *
 * - Ctrl/Cmd: always additive (add/switch plan without unmonitoring siblings).
 * - Already-monitored edition: plan switch only — do not collapse multi-monitor.
 * - Plain click on an unmonitored edition: exclusive (replace the monitored set).
 */
function planSelectionMode(
  event: { ctrlKey?: boolean; metaKey?: boolean },
  editionAlreadyMonitored: boolean,
): "exclusive" | "additive" {
  if (event.ctrlKey || event.metaKey || editionAlreadyMonitored) return "additive";
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
function planQualityTag(plan: AcquisitionPlan, release: Release): string {
  const tier = String(plan.qualityTier || "").toLowerCase();
  if (tier === "hires-lossless") return "HIRES_LOSSLESS";
  if (tier === "lossless") return "LOSSLESS";
  if (tier === "lossy") return "HIGH";
  if (tier === "spatial") {
    const atmos = plan.providerEditionMatchIds.some((matchId) => {
      const offer = release.offers.find((candidate) => candidate.providerEditionMatchId === matchId);
      return offer?.variants.some((variant) =>
        variant.qualityClass === "spatial" && variant.spatialFormat === "atmos");
    });
    return atmos ? "DOLBY_ATMOS" : "SPATIAL";
  }
  return plan.qualityTier || "LOSSLESS";
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

const RELATION_LABEL: Record<string, string> = {
  exact: "Exact match",
  source_superset: "Superset match",
  source_subset: "Subset match",
  overlap: "Overlap match",
};

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
  const coverage = plan.targetTrackCount > 0
    ? `${plan.coverage}/${plan.targetTrackCount} tracks`
    : `${plan.coverage} tracks`;
  const relation = primary?.relation
    ? (RELATION_LABEL[primary.relation] ?? primary.relation.replace(/_/g, " "))
    : null;
  return {
    slot,
    quality: planQualityTag(plan, release),
    provider: plan.provider,
    matchStatus: "verified",
    matchKind: isComposite ? "composite" : "direct",
    coverageSummary: isComposite
      ? `Composite · ${albumIds.length} sources · ${coverage}`
      : [
        "Single-source",
        relation,
        coverage,
      ].filter(Boolean).join(" · "),
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
      coverageSummary: offer.relation === "exact"
        ? "Single-source · exact edition match"
        : `Single-source · ${offer.relation.replace(/_/g, " ")}`,
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
  const coverage = plan.targetTrackCount > 0
    ? `${plan.coverage}/${plan.targetTrackCount} tracks`
    : `${plan.coverage} tracks`;
  const relation = primary?.relation
    ? (RELATION_LABEL[primary.relation] ?? primary.relation.replace(/_/g, " "))
    : null;
  const detail = isComposite
    ? `Composite · ${ids.length} sources · ${coverage}`
    : ["Single-source", relation, coverage].filter(Boolean).join(" · ");
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
  list: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  release: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalM,
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow2,
  },
  releaseMonitored: {
    border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke1}`,
    boxShadow: tokens.shadow4,
  },
  details: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
  },
  metadata: {
    color: tokens.colorNeutralForeground2,
  },
  libraries: {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: tokens.spacingVerticalM,
    "@media (min-width: 720px)": {
      gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
      columnGap: tokens.spacingHorizontalL,
    },
  },
  libraryColumn: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    minWidth: 0,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  libraryColumnActive: {
    border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  libraryHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  libraryTitle: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: 0,
  },
  planSummary: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: 0,
  },
  planSummaryHeadline: {
    color: tokens.colorNeutralForeground1,
  },
  actions: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXS,
    marginTop: tokens.spacingVerticalXXS,
  },
  unavailable: {
    color: tokens.colorNeutralForeground3,
  },
  hint: {
    color: tokens.colorNeutralForeground3,
  },
  catalogAccordion: {
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
  },
  catalogPanel: {
    paddingBottom: tokens.spacingVerticalM,
  },
});

export interface ReleaseSwitcherProps {
  availability: ReleaseGroupAvailability;
  currentReleaseMbid?: string | null;
  pendingSelectionKey?: string | null;
  onSelect: (libraryId: number, editionId: number, providerEditionMatchId: number) => void;
  /**
   * Use this edition and execute this plan for the library.
   *
   * - Plain click on an unmonitored edition: exclusive — only this edition
   *   stays monitored for the album in this library.
   * - Ctrl/Cmd+click: additive — monitor this edition without unmonitoring
   *   others (e.g. keep Dreams and also monitor Deluxe).
   * - Click on an already-monitored edition (any modifier): plan switch only
   *   for that edition; sibling editions stay monitored.
   */
  onSelectPlan?: (
    libraryId: number,
    editionId: number,
    planKey: string,
    mode: "exclusive" | "additive",
  ) => void;
  onRevertPlan?: (libraryId: number, editionId: number) => void;
  onRemoveEdition?: (libraryId: number, editionId: number) => void;
}

export function ReleaseSwitcher({
  availability,
  currentReleaseMbid,
  pendingSelectionKey,
  onSelect,
  onSelectPlan,
  onRevertPlan,
  onRemoveEdition,
}: ReleaseSwitcherProps) {
  const styles = useStyles();
  if (availability.releases.length === 0) return null;

  // Stereo first, then Spatial. Hide libraries with no audio qualities (e.g. Video).
  const audioLibraries = availability.libraries
    .filter((library) => libraryQualities(library).size > 0)
    .sort((left, right) => {
      const leftSlot = librarySlot(left) === "spatial" ? 1 : 0;
      const rightSlot = librarySlot(right) === "spatial" ? 1 : 0;
      return leftSlot - rightSlot || left.id - right.id;
    });

  const selectedReleaseIds = new Set(
    audioLibraries.flatMap((library) =>
      library.selections
        .filter((selection) => selection.monitored)
        .map((selection) => selection.editionId)),
  );
  const sorted = [...availability.releases].sort((left, right) =>
    Number(selectedReleaseIds.has(right.id)) - Number(selectedReleaseIds.has(left.id))
    || Number(selectableOffers(right).length > 0) - Number(selectableOffers(left).length > 0)
    || bestQualityRank(right) - bestQualityRank(left)
    || Math.max(0, ...right.offers.map((offer) => offer.confidence))
      - Math.max(0, ...left.offers.map((offer) => offer.confidence))
    || String(left.date || "9999").localeCompare(String(right.date || "9999"))
    || left.id - right.id);
  const matched = sorted.filter((release) =>
    selectableOffers(release).length > 0 || selectedReleaseIds.has(release.id));
  const catalogOnly = sorted.filter((release) =>
    selectableOffers(release).length === 0 && !selectedReleaseIds.has(release.id));

  const renderLibraryColumn = (release: Release, library: Library) => {
    const selection = library.selections.find(
      (candidate) => candidate.editionId === release.id,
    );
    const planOffers = (selection?.plans ?? []).map((plan) =>
      planToQualityOffer(plan, release, library));
    const badgeOffers = planOffers.length > 0
      ? planOffers
      : bestOfferViewsForLibrary(release, library);
    if (badgeOffers.length === 0) return null;

    const chosenPlan = selection?.monitored
      ? (selection.plan ?? selection.plans.find((plan) => plan.chosen) ?? null)
      : null;
    const chosenView = chosenPlan
      ? planToQualityOffer(chosenPlan, release, library)
      : null;
    const rowPending = Boolean(pendingSelectionKey?.startsWith(`${library.id}:${release.id}:`));
    const monitored = Boolean(selection?.monitored);
    const summary = chosenPlan ? selectedPlanSummary(chosenPlan, release) : null;
    const slot = librarySlot(library);
    const slotLabel = slot === "spatial" ? "Spatial" : "Stereo";

    return (
      <div
        key={library.id}
        className={mergeClasses(
          styles.libraryColumn,
          monitored ? styles.libraryColumnActive : undefined,
        )}
      >
        <div className={styles.libraryHeader}>
          <div className={styles.libraryTitle}>
            <Text size={200} weight="semibold">{slotLabel}</Text>
            <Text size={100} className={styles.metadata}>
              {rowPending
                ? "Saving…"
                : monitored
                  ? (selection?.planSelectionMode === "manual" ? "Chosen by you" : "Automatic")
                  : library.qualityProfile}
            </Text>
          </div>
          {monitored ? (
            <Badge appearance="tint" color="brand" size="small">Monitoring</Badge>
          ) : null}
          {selection?.locked ? (
            <AppTooltip
              content="Automatic curation will not change this album. Your own choices still apply."
              relationship="description"
            >
              <Badge appearance="tint" color="warning" size="small">Locked</Badge>
            </AppTooltip>
          ) : null}
        </div>

        <ProviderQualityRow
          offers={badgeOffers}
          size="small"
          selectedOfferAlbumId={chosenView?.providerAlbumId ?? null}
          selectedOfferProvider={chosenPlan?.provider ?? null}
          onSelectOffer={pendingSelectionKey || !onSelectPlan
            ? undefined
            : (picked, event) => {
              const plan = (selection?.plans ?? []).find((candidate) => {
                const view = planToQualityOffer(candidate, release, library);
                return view.provider === picked.provider
                  && view.quality === picked.quality
                  && (
                    view.providerAlbumId === picked.providerAlbumId
                    || (picked.providerAlbumIds?.length
                      && view.providerAlbumIds?.join(";") === picked.providerAlbumIds.join(";"))
                  );
              });
              if (plan) {
                onSelectPlan(
                  library.id,
                  release.id,
                  plan.planKey,
                  planSelectionMode(event, Boolean(selection?.monitored)),
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

        {summary ? (
          <AppTooltip content={summary.tooltip} relationship="description">
            <div className={styles.planSummary}>
              <Text size={200} weight="semibold" className={styles.planSummaryHeadline}>
                {summary.headline}
              </Text>
              <Text size={100} className={styles.metadata}>{summary.detail}</Text>
            </div>
          </AppTooltip>
        ) : (
          <Text size={100} className={styles.hint}>
            Click a plan to monitor this edition
            {audioLibraries.length > 1 ? " · Ctrl+click to add alongside others" : ""}
          </Text>
        )}

        {monitored && (onRevertPlan || onRemoveEdition) ? (
          <div className={styles.actions}>
            {selection?.planSelectionMode === "manual" && onRevertPlan ? (
              <Button
                size="small"
                appearance="subtle"
                onClick={() => onRevertPlan(library.id, release.id)}
              >
                Use automatic
              </Button>
            ) : null}
            {onRemoveEdition ? (
              <Button
                size="small"
                appearance="subtle"
                onClick={() => onRemoveEdition(library.id, release.id)}
              >
                Stop monitoring
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const renderRelease = (release: Release) => {
    const offers = selectableOffers(release);
    const meta = releaseMeta(release);
    const isMonitored = selectedReleaseIds.has(release.id);
    const monitoredSlots = audioLibraries
      .filter((library) =>
        library.selections.some(
          (selection) => selection.editionId === release.id && selection.monitored,
        ))
      .map((library) => (librarySlot(library) === "spatial" ? "Spatial" : "Stereo"));

    const libraryColumns = audioLibraries
      .map((library) => renderLibraryColumn(release, library))
      .filter(Boolean);

    return (
      <Card
        key={release.id}
        className={mergeClasses(
          styles.release,
          isMonitored ? styles.releaseMonitored : undefined,
        )}
      >
        <div className={styles.details}>
          <div className={styles.titleRow}>
            <Text weight="semibold">
              {release.disambiguation || release.title}
            </Text>
            {release.disambiguation && release.title
              && release.disambiguation !== release.title ? (
                <Text size={200} className={styles.metadata}>{release.title}</Text>
              ) : null}
            {isMonitored ? (
              <Badge appearance="filled" color="brand" size="small">
                {monitoredSlots.length > 0
                  ? `Monitoring · ${monitoredSlots.join(" + ")}`
                  : "Monitoring"}
              </Badge>
            ) : null}
            {release.mbid === currentReleaseMbid ? (
              <Badge appearance="outline" color="informative" size="small">
                Current page
              </Badge>
            ) : null}
          </div>
          {meta ? <Text size={200} className={styles.metadata}>{meta}</Text> : null}
          {offers.length === 0 ? (
            <Text size={200} className={styles.unavailable}>No accepted provider match</Text>
          ) : null}
        </div>

        {libraryColumns.length > 0 ? (
          <div className={styles.libraries}>{libraryColumns}</div>
        ) : null}
      </Card>
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
