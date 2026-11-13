import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Link,
  Switch,
  Tab,
  TabList,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  Checkmark16Regular,
  Dismiss24Regular,
  LockClosed16Regular,
  Search20Regular,
} from "@fluentui/react-icons";
import { useMemo, useState } from "react";
import { AppTooltip } from "@/components/ui/AppTooltip";
import { ProviderQualityRow } from "@/components/ui/ProviderQualityPill";
import type { ReleaseGroupAvailability } from "@/hooks/useAlbumPage";
import {
  EXPLICIT_LABEL,
  QUALITY_TIER_LABEL,
  audioLibrariesForAvailability,
  bestOfferViewsForLibrary,
  editionExplicitGate,
  librarySlot,
  planMatchesEditionGate,
  providerLabel,
  releaseMeta,
  selectableOffers,
  selectedPlanSummary,
  sortEditionsForAvailability,
  sortPlansGroupedByProvider,
  type AvailabilityLibrary,
  type AvailabilityPlan,
  type AvailabilityRelease,
  type AvailabilitySelection,
} from "@/pages/album/editionAvailability";

export interface ManageEditionsDialogProps {
  open: boolean;
  onClose: () => void;
  availability: ReleaseGroupAvailability | null;
  currentReleaseMbid?: string | null;
  pendingSelectionKey?: string | null;
  decisionLabel?: string | null;
  decisionAction?: string | null;
  onBackToAutomatic?: () => void;
  onSelect: (libraryId: number, editionId: number, providerEditionMatchId: number) => void;
  onSelectPlan?: (
    libraryId: number,
    editionId: number,
    planKey: string,
    mode: "exclusive" | "additive",
  ) => void;
  onRevertPlan?: (libraryId: number, editionId: number) => void;
  onRemoveEdition?: (libraryId: number, editionId: number) => void;
  onSetRepresentative?: (libraryId: number, editionId: number) => void;
}

const useStyles = makeStyles({
  surface: {
    width: "min(94vw, 880px)",
    maxWidth: "880px",
    maxHeight: "88vh",
    display: "flex",
    flexDirection: "column",
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
  },
  content: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    overflowY: "auto",
    paddingTop: tokens.spacingVerticalXS,
  },
  toolbar: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  toolbarTop: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
  },
  searchRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
  },
  searchInput: {
    flex: "1 1 240px",
    minWidth: "200px",
  },
  curationBanner: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  editionList: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  editionCard: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  editionCardMonitored: {
    border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  editionHeader: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
  },
  editionIdentity: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    minWidth: 0,
    flex: "1 1 320px",
  },
  titleBadgesRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  editionTitle: {
    fontWeight: tokens.fontWeightSemibold,
  },
  editionDisambiguation: {
    color: tokens.colorNeutralForeground2,
  },
  editionMeta: {
    color: tokens.colorNeutralForeground2,
  },
  mbidLink: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    wordBreak: "break-all",
  },
  editionActions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  plansSection: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalXS,
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke3}`,
  },
  plansHeader: {
    color: tokens.colorNeutralForeground2,
    fontWeight: tokens.fontWeightSemibold,
  },
  planGrid: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
  },
  planButton: {
    display: "inline-flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "2px",
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "inherit",
    ":hover": {
      border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1Hover}`,
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
    },
  },
  planButtonSelected: {
    border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
    ":hover": {
      border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke1}`,
      backgroundColor: tokens.colorBrandBackground2Hover,
    },
  },
  planButtonTitle: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  planButtonDetail: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground2,
  },
  emptyNote: {
    padding: `${tokens.spacingVerticalL} 0`,
    textAlign: "center",
    color: tokens.colorNeutralForeground2,
  },
});

function releaseMatchesQuery(release: AvailabilityRelease, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if ((release.title || "").toLowerCase().includes(needle)) return true;
  if ((release.disambiguation || "").toLowerCase().includes(needle)) return true;
  if ((release.country || "").toLowerCase().includes(needle)) return true;
  if ((release.mbid || "").toLowerCase().includes(needle)) return true;
  if (release.offers.some((offer) =>
    offer.provider.toLowerCase().includes(needle)
    || providerLabel(offer.provider).toLowerCase().includes(needle)
    || offer.providerId.toLowerCase().includes(needle))) {
    return true;
  }
  return false;
}

function plansForLibrary(
  library: AvailabilityLibrary,
  release: AvailabilityRelease,
): AvailabilityPlan[] {
  const seen = new Map<string, AvailabilityPlan>();
  for (const selection of library.selections) {
    if (selection.editionId !== release.id) continue;
    for (const plan of selection.plans) {
      if (!seen.has(plan.planKey)) {
        seen.set(plan.planKey, plan);
      }
    }
    if (selection.plan && !seen.has(selection.plan.planKey)) {
      seen.set(selection.plan.planKey, selection.plan);
    }
  }
  const gate = editionExplicitGate(release);
  const all = [...seen.values()];
  const gated = all.filter((plan) => planMatchesEditionGate(plan, gate));
  return sortPlansGroupedByProvider(gated.length > 0 ? gated : all);
}

export function ManageEditionsDialog({
  open,
  onClose,
  availability,
  currentReleaseMbid,
  pendingSelectionKey,
  decisionLabel,
  decisionAction,
  onBackToAutomatic,
  onSelect,
  onSelectPlan,
  onRevertPlan,
  onRemoveEdition,
  onSetRepresentative,
}: ManageEditionsDialogProps) {
  const styles = useStyles();
  const [selectedLibraryId, setSelectedLibraryId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showAllEditions, setShowAllEditions] = useState(false);
  const [keepOtherEditions, setKeepOtherEditions] = useState(false);

  const audioLibraries = useMemo(
    () => (availability ? audioLibrariesForAvailability(availability) : []),
    [availability],
  );

  const activeLibrary = useMemo(() => {
    if (audioLibraries.length === 0) return null;
    if (selectedLibraryId != null) {
      const match = audioLibraries.find((lib) => lib.id === selectedLibraryId);
      if (match) return match;
    }
    return audioLibraries[0];
  }, [audioLibraries, selectedLibraryId]);

  const monitoredByEditionId = useMemo(() => {
    const map = new Map<number, AvailabilitySelection>();
    if (!activeLibrary) return map;
    for (const selection of activeLibrary.selections) {
      if (selection.monitored) {
        map.set(selection.editionId, selection);
      }
    }
    return map;
  }, [activeLibrary]);

  const monitoredIds = useMemo(
    () => new Set(monitoredByEditionId.keys()),
    [monitoredByEditionId],
  );

  const hasMatchedOrMonitored = useMemo(() => {
    if (!availability) return false;
    return availability.releases.some((release) =>
      monitoredIds.has(release.id)
      || selectableOffers(release).length > 0
      || (activeLibrary ? plansForLibrary(activeLibrary, release).length > 0 : false));
  }, [activeLibrary, availability, monitoredIds]);

  const visibleReleases = useMemo(() => {
    if (!availability || !activeLibrary) return [];
    const effectiveShowAll = showAllEditions || !hasMatchedOrMonitored;
    const filtered = availability.releases.filter((release) => {
      if (!releaseMatchesQuery(release, searchQuery)) return false;
      if (effectiveShowAll) return true;
      return (
        monitoredIds.has(release.id)
        || selectableOffers(release).length > 0
        || plansForLibrary(activeLibrary, release).length > 0
      );
    });
    return sortEditionsForAvailability(filtered, monitoredIds);
  }, [activeLibrary, availability, hasMatchedOrMonitored, monitoredIds, searchQuery, showAllEditions]);

  if (!availability || !activeLibrary) {
    return null;
  }

  const activeSlotLabel = activeLibrary.name || (librarySlot(activeLibrary) === "spatial" ? "Spatial" : "Stereo");
  const monitoredCount = monitoredByEditionId.size;

  return (
    <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) onClose(); }} modalType="modal">
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle
            action={
              <Button
                appearance="subtle"
                aria-label="Close"
                icon={<Dismiss24Regular />}
                onClick={onClose}
              />
            }
          >
            Manage editions &amp; sources
          </DialogTitle>

          <DialogContent className={styles.content}>
            <div className={styles.toolbar}>
              <div className={styles.toolbarTop}>
                {audioLibraries.length > 1 ? (
                  <TabList
                    selectedValue={activeLibrary.id}
                    onTabSelect={(_, data) => setSelectedLibraryId(Number(data.value))}
                    aria-label="Audio libraries"
                  >
                    {audioLibraries.map((library) => (
                      <Tab key={library.id} value={library.id}>
                        {library.name || (librarySlot(library) === "spatial" ? "Spatial" : "Stereo")}
                      </Tab>
                    ))}
                  </TabList>
                ) : (
                  <Text size={300} weight="semibold">
                    {activeSlotLabel} library
                  </Text>
                )}

                <Switch
                  checked={keepOtherEditions}
                  onChange={(_, data) => setKeepOtherEditions(data.checked)}
                  label="Keep other monitored editions"
                />
              </div>

              {decisionLabel || decisionAction === "back_to_automatic" ? (
                <div className={styles.curationBanner}>
                  <Text size={200}>
                    {decisionLabel || "Manual edition overrides are active."}
                  </Text>
                  {decisionAction === "back_to_automatic" && onBackToAutomatic ? (
                    <Button size="small" appearance="subtle" onClick={onBackToAutomatic}>
                      Back to automatic
                    </Button>
                  ) : null}
                </div>
              ) : null}

              <div className={styles.searchRow}>
                <Input
                  className={styles.searchInput}
                  value={searchQuery}
                  onChange={(_, data) => setSearchQuery(data.value)}
                  contentBefore={<Search20Regular />}
                  placeholder="Filter editions by title, region, MBID, or provider…"
                  aria-label="Filter editions"
                />
                {hasMatchedOrMonitored ? (
                  <Switch
                    checked={showAllEditions}
                    onChange={(_, data) => setShowAllEditions(data.checked)}
                    label="Show all MusicBrainz editions"
                  />
                ) : null}
              </div>
            </div>

            {visibleReleases.length === 0 ? (
              <Text className={styles.emptyNote}>
                No editions match the current filter.
              </Text>
            ) : (
              <div className={styles.editionList}>
                {visibleReleases.map((release) => {
                  const selection = monitoredByEditionId.get(release.id) ?? null;
                  const isMonitored = Boolean(selection);
                  const isPrimary = Boolean(selection?.representative)
                    || (!selection && Boolean(currentReleaseMbid && release.mbid === currentReleaseMbid));
                  const plans = plansForLibrary(activeLibrary, release);
                  const fallbackOffers = bestOfferViewsForLibrary(release, activeLibrary);
                  const rawOffers = selectableOffers(release);
                  const canMonitor = plans.length > 0 || rawOffers.length > 0;
                  const meta = releaseMeta(release);

                  const handleMonitorToggle = (checked: boolean) => {
                    if (!checked) {
                      onRemoveEdition?.(activeLibrary.id, release.id);
                      return;
                    }
                    const mode: "exclusive" | "additive" = keepOtherEditions ? "additive" : "exclusive";
                    if (plans.length > 0 && onSelectPlan) {
                      onSelectPlan(activeLibrary.id, release.id, plans[0].planKey, mode);
                    } else if (rawOffers.length > 0) {
                      onSelect(activeLibrary.id, release.id, rawOffers[0].providerEditionMatchId);
                    }
                  };

                  return (
                    <div
                      key={release.id}
                      className={mergeClasses(
                        styles.editionCard,
                        isMonitored && styles.editionCardMonitored,
                      )}
                    >
                      <div className={styles.editionHeader}>
                        <div className={styles.editionIdentity}>
                          <div className={styles.titleBadgesRow}>
                            <Text size={300} className={styles.editionTitle}>
                              {release.title}
                            </Text>
                            {release.disambiguation ? (
                              <Text size={200} className={styles.editionDisambiguation}>
                                ({release.disambiguation})
                              </Text>
                            ) : null}
                            {isPrimary && (isMonitored || monitoredCount === 0) ? (
                              <Badge size="small" appearance="filled" color="brand">
                                Primary
                              </Badge>
                            ) : null}
                            {isMonitored ? (
                              <Badge size="small" appearance="tint" color="success">
                                Monitored
                              </Badge>
                            ) : null}
                            {selection?.locked ? (
                              <Badge
                                size="small"
                                appearance="outline"
                                color="warning"
                                icon={<LockClosed16Regular />}
                              >
                                Locked
                              </Badge>
                            ) : null}
                          </div>

                          {meta ? (
                            <Text size={200} className={styles.editionMeta}>
                              {meta}
                            </Text>
                          ) : null}

                          {release.mbid ? (
                            <Link
                              href={`https://musicbrainz.org/release/${release.mbid}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={styles.mbidLink}
                            >
                              {release.mbid}
                            </Link>
                          ) : null}
                        </div>

                        <div className={styles.editionActions}>
                          {isMonitored && !selection?.representative && monitoredCount >= 2 && onSetRepresentative ? (
                            <Button
                              size="small"
                              appearance="subtle"
                              onClick={() => onSetRepresentative(activeLibrary.id, release.id)}
                            >
                              Set as Primary
                            </Button>
                          ) : null}

                          <AppTooltip
                            content={isMonitored
                              ? `Stop monitoring ${release.title} in ${activeSlotLabel}`
                              : canMonitor
                                ? `Monitor ${release.title} in ${activeSlotLabel}`
                                : "No provider offers available for this edition"}
                            relationship="label"
                          >
                            <Switch
                              checked={isMonitored}
                              disabled={!isMonitored && !canMonitor}
                              aria-label={isMonitored
                                ? `Stop monitoring ${release.title} in the ${activeSlotLabel.toLowerCase()} library`
                                : `Monitor ${release.title} in the ${activeSlotLabel.toLowerCase()} library`}
                              onChange={(_, data) => handleMonitorToggle(data.checked)}
                            />
                          </AppTooltip>
                        </div>
                      </div>

                      {plans.length > 0 ? (
                        <div className={styles.plansSection}>
                          <Text size={200} className={styles.plansHeader}>
                            Acquisition source
                          </Text>
                          <div className={styles.planGrid}>
                            <button
                              type="button"
                              className={mergeClasses(
                                styles.planButton,
                                isMonitored && selection?.planSelectionMode === "auto" && styles.planButtonSelected,
                              )}
                              onClick={() => {
                                if (isMonitored) {
                                  onRevertPlan?.(activeLibrary.id, release.id);
                                } else {
                                  onSelectPlan?.(
                                    activeLibrary.id,
                                    release.id,
                                    plans[0].planKey,
                                    keepOtherEditions ? "additive" : "exclusive",
                                  );
                                }
                              }}
                            >
                              <span className={styles.planButtonTitle}>
                                {isMonitored && selection?.planSelectionMode === "auto" ? (
                                  <Checkmark16Regular />
                                ) : null}
                                Automatic (best per settings)
                              </span>
                              <span className={styles.planButtonDetail}>
                                Planner selects the highest-ranked eligible offer
                              </span>
                            </button>

                            {plans.map((plan) => {
                              const summary = selectedPlanSummary(plan, release);
                              const isActivePlan = Boolean(
                                isMonitored && selection?.plan?.planKey === plan.planKey,
                              );
                              const tier = QUALITY_TIER_LABEL[plan.qualityTier] ?? plan.qualityTier;
                              const explicit = EXPLICIT_LABEL[plan.explicitContent] ?? plan.explicitContent;
                              const stateNote = plan.state === "stale"
                                ? " · Stale"
                                : (plan.state === "unavailable" || plan.state === "failed")
                                  ? " · Unavailable"
                                  : "";
                              return (
                                <AppTooltip key={plan.planKey} content={summary.tooltip} relationship="description">
                                  <button
                                    type="button"
                                    className={mergeClasses(
                                      styles.planButton,
                                      isActivePlan && styles.planButtonSelected,
                                    )}
                                    onClick={() => {
                                      const mode: "exclusive" | "additive" = (keepOtherEditions || isMonitored)
                                        ? "additive"
                                        : "exclusive";
                                      onSelectPlan?.(activeLibrary.id, release.id, plan.planKey, mode);
                                    }}
                                  >
                                    <span className={styles.planButtonTitle}>
                                      {isActivePlan ? <Checkmark16Regular /> : null}
                                      {providerLabel(plan.provider)} · {tier} · {explicit}
                                    </span>
                                    <span className={styles.planButtonDetail}>
                                      {summary.detail}{stateNote}
                                    </span>
                                  </button>
                                </AppTooltip>
                              );
                            })}
                          </div>
                        </div>
                      ) : fallbackOffers.length > 0 ? (
                        <div className={styles.plansSection}>
                          <Text size={200} className={styles.plansHeader}>
                            Provider offers
                          </Text>
                          <ProviderQualityRow
                            size="medium"
                            offers={fallbackOffers}
                            onSelectOffer={pendingSelectionKey
                              ? undefined
                              : (offer) => {
                                  const match = rawOffers.find((item) =>
                                    item.provider === offer.provider && item.providerId === offer.providerAlbumId);
                                  if (match) {
                                    onSelect(activeLibrary.id, release.id, match.providerEditionMatchId);
                                  }
                                }}
                          />
                        </div>
                      ) : isMonitored ? (
                        <div className={styles.plansSection}>
                          <Text size={200} className={styles.editionMeta}>
                            No current plan
                          </Text>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </DialogContent>

          <DialogActions>
            <Button appearance="primary" onClick={onClose}>
              Done
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
