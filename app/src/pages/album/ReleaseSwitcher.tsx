import {
  Badge,
  Button,
  Card,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { AppTooltip } from "@/components/ui/AppTooltip";
import type { ReleaseGroupAvailability } from "@/hooks/useAlbumPage";

function releaseYear(date?: string | null): string | null {
  if (!date) return null;
  const year = new Date(date).getFullYear();
  return Number.isFinite(year) ? String(year) : date.slice(0, 4) || null;
}

function countLabel(count: number | null, singular: string, plural: string): string | null {
  if (count == null || count <= 0) return null;
  return `${count} ${count === 1 ? singular : plural}`;
}

function releaseMeta(release: ReleaseGroupAvailability["releases"][number]): string {
  return [
    releaseYear(release.date),
    release.country,
    countLabel(release.mediumCount, "medium", "media"),
    countLabel(release.trackCount, "track", "tracks"),
    release.status?.toLowerCase() === "official" ? null : release.status,
  ].filter(Boolean).join(" · ");
}

function qualityLabels(
  release: ReleaseGroupAvailability["releases"][number],
): string[] {
  return [...new Set(release.offers.flatMap((offer) =>
    offer.variants.map((variant) => variant.qualityClass)))];
}

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    width: "100%",
  },
  release: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackgroundAlpha,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
    "@media (min-width: 820px)": {
      gridTemplateColumns: "minmax(0, 1fr) minmax(280px, auto)",
      alignItems: "center",
      columnGap: tokens.spacingHorizontalL,
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
  providerRow: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXS,
  },
  libraries: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
  },
  libraryRow: {
    display: "grid",
    gridTemplateColumns: "minmax(90px, 1fr) auto",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  libraryState: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  },
  unavailable: {
    color: tokens.colorNeutralForeground3,
  },
});

export interface ReleaseSwitcherProps {
  availability: ReleaseGroupAvailability;
  currentReleaseMbid?: string | null;
  pendingSelectionKey?: string | null;
  onSelect: (libraryId: number, editionId: number) => void;
}

export function ReleaseSwitcher({
  availability,
  currentReleaseMbid,
  pendingSelectionKey,
  onSelect,
}: ReleaseSwitcherProps) {
  const styles = useStyles();
  if (availability.releases.length === 0) return null;

  const selectedReleaseIds = new Set(
    availability.libraries.flatMap((library) =>
      library.selections.map((selection) => selection.editionId)),
  );
  const releases = [...availability.releases].sort((left, right) =>
    Number(selectedReleaseIds.has(right.id)) - Number(selectedReleaseIds.has(left.id))
    || String(left.date || "9999").localeCompare(String(right.date || "9999"))
    || left.id - right.id);

  return (
    <div className={styles.root}>
      {releases.map((release) => {
        const qualities = qualityLabels(release);
        return (
          <Card key={release.id} className={styles.release}>
            <div className={styles.details}>
              <div className={styles.titleRow}>
                <Text weight="semibold">{release.title}</Text>
                {release.disambiguation ? (
                  <Badge appearance="outline">{release.disambiguation}</Badge>
                ) : null}
                {release.mbid === currentReleaseMbid ? (
                  <Badge appearance="outline">Current page</Badge>
                ) : null}
              </div>
              {releaseMeta(release) ? (
                <Text size={200} className={styles.metadata}>{releaseMeta(release)}</Text>
              ) : null}
              <div className={styles.providerRow}>
                {release.offers.length === 0 ? (
                  <Text size={200} className={styles.unavailable}>No matched provider release</Text>
                ) : (
                  <>
                    {[...new Set(release.offers.map((offer) => offer.provider))].map((provider) => (
                      <Badge key={provider} appearance="tint">{provider}</Badge>
                    ))}
                    {qualities.map((quality) => (
                      <Badge key={quality} appearance="outline">{quality}</Badge>
                    ))}
                    {release.offers.some((offer) => offer.relation !== "exact") ? (
                      <Badge appearance="outline">Track download required</Badge>
                    ) : null}
                  </>
                )}
              </div>
              <AppTooltip content={release.mbid} relationship="label">
                <Text size={100}>{release.mbid}</Text>
              </AppTooltip>
            </div>

            <div className={styles.libraries}>
              {availability.libraries.map((library) => {
                const selected = library.selections.find((selection) => selection.editionId === release.id);
                const pending = pendingSelectionKey === `${library.id}:${release.id}`;
                return (
                  <div key={library.id} className={styles.libraryRow}>
                    <div className={styles.libraryState}>
                      <Text size={200} weight="semibold">{library.name}</Text>
                      <Text size={100} className={styles.metadata}>
                        {selected?.plan
                          ? `${selected.plan.provider} · ${selected.plan.composition.replace("_", " ")} · ${selected.plan.downloadMode}`
                          : library.qualityProfile}
                      </Text>
                    </div>
                    <Button
                      size="small"
                      appearance={selected ? "primary" : "secondary"}
                      disabled={Boolean(pendingSelectionKey) || release.offers.length === 0}
                      onClick={() => onSelect(library.id, release.id)}
                    >
                      {pending ? "Saving…" : selected ? "Selected" : `Use for ${library.name}`}
                    </Button>
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
