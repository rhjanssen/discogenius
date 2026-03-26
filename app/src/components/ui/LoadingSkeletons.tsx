import React from "react";
import { Skeleton, SkeletonItem, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";

type MediaDetailSkeletonVariant = "artist" | "album" | "video";
type ThumbnailAspect = "square" | "video" | "videoWide";

interface MediaDetailSkeletonProps {
  variant: MediaDetailSkeletonVariant;
  className?: string;
}

interface CardGridSkeletonProps {
  cards?: number;
  thumbnailAspect?: ThumbnailAspect;
  minCardWidth?: number;
  className?: string;
}

interface TrackListSkeletonProps {
  rows?: number;
  showCover?: boolean;
  showNumber?: boolean;
  className?: string;
}

interface DataGridSkeletonProps {
  columns?: number;
  rows?: number;
  columnTemplate?: string;
  compact?: boolean;
  className?: string;
}

interface ListRowsSkeletonProps {
  rows?: number;
  className?: string;
}

interface TrackTableSkeletonProps {
  rows?: number;
  showCover?: boolean;
  showArtist?: boolean;
  showAlbum?: boolean;
  className?: string;
}

interface SettingsPageSkeletonProps {
  sections?: number;
  rowsPerSection?: number;
  className?: string;
}

const useStyles = makeStyles({
  mediaRoot: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
    width: "100%",
    paddingBottom: `calc(${tokens.spacingVerticalXXXL} * 3)`,
  },
  detailHeader: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
    padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
    "@media (min-width: 768px)": {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: tokens.spacingHorizontalXXL,
      padding: tokens.spacingHorizontalXL,
      paddingTop: tokens.spacingVerticalXXL,
      paddingBottom: tokens.spacingVerticalXL,
    },
  },
  detailHeaderCompactDesktop: {
    "@media (min-width: 768px)": {
      paddingBottom: tokens.spacingVerticalS,
    },
  },
  detailArtworkCircle: {
    width: "120px",
    height: "120px",
    borderRadius: tokens.borderRadiusCircular,
    flexShrink: 0,
    "@media (min-width: 480px)": {
      width: "160px",
      height: "160px",
    },
    "@media (min-width: 768px)": {
      width: "200px",
      height: "200px",
    },
  },
  detailArtworkRect: {
    width: "140px",
    height: "140px",
    borderRadius: tokens.borderRadiusLarge,
    flexShrink: 0,
    "@media (min-width: 480px)": {
      width: "180px",
      height: "180px",
    },
    "@media (min-width: 768px)": {
      width: "220px",
      height: "220px",
    },
  },
  detailInfo: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    flex: 1,
    minWidth: 0,
  },
  titleLine: {
    height: "32px",
    width: "min(520px, 92%)",
    borderRadius: tokens.borderRadiusMedium,
    "@media (min-width: 768px)": {
      height: "40px",
      width: "min(640px, 82%)",
    },
  },
  subtitleLine: {
    height: "18px",
    width: "min(240px, 60%)",
    borderRadius: tokens.borderRadiusMedium,
  },
  metadataRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
  },
  metadataChip: {
    height: "20px",
    width: "72px",
    borderRadius: tokens.borderRadiusCircular,
  },
  actionRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
  },
  actionButton: {
    height: "32px",
    width: "104px",
    borderRadius: tokens.borderRadiusMedium,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  sectionTitle: {
    height: "24px",
    width: "160px",
    borderRadius: tokens.borderRadiusMedium,
  },
  sectionTitleWide: {
    width: "220px",
  },
  trackList: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    width: "100%",
  },
  trackRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  trackNumber: {
    width: "24px",
    height: "14px",
    borderRadius: tokens.borderRadiusMedium,
    flexShrink: 0,
  },
  trackCover: {
    width: "44px",
    height: "44px",
    borderRadius: tokens.borderRadiusSmall,
    flexShrink: 0,
  },
  trackBody: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    flex: 1,
    minWidth: 0,
  },
  trackTitle: {
    height: "16px",
    width: "min(360px, 88%)",
    borderRadius: tokens.borderRadiusMedium,
  },
  trackMeta: {
    height: "14px",
    width: "min(280px, 72%)",
    borderRadius: tokens.borderRadiusMedium,
  },
  trackActions: {
    display: "flex",
    gap: tokens.spacingHorizontalXS,
    alignItems: "center",
  },
  actionDot: {
    width: "28px",
    height: "28px",
    borderRadius: tokens.borderRadiusCircular,
  },
  cardGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
    gap: tokens.spacingHorizontalL,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  squareThumb: {
    width: "100%",
    aspectRatio: "1 / 1",
    borderRadius: tokens.borderRadiusLarge,
  },
  videoThumb: {
    width: "100%",
    aspectRatio: "16 / 9",
    borderRadius: tokens.borderRadiusLarge,
  },
  videoWideThumb: {
    width: "100%",
    aspectRatio: "3 / 2",
    borderRadius: tokens.borderRadiusLarge,
  },
  cardTitle: {
    height: "16px",
    width: "82%",
    borderRadius: tokens.borderRadiusMedium,
  },
  cardSubtitle: {
    height: "14px",
    width: "56%",
    borderRadius: tokens.borderRadiusMedium,
  },
  videoPlayer: {
    width: "100%",
    aspectRatio: "16 / 9",
    borderRadius: tokens.borderRadiusLarge,
  },
  videoPanel: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalL,
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
    borderRadius: tokens.borderRadiusXLarge,
  },
  dataGrid: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    borderRadius: tokens.borderRadiusLarge,
    overflow: "hidden",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  dataGridHeader: {
    display: "grid",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  dataGridRow: {
    display: "grid",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    backgroundColor: tokens.colorSubtleBackground,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    alignItems: "center",
  },
  gridCell: {
    height: "14px",
    width: "88%",
    borderRadius: tokens.borderRadiusMedium,
  },
  trackTable: {
    display: "none",
    flexDirection: "column",
    width: "100%",
    borderRadius: tokens.borderRadiusLarge,
    overflow: "hidden",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorSubtleBackground,
    "@media (min-width: 768px)": {
      display: "flex",
    },
  },
  trackTableHeader: {
    display: "grid",
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  trackTableRow: {
    display: "grid",
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    alignItems: "center",
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  trackTableCell: {
    height: "14px",
    width: "78%",
    borderRadius: tokens.borderRadiusMedium,
  },
  trackTableCover: {
    width: "40px",
    height: "40px",
    borderRadius: tokens.borderRadiusSmall,
  },
  trackTableTitleCell: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    minWidth: 0,
  },
  trackTableTitle: {
    height: "16px",
    width: "min(260px, 92%)",
    borderRadius: tokens.borderRadiusMedium,
  },
  trackTableMeta: {
    height: "14px",
    width: "min(180px, 74%)",
    borderRadius: tokens.borderRadiusMedium,
  },
  trackTableActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: tokens.spacingHorizontalXS,
  },
  trackTableMobileList: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    "@media (min-width: 768px)": {
      display: "none",
    },
  },
  trackTableMobileCard: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorSubtleBackground,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  trackTableMobileInfo: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    flex: 1,
    minWidth: 0,
  },
  trackTableMobileActions: {
    display: "flex",
    gap: tokens.spacingHorizontalXS,
    paddingTop: tokens.spacingVerticalXS,
  },
  settingsRoot: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
    width: "100%",
  },
  settingsSection: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
  },
  settingsRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: tokens.spacingHorizontalL,
    alignItems: "center",
    "@media (max-width: 768px)": {
      gridTemplateColumns: "1fr",
    },
  },
  settingsToggle: {
    width: "44px",
    height: "24px",
    borderRadius: tokens.borderRadiusCircular,
  },
});

function range(count: number) {
  return Array.from({ length: count }, (_, index) => index);
}

export function TrackListSkeleton({
  rows = 8,
  showCover = false,
  showNumber = true,
  className,
}: TrackListSkeletonProps) {
  const styles = useStyles();

  return (
    <div className={mergeClasses(styles.trackList, className)} aria-busy="true" aria-label="Loading tracks">
      <Skeleton animation="wave">
        {range(rows).map((row) => (
          <div key={row} className={styles.trackRow}>
            {showNumber ? <SkeletonItem className={styles.trackNumber} /> : null}
            {showCover ? <SkeletonItem className={styles.trackCover} /> : null}
            <div className={styles.trackBody}>
              <SkeletonItem className={styles.trackTitle} />
              <SkeletonItem className={styles.trackMeta} />
            </div>
            <div className={styles.trackActions}>
              <SkeletonItem className={styles.actionDot} />
              <SkeletonItem className={styles.actionDot} />
              <SkeletonItem className={styles.actionDot} />
              <SkeletonItem className={styles.actionDot} />
            </div>
          </div>
        ))}
      </Skeleton>
    </div>
  );
}

export function CardGridSkeleton({
  cards = 8,
  thumbnailAspect = "square",
  minCardWidth,
  className,
}: CardGridSkeletonProps) {
  const styles = useStyles();
  const thumbClassName = thumbnailAspect === "video"
    ? styles.videoThumb
    : thumbnailAspect === "videoWide"
      ? styles.videoWideThumb
      : styles.squareThumb;
  const gridStyle = minCardWidth ? { gridTemplateColumns: `repeat(auto-fill, minmax(${minCardWidth}px, 1fr))` } : undefined;

  return (
    <div className={mergeClasses(styles.cardGrid, className)} style={gridStyle} aria-busy="true" aria-label="Loading cards">
      <Skeleton animation="wave">
        {range(cards).map((card) => (
          <div key={card} className={styles.card}>
            <SkeletonItem className={thumbClassName} />
            <SkeletonItem className={styles.cardTitle} />
            <SkeletonItem className={styles.cardSubtitle} />
          </div>
        ))}
      </Skeleton>
    </div>
  );
}

export function DataGridSkeleton({
  columns = 5,
  rows = 8,
  columnTemplate,
  compact = false,
  className,
}: DataGridSkeletonProps) {
  const styles = useStyles();
  const gridTemplateColumns = columnTemplate || `repeat(${Math.max(columns, 1)}, minmax(0, 1fr))`;
  const rowStyle = compact
    ? {
      paddingTop: tokens.spacingVerticalXS,
      paddingBottom: tokens.spacingVerticalXS,
    }
    : undefined;

  return (
    <div className={mergeClasses(styles.dataGrid, className)} aria-busy="true" aria-label="Loading table">
      <Skeleton animation="wave">
        <div className={styles.dataGridHeader} style={{ gridTemplateColumns }}>
          {range(columns).map((column) => (
            <SkeletonItem key={`header-${column}`} className={styles.gridCell} />
          ))}
        </div>
        {range(rows).map((row) => (
          <div key={row} className={styles.dataGridRow} style={{ gridTemplateColumns, ...rowStyle }}>
            {range(columns).map((column) => (
              <SkeletonItem key={`cell-${row}-${column}`} className={styles.gridCell} />
            ))}
          </div>
        ))}
      </Skeleton>
    </div>
  );
}

export function ListRowsSkeleton({
  rows = 8,
  className,
}: ListRowsSkeletonProps) {
  return <TrackListSkeleton rows={rows} className={className} />;
}

export function TrackTableSkeleton({
  rows = 8,
  showCover = true,
  showArtist = true,
  showAlbum = true,
  className,
}: TrackTableSkeletonProps) {
  const styles = useStyles();
  const columnTemplate = [
    ...(showCover ? ["40px"] : []),
    "minmax(240px, 1.75fr)",
    ...(showArtist ? ["minmax(140px, 1fr)"] : []),
    ...(showAlbum ? ["minmax(160px, 1fr)"] : []),
    "180px",
  ].join(" ");

  return (
    <div className={className} aria-busy="true" aria-label="Loading track table">
      <div className={styles.trackTableMobileList}>
        <Skeleton animation="wave">
          {range(rows).map((row) => (
            <div key={`mobile-${row}`} className={styles.trackTableMobileCard}>
              {showCover ? <SkeletonItem className={styles.trackTableCover} /> : null}
              <div className={styles.trackTableMobileInfo}>
                <SkeletonItem className={styles.trackTableTitle} />
                <SkeletonItem className={styles.trackTableMeta} />
                {showArtist || showAlbum ? <SkeletonItem className={styles.trackTableMeta} /> : null}
                <div className={styles.trackTableMobileActions}>
                  <SkeletonItem className={styles.actionDot} />
                  <SkeletonItem className={styles.actionDot} />
                  <SkeletonItem className={styles.actionDot} />
                  <SkeletonItem className={styles.actionDot} />
                </div>
              </div>
            </div>
          ))}
        </Skeleton>
      </div>

      <div className={styles.trackTable}>
        <Skeleton animation="wave">
          <div className={styles.trackTableHeader} style={{ gridTemplateColumns: columnTemplate }}>
            {showCover ? <SkeletonItem className={styles.trackTableCell} /> : null}
            <SkeletonItem className={styles.trackTableCell} />
            {showArtist ? <SkeletonItem className={styles.trackTableCell} /> : null}
            {showAlbum ? <SkeletonItem className={styles.trackTableCell} /> : null}
            <SkeletonItem className={styles.trackTableCell} />
          </div>

          {range(rows).map((row) => (
            <div key={row} className={styles.trackTableRow} style={{ gridTemplateColumns: columnTemplate }}>
              {showCover ? <SkeletonItem className={styles.trackTableCover} /> : null}
              <div className={styles.trackTableTitleCell}>
                <SkeletonItem className={styles.trackTableTitle} />
                <SkeletonItem className={styles.trackTableMeta} />
              </div>
              {showArtist ? <SkeletonItem className={styles.trackTableCell} /> : null}
              {showAlbum ? <SkeletonItem className={styles.trackTableCell} /> : null}
              <div className={styles.trackTableActions}>
                <SkeletonItem className={styles.actionDot} />
                <SkeletonItem className={styles.actionDot} />
                <SkeletonItem className={styles.actionDot} />
                <SkeletonItem className={styles.actionDot} />
              </div>
            </div>
          ))}
        </Skeleton>
      </div>
    </div>
  );
}

export function MediaDetailSkeleton({
  variant,
  className,
}: MediaDetailSkeletonProps) {
  const styles = useStyles();

  if (variant === "video") {
    return (
      <div className={mergeClasses(styles.mediaRoot, className)} aria-busy="true" aria-label="Loading video details">
        <Skeleton animation="wave">
          <SkeletonItem className={styles.videoPlayer} />
          <div className={styles.videoPanel}>
            <SkeletonItem className={styles.titleLine} />
            <div className={styles.metadataRow}>
              {range(4).map((item) => (
                <SkeletonItem key={item} className={styles.metadataChip} />
              ))}
            </div>
            <div className={styles.actionRow}>
              {range(4).map((item) => (
                <SkeletonItem key={item} className={styles.actionButton} />
              ))}
            </div>
          </div>
        </Skeleton>
      </div>
    );
  }

  const artworkClassName = variant === "artist" ? styles.detailArtworkCircle : styles.detailArtworkRect;
  const detailHeaderClassName = mergeClasses(
    styles.detailHeader,
    variant === "artist" ? styles.detailHeaderCompactDesktop : undefined,
  );

  return (
    <div className={mergeClasses(styles.mediaRoot, className)} aria-busy="true" aria-label={`Loading ${variant} details`}>
      <Skeleton animation="wave">
        <div className={detailHeaderClassName}>
          <SkeletonItem className={artworkClassName} />
          <div className={styles.detailInfo}>
            <SkeletonItem className={styles.titleLine} />
            <SkeletonItem className={styles.subtitleLine} />
            <div className={styles.metadataRow}>
              {range(4).map((item) => (
                <SkeletonItem key={item} className={styles.metadataChip} />
              ))}
            </div>
            <div className={styles.actionRow}>
              {range(4).map((item) => (
                <SkeletonItem key={item} className={styles.actionButton} />
              ))}
            </div>
          </div>
        </div>
      </Skeleton>

      <div className={styles.section}>
        <Skeleton animation="wave">
          <SkeletonItem className={mergeClasses(styles.sectionTitle, styles.sectionTitleWide)} />
        </Skeleton>
        <TrackListSkeleton
          rows={variant === "album" ? 9 : 5}
          showCover={false}
        />
      </div>

      <div className={styles.section}>
        <Skeleton animation="wave">
          <SkeletonItem className={styles.sectionTitle} />
        </Skeleton>
        <CardGridSkeleton cards={6} />
      </div>
    </div>
  );
}

export function SettingsPageSkeleton({
  sections = 4,
  rowsPerSection = 4,
  className,
}: SettingsPageSkeletonProps) {
  const styles = useStyles();

  return (
    <div className={mergeClasses(styles.settingsRoot, className)} aria-busy="true" aria-label="Loading settings">
      <Skeleton animation="wave">
        {range(sections).map((section) => (
          <div key={section} className={styles.settingsSection}>
            <SkeletonItem className={styles.titleLine} />
            <SkeletonItem className={styles.subtitleLine} />
            {range(rowsPerSection).map((row) => (
              <div key={row} className={styles.settingsRow}>
                <div className={styles.trackBody}>
                  <SkeletonItem className={styles.trackTitle} />
                  <SkeletonItem className={styles.trackMeta} />
                </div>
                <SkeletonItem className={styles.settingsToggle} />
              </div>
            ))}
          </div>
        ))}
      </Skeleton>
    </div>
  );
}





