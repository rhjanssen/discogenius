import {
  Badge,
  Button,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Settings20Regular } from "@fluentui/react-icons";
import type { ReleaseGroupAvailability } from "@/hooks/useAlbumPage";
import {
  audioLibrariesForAvailability,
  librarySlot,
  releaseMeta,
  selectedPlanSummary,
} from "@/pages/album/editionAvailability";

export interface EditionsSummaryBarProps {
  availability: ReleaseGroupAvailability | null;
  isLoading?: boolean;
  decisionLabel?: string | null;
  decisionAction?: string | null;
  onBackToAutomatic?: () => void;
  onOpenDialog: () => void;
}

const useStyles = makeStyles({
  bar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    marginBottom: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    backdropFilter: "blur(30px) saturate(125%)",
    WebkitBackdropFilter: "blur(30px) saturate(125%)",
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha}`,
    boxShadow: tokens.shadow4,
  },
  summaryList: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    minWidth: 0,
    flex: "1 1 320px",
  },
  libraryRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  libraryLabel: {
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
    minWidth: "56px",
  },
  selectionItem: {
    display: "inline-flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
  },
  editionTitle: {
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  mutedText: {
    color: tokens.colorNeutralForeground2,
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
});

export function EditionsSummaryBar({
  availability,
  isLoading = false,
  decisionLabel,
  decisionAction,
  onBackToAutomatic,
  onOpenDialog,
}: EditionsSummaryBarProps) {
  const styles = useStyles();

  if (isLoading && !availability) {
    return (
      <div className={styles.bar}>
        <div className={styles.libraryRow}>
          <Spinner size="tiny" />
          <Text size={200} className={styles.mutedText}>
            Loading editions &amp; sources…
          </Text>
        </div>
      </div>
    );
  }

  if (!availability || availability.releases.length === 0) {
    return null;
  }

  const audioLibraries = audioLibrariesForAvailability(availability);
  const releaseById = new Map(availability.releases.map((release) => [release.id, release]));

  return (
    <div className={styles.bar} data-testid="editions-summary-bar">
      <div className={styles.summaryList}>
        {audioLibraries.map((library) => {
          const monitored = library.selections.filter((selection) => selection.monitored);
          const slotLabel = library.name || (librarySlot(library) === "spatial" ? "Spatial" : "Stereo");
          return (
            <div key={library.id} className={styles.libraryRow}>
              <Text size={200} className={styles.libraryLabel}>
                {slotLabel}
              </Text>
              {monitored.length === 0 ? (
                <Text size={200} className={styles.mutedText}>
                  No editions monitored
                </Text>
              ) : (
                monitored.map((selection, index) => {
                  const release = releaseById.get(selection.editionId);
                  if (!release) return null;
                  const meta = releaseMeta(release);
                  const planSummary = selection.plan
                    ? selectedPlanSummary(selection.plan, release)
                    : null;
                  return (
                    <span key={selection.libraryEditionId} className={styles.selectionItem}>
                      {index > 0 ? <Text size={200} className={styles.mutedText}>·</Text> : null}
                      <Text size={200} className={styles.editionTitle}>
                        {release.title}
                        {release.disambiguation ? ` (${release.disambiguation})` : ""}
                      </Text>
                      {selection.representative && monitored.length > 1 ? (
                        <Badge size="small" appearance="tint" color="brand">
                          Primary
                        </Badge>
                      ) : null}
                      {meta ? (
                        <Text size={200} className={styles.mutedText}>
                          {meta}
                        </Text>
                      ) : null}
                      {planSummary ? (
                        <Badge size="small" appearance="outline" color="subtle">
                          {planSummary.headline}
                          {selection.planSelectionMode === "manual" ? " · Manual" : " · Auto"}
                        </Badge>
                      ) : (
                        <Badge size="small" appearance="outline" color="warning">
                          No current plan
                        </Badge>
                      )}
                    </span>
                  );
                })
              )}
            </div>
          );
        })}
        {decisionLabel ? (
          <Text size={200} className={styles.mutedText}>
            {decisionLabel}
          </Text>
        ) : null}
      </div>

      <div className={styles.actions}>
        {decisionAction === "back_to_automatic" && onBackToAutomatic ? (
          <Button size="small" appearance="subtle" onClick={onBackToAutomatic}>
            Back to automatic
          </Button>
        ) : null}
        <Button
          size="small"
          appearance="secondary"
          icon={<Settings20Regular />}
          onClick={onOpenDialog}
        >
          Manage editions &amp; sources
        </Button>
      </div>
    </div>
  );
}
