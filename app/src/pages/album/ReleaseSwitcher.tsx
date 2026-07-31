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

function offersForLibrary(release: Release, library: Library): Array<{
  source: Offer;
  quality: AudioQuality;
  view: ProviderQualityOffer;
}> {
  const allowed = libraryQualities(library);
  const slot = allowed.has("spatial") && allowed.size === 1 ? "spatial" : "stereo";
  return selectableOffers(release).flatMap((offer) =>
    offer.variants
      .filter((variant) => allowed.has(variant.qualityClass) && isAvailable(variant.availability))
      .map((variant) => ({
        source: offer,
        quality: variant.qualityClass,
        view: {
          slot,
          quality: variant.qualityClass === "hires-lossless"
            ? "HIRES_LOSSLESS"
            : variant.qualityClass === "spatial"
              ? (variant.spatialFormat === "atmos" ? "DOLBY_ATMOS" : "SPATIAL")
              : variant.qualityClass === "lossless"
                ? "LOSSLESS"
                : "HIGH",
          provider: offer.provider,
          matchStatus: offer.matchState === "accepted" ? "verified" : offer.matchState,
          matchKind: "direct",
          coverageSummary: offer.relation === "exact"
            ? "Exact edition match"
            : `${offer.relation.replace(/_/g, " ")} · track download`,
          providerAlbumId: offer.providerId,
          providerUrl: offer.providerUrl,
          selectedReleaseMbid: release.mbid,
          available: true,
        },
      })));
}

function bestQualityRank(release: Release): number {
  return Math.max(
    0,
    ...selectableOffers(release).flatMap((offer) =>
      offer.variants.map((variant) => QUALITY_RANK[variant.qualityClass] || 0)),
  );
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
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalM,
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}`,
    boxShadow: tokens.shadow2,
    "@media (min-width: 900px)": {
      gridTemplateColumns: "minmax(260px, 0.8fr) minmax(420px, 1.2fr)",
      alignItems: "start",
      columnGap: tokens.spacingHorizontalXL,
    },
  },
  details: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
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
  sourceSummary: {
    color: tokens.colorNeutralForeground2,
  },
  libraries: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  libraryRow: {
    display: "grid",
    gridTemplateColumns: "minmax(120px, 0.3fr) minmax(0, 1fr)",
    alignItems: "start",
    gap: tokens.spacingHorizontalM,
  },
  libraryLabel: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  unavailable: {
    color: tokens.colorNeutralForeground3,
  },
  plans: {
    display: "flex",
    flexDirection: "column",
    rowGap: tokens.spacingVerticalXXS,
    marginTop: tokens.spacingVerticalXS,
  },
  planRow: {
    display: "flex",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  planLabel: {
    display: "flex",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalXS,
  },
  catalogAccordion: {
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
  },
  catalogPanel: {
    paddingBottom: tokens.spacingVerticalM,
  },
});

const QUALITY_TIER_LABEL: Record<string, string> = {
  "hires-lossless": "Hi-Res",
  lossless: "Lossless",
  lossy: "High",
  spatial: "Spatial",
};

function planLabel(plan: AcquisitionPlan): string {
  const tier = QUALITY_TIER_LABEL[plan.qualityTier] ?? plan.qualityTier;
  const shape = plan.composition === "composite" ? "combined sources" : "single edition";
  return `${plan.provider} · ${tier} · ${shape}`;
}

export interface ReleaseSwitcherProps {
  availability: ReleaseGroupAvailability;
  currentReleaseMbid?: string | null;
  pendingSelectionKey?: string | null;
  onSelect: (libraryId: number, editionId: number, providerEditionMatchId: number) => void;
  /** Choose which persisted acquisition plan this library executes. */
  onSelectPlan?: (libraryId: number, editionId: number, planKey: string) => void;
  /** Hand the plan choice back to the planner. */
  onRevertPlan?: (libraryId: number, editionId: number) => void;
}

export function ReleaseSwitcher({
  availability,
  currentReleaseMbid,
  pendingSelectionKey,
  onSelect,
  onSelectPlan,
  onRevertPlan,
}: ReleaseSwitcherProps) {
  const styles = useStyles();
  if (availability.releases.length === 0) return null;

  const audioLibraries = availability.libraries.filter(
    (library) => libraryQualities(library).size > 0,
  );
  const selectedReleaseIds = new Set(
    audioLibraries.flatMap((library) =>
      library.selections.map((selection) => selection.editionId)),
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

  const renderRelease = (release: Release) => {
    const offers = selectableOffers(release);
    const providerCount = new Set(offers.map((offer) => offer.provider)).size;
    const meta = releaseMeta(release);
    return (
      <Card key={release.id} className={styles.release}>
        <div className={styles.details}>
          <div className={styles.titleRow}>
            <Text weight="semibold">{release.title}</Text>
            {release.disambiguation ? (
              <Badge appearance="filled" color="informative">{release.disambiguation}</Badge>
            ) : null}
            {release.mbid === currentReleaseMbid ? (
              <Badge appearance="filled" color="brand">Current page</Badge>
            ) : null}
          </div>
          {meta ? <Text size={200} className={styles.metadata}>{meta}</Text> : null}
          {offers.length > 0 ? (
            <Text size={200} className={styles.sourceSummary}>
              {offers.length} provider {offers.length === 1 ? "offer" : "offers"} across{" "}
              {providerCount} {providerCount === 1 ? "provider" : "providers"}
            </Text>
          ) : (
            <Text size={200} className={styles.unavailable}>No accepted provider match</Text>
          )}
          <AppTooltip content={release.mbid} relationship="label">
            <Text size={100} className={styles.metadata}>{release.mbid}</Text>
          </AppTooltip>
        </div>

        {offers.length > 0 ? (
          <div className={styles.libraries}>
            {audioLibraries.map((library) => {
              const compatible = offersForLibrary(release, library);
              if (compatible.length === 0) return null;
              const selection = library.selections.find(
                (candidate) => candidate.editionId === release.id,
              );
              const selectedMatchId = selection?.plan?.primaryProviderEditionMatchId ?? null;
              const selectedOffer = compatible.find(
                ({ source }) => source.providerEditionMatchId === selectedMatchId,
              )?.source;
              const rowPending = compatible.some(({ source }) =>
                pendingSelectionKey === `${library.id}:${release.id}:${source.providerEditionMatchId}`);
              return (
                <div key={library.id} className={styles.libraryRow}>
                  <div className={styles.libraryLabel}>
                    <Text size={200} weight="semibold">{library.name}</Text>
                    <Text size={100} className={styles.metadata}>
                      {rowPending ? "Saving choice…" : `${library.qualityProfile} target`}
                    </Text>
                  </div>
                  <ProviderQualityRow
                    offers={compatible.map(({ view }) => view)}
                    size="small"
                    selectedOfferAlbumId={selectedOffer?.providerId ?? null}
                    selectedOfferProvider={selectedOffer?.provider ?? null}
                    onSelectOffer={pendingSelectionKey ? undefined : (picked) => {
                      const selected = compatible.find(({ source, quality }) =>
                        source.provider === picked.provider
                        && source.providerId === picked.providerAlbumId
                        && picked.quality === (
                          quality === "hires-lossless"
                            ? "HIRES_LOSSLESS"
                            : quality === "spatial"
                              ? (source.variants.find((variant) =>
                                variant.qualityClass === quality)?.spatialFormat === "atmos"
                                ? "DOLBY_ATMOS"
                                : "SPATIAL")
                              : quality === "lossless" ? "LOSSLESS" : "HIGH"
                        ));
                      if (selected) {
                        onSelect(library.id, release.id, selected.source.providerEditionMatchId);
                      }
                    }}
                  />
                  {selection && selection.plans.length > 0 && onSelectPlan ? (
                    <div className={styles.plans}>
                      <div className={styles.planRow}>
                        <Text size={100} className={styles.metadata}>
                          Acquisition plan
                        </Text>
                        {selection.planSelectionMode === "manual" ? (
                          <Badge appearance="tint" color="brand">Chosen by you</Badge>
                        ) : (
                          <Badge appearance="tint" color="informative">Automatic</Badge>
                        )}
                        {selection.planSelectionMode === "manual" && onRevertPlan ? (
                          <Button
                            size="small"
                            appearance="subtle"
                            onClick={() => onRevertPlan(library.id, release.id)}
                          >
                            Use automatic choice
                          </Button>
                        ) : null}
                      </div>
                      {selection.plans.map((plan) => (
                        <div key={plan.planKey} className={styles.planRow}>
                          <Button
                            size="small"
                            appearance={plan.chosen ? "primary" : "outline"}
                            disabled={plan.chosen}
                            onClick={() => onSelectPlan(library.id, release.id, plan.planKey)}
                          >
                            {planLabel(plan)}
                          </Button>
                          <Text size={100} className={styles.metadata}>
                            {plan.coverage} {plan.coverage === 1 ? "track" : "tracks"}
                          </Text>
                          {plan.explicitContent !== "mixed" ? (
                            <Badge appearance="outline" color="subtle">
                              {plan.explicitContent === "explicit" ? "Explicit" : "Clean"}
                            </Badge>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
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
