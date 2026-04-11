import {
  Skeleton,
  SkeletonItem,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";

type ThumbnailAspect = "square" | "video" | "videoWide";
type CardGridSkeletonVariant = "media" | "artistSearch";
type DetailSkeletonArtShape = "circle" | "rounded";
type DetailSkeletonContent = "cards" | "tracks";

interface CardGridSkeletonProps {
  cards?: number;
  thumbnailAspect?: ThumbnailAspect;
  minCardWidth?: number;
  className?: string;
  variant?: CardGridSkeletonVariant;
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
  thumbnailColumns?: number[];
  circularThumbnailColumns?: number[];
  actionColumns?: number[];
}

interface TrackTableSkeletonProps {
  rows?: number;
  showCover?: boolean;
  showArtist?: boolean;
  showAlbum?: boolean;
  className?: string;
}

interface QueueListSkeletonProps {
  rows?: number;
  className?: string;
}

interface ActivityListSkeletonProps {
  rows?: number;
  className?: string;
}

interface DetailPageSkeletonProps {
  artShape?: DetailSkeletonArtShape;
  content?: DetailSkeletonContent;
  rows?: number;
  cards?: number;
  className?: string;
}

const useStyles = makeStyles({
  surface: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 64%, transparent)`,
    backdropFilter: "blur(20px)",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  trackList: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    borderRadius: tokens.borderRadiusMedium,
    overflow: "hidden",
  },
  trackRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 52%, transparent)`,
    "@media (min-width: 768px)": {
      padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
      gap: tokens.spacingHorizontalM,
    },
    ":last-child": {
      borderBottom: "none",
    },
  },
  trackNumber: {
    width: "28px",
    height: "14px",
    borderRadius: tokens.borderRadiusSmall,
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
    gap: tokens.spacingVerticalXXS,
    flex: 1,
    minWidth: 0,
  },
  trackTitleRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
  },
  trackTitle: {
    height: "16px",
    width: "min(280px, 88%)",
    borderRadius: tokens.borderRadiusSmall,
  },
  trackBadge: {
    width: "32px",
    height: "18px",
    borderRadius: tokens.borderRadiusCircular,
    flexShrink: 0,
  },
  trackMetaRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    flexWrap: "wrap",
  },
  trackMeta: {
    height: "12px",
    borderRadius: tokens.borderRadiusSmall,
  },
  trackActions: {
    display: "flex",
    gap: tokens.spacingHorizontalXS,
    alignItems: "center",
    marginLeft: "auto",
    flexShrink: 0,
  },
  actionDot: {
    width: "28px",
    height: "28px",
    borderRadius: tokens.borderRadiusCircular,
  },
  cardGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: tokens.spacingHorizontalS,
    "@media (min-width: 480px)": {
      gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))",
      gap: tokens.spacingHorizontalM,
    },
    "@media (min-width: 900px)": {
      gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
    },
  },
  mediaCard: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    width: "100%",
    borderRadius: tokens.borderRadiusMedium,
    overflow: "hidden",
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 60%, transparent)`,
    backdropFilter: "blur(14px)",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
  },
  mediaCardPreview: {
    position: "relative",
    width: "100%",
    backgroundColor: tokens.colorNeutralBackground3,
    overflow: "hidden",
  },
  mediaCardSquarePreview: {
    aspectRatio: "1 / 1",
  },
  mediaCardVideoPreview: {
    aspectRatio: "16 / 9",
  },
  mediaCardVideoWidePreview: {
    aspectRatio: "3 / 2",
  },
  mediaBadgeLeft: {
    position: "absolute",
    top: tokens.spacingVerticalS,
    left: tokens.spacingHorizontalS,
    width: "54px",
    height: "20px",
    borderRadius: tokens.borderRadiusCircular,
  },
  mediaBadgeRight: {
    position: "absolute",
    top: tokens.spacingVerticalS,
    right: tokens.spacingHorizontalS,
    width: "54px",
    height: "20px",
    borderRadius: tokens.borderRadiusCircular,
  },
  mediaBadgeBottom: {
    position: "absolute",
    bottom: tokens.spacingVerticalS,
    right: tokens.spacingHorizontalS,
    width: "24px",
    height: "24px",
    borderRadius: tokens.borderRadiusCircular,
  },
  mediaCardContent: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
  },
  mediaCardTitleRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
  },
  mediaCardTitle: {
    height: "16px",
    width: "78%",
    borderRadius: tokens.borderRadiusSmall,
  },
  mediaCardPill: {
    width: "20px",
    height: "16px",
    borderRadius: tokens.borderRadiusCircular,
    flexShrink: 0,
  },
  mediaCardSubtitle: {
    height: "12px",
    width: "60%",
    borderRadius: tokens.borderRadiusSmall,
  },
  artistSearchCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 60%, transparent)`,
    backdropFilter: "blur(14px)",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    minHeight: "196px",
  },
  artistSearchAvatar: {
    width: "96px",
    height: "96px",
    borderRadius: tokens.borderRadiusCircular,
  },
  artistSearchTitle: {
    height: "14px",
    width: "70%",
    borderRadius: tokens.borderRadiusSmall,
  },
  artistSearchAction: {
    width: "28px",
    height: "28px",
    borderRadius: tokens.borderRadiusCircular,
  },
  dataGrid: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    borderRadius: tokens.borderRadiusMedium,
    overflow: "hidden",
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 60%, transparent)`,
    backdropFilter: "blur(20px)",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  dataGridHeader: {
    display: "grid",
    gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    "@media (min-width: 768px)": {
      gap: tokens.spacingHorizontalS,
      padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    },
  },
  dataGridRow: {
    display: "grid",
    gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    alignItems: "center",
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorSubtleBackground,
    "@media (min-width: 768px)": {
      gap: tokens.spacingHorizontalS,
      padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    },
    ":last-child": {
      borderBottom: "none",
    },
  },
  dataGridCell: {
    height: "14px",
    borderRadius: tokens.borderRadiusSmall,
  },
  dataGridThumb: {
    width: "40px",
    height: "40px",
    borderRadius: tokens.borderRadiusSmall,
  },
  dataGridThumbCircle: {
    borderRadius: tokens.borderRadiusCircular,
  },
  dataGridActionGroup: {
    display: "flex",
    justifyContent: "flex-end",
    gap: tokens.spacingHorizontalXS,
  },
  trackTable: {
    display: "none",
    flexDirection: "column",
    width: "100%",
    borderRadius: tokens.borderRadiusMedium,
    overflow: "hidden",
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 60%, transparent)`,
    backdropFilter: "blur(20px)",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    "@media (min-width: 768px)": {
      display: "flex",
    },
  },
  trackTableHeader: {
    display: "grid",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  trackTableRow: {
    display: "grid",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    alignItems: "center",
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorSubtleBackground,
    ":last-child": {
      borderBottom: "none",
    },
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
  trackTableMobileInfo: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  trackTableTitle: {
    height: "16px",
    width: "min(260px, 88%)",
    borderRadius: tokens.borderRadiusSmall,
  },
  trackTableMeta: {
    height: "12px",
    borderRadius: tokens.borderRadiusSmall,
  },
  trackTableActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: tokens.spacingHorizontalXS,
  },
  queueList: {
    display: "flex",
    flexDirection: "column",
    borderRadius: tokens.borderRadiusMedium,
    overflow: "hidden",
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 60%, transparent)`,
    backdropFilter: "blur(20px)",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  queueItem: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingHorizontalM,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    ":last-child": {
      borderBottom: "none",
    },
  },
  queueStatusLead: {
    width: "16px",
    height: "16px",
    borderRadius: tokens.borderRadiusCircular,
    flexShrink: 0,
  },
  queueCover: {
    width: "40px",
    height: "40px",
    borderRadius: tokens.borderRadiusSmall,
    flexShrink: 0,
  },
  queueInfo: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    flex: 1,
    minWidth: 0,
  },
  queueTitle: {
    height: "16px",
    width: "min(280px, 82%)",
    borderRadius: tokens.borderRadiusSmall,
  },
  queueMeta: {
    height: "12px",
    width: "min(180px, 56%)",
    borderRadius: tokens.borderRadiusSmall,
  },
  queueProgressBar: {
    height: "6px",
    width: "100%",
    maxWidth: "260px",
    borderRadius: tokens.borderRadiusCircular,
  },
  queueActions: {
    display: "flex",
    gap: tokens.spacingHorizontalXS,
    marginLeft: "auto",
    flexShrink: 0,
  },
  activityList: {
    display: "flex",
    flexDirection: "column",
    borderRadius: tokens.borderRadiusMedium,
    overflow: "hidden",
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 60%, transparent)`,
    backdropFilter: "blur(20px)",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  activityItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    ":last-child": {
      borderBottom: "none",
    },
  },
  activityLead: {
    width: "32px",
    minWidth: "32px",
    display: "flex",
    justifyContent: "center",
    paddingTop: tokens.spacingVerticalSNudge,
  },
  activityLeadIcon: {
    width: "16px",
    height: "16px",
    borderRadius: tokens.borderRadiusCircular,
  },
  activityContent: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    flex: 1,
    minWidth: 0,
  },
  activityTitle: {
    height: "16px",
    width: "min(320px, 78%)",
    borderRadius: tokens.borderRadiusSmall,
  },
  activitySubtitle: {
    height: "12px",
    width: "min(420px, 92%)",
    borderRadius: tokens.borderRadiusSmall,
  },
  activityTrailing: {
    width: "56px",
    height: "12px",
    borderRadius: tokens.borderRadiusSmall,
    marginTop: tokens.spacingVerticalSNudge,
    flexShrink: 0,
  },
  detailPage: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXL,
    width: "100%",
  },
  detailHeader: {
    position: "relative",
    minHeight: "200px",
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalL}`,
    borderRadius: tokens.borderRadiusXLarge,
    overflow: "hidden",
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 60%, transparent)`,
    backdropFilter: "blur(24px)",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    "@media (min-width: 768px)": {
      minHeight: "300px",
      padding: `${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalXL}`,
    },
  },
  detailHeaderContent: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalM,
    width: "100%",
    "@media (min-width: 768px)": {
      flexDirection: "row",
      alignItems: "stretch",
      gap: tokens.spacingHorizontalXXL,
    },
  },
  detailArt: {
    width: "140px",
    height: "140px",
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
  detailArtCircle: {
    borderRadius: tokens.borderRadiusCircular,
  },
  detailArtRounded: {
    borderRadius: tokens.borderRadiusLarge,
  },
  detailInfo: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    alignItems: "center",
    width: "100%",
    "@media (min-width: 768px)": {
      alignItems: "flex-start",
      justifyContent: "flex-end",
      flex: 1,
      gap: tokens.spacingVerticalM,
    },
  },
  detailTitle: {
    height: "32px",
    width: "min(320px, 72%)",
    borderRadius: tokens.borderRadiusMedium,
  },
  detailSubtitle: {
    height: "16px",
    width: "min(220px, 44%)",
    borderRadius: tokens.borderRadiusSmall,
  },
  detailMetadataRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
    justifyContent: "center",
    "@media (min-width: 768px)": {
      justifyContent: "flex-start",
    },
  },
  detailMetadataPill: {
    height: "14px",
    borderRadius: tokens.borderRadiusCircular,
  },
  detailActions: {
    display: "flex",
    flexWrap: "nowrap",
    gap: tokens.spacingHorizontalS,
    width: "100%",
    justifyContent: "center",
    "@media (min-width: 768px)": {
      justifyContent: "flex-start",
    },
  },
  detailAction: {
    height: "34px",
    borderRadius: tokens.borderRadiusMedium,
  },
  detailSection: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  detailSectionTitle: {
    height: "24px",
    width: "140px",
    borderRadius: tokens.borderRadiusSmall,
  },
});

function range(count: number) {
  return Array.from({ length: count }, (_, index) => index);
}

function getPreviewClassName(
  styles: ReturnType<typeof useStyles>,
  thumbnailAspect: ThumbnailAspect,
) {
  if (thumbnailAspect === "video") {
    return mergeClasses(styles.mediaCardPreview, styles.mediaCardVideoPreview);
  }

  if (thumbnailAspect === "videoWide") {
    return mergeClasses(styles.mediaCardPreview, styles.mediaCardVideoWidePreview);
  }

  return mergeClasses(styles.mediaCardPreview, styles.mediaCardSquarePreview);
}

function getCellWidth(columnIndex: number, rowIndex: number, isHeader: boolean) {
  if (isHeader) {
    return columnIndex % 2 === 0 ? "72%" : "58%";
  }

  const widths = ["88%", "72%", "60%", "82%"];
  return widths[(columnIndex + rowIndex) % widths.length];
}

export function TrackListSkeleton({
  rows = 8,
  showCover = false,
  showNumber = true,
  className,
}: TrackListSkeletonProps) {
  const styles = useStyles();

  return (
    <Skeleton
      animation="wave"
      className={mergeClasses(styles.trackList, styles.surface, className)}
      aria-busy="true"
      aria-label="Loading tracks"
    >
      {range(rows).map((row) => (
        <div key={row} className={styles.trackRow}>
          {showNumber ? <SkeletonItem className={styles.trackNumber} /> : null}
          {showCover ? <SkeletonItem className={styles.trackCover} /> : null}
          <div className={styles.trackBody}>
            <div className={styles.trackTitleRow}>
              <SkeletonItem className={styles.trackTitle} />
              <SkeletonItem className={styles.trackBadge} />
            </div>
            <div className={styles.trackMetaRow}>
              <SkeletonItem className={styles.trackMeta} style={{ width: row % 2 === 0 ? "84px" : "112px" }} />
              <SkeletonItem className={styles.trackMeta} style={{ width: row % 3 === 0 ? "64px" : "92px" }} />
              <SkeletonItem className={styles.trackMeta} style={{ width: row % 2 === 0 ? "42px" : "54px" }} />
            </div>
          </div>
          <div className={styles.trackActions}>
            {range(4).map((action) => (
              <SkeletonItem key={action} className={styles.actionDot} />
            ))}
          </div>
        </div>
      ))}
    </Skeleton>
  );
}

export function CardGridSkeleton({
  cards = 8,
  thumbnailAspect = "square",
  minCardWidth,
  className,
  variant = "media",
}: CardGridSkeletonProps) {
  const styles = useStyles();
  const previewClassName = getPreviewClassName(styles, thumbnailAspect);
  const gridStyle = minCardWidth
    ? { gridTemplateColumns: `repeat(auto-fill, minmax(${minCardWidth}px, 1fr))` }
    : undefined;

  return (
    <Skeleton
      animation="wave"
      className={mergeClasses(styles.cardGrid, className)}
      style={gridStyle}
      aria-busy="true"
      aria-label="Loading cards"
    >
      {range(cards).map((card) => (
        variant === "artistSearch" ? (
          <div key={card} className={styles.artistSearchCard}>
            <SkeletonItem className={styles.artistSearchAvatar} />
            <SkeletonItem className={styles.artistSearchTitle} />
            <SkeletonItem className={styles.artistSearchAction} />
          </div>
        ) : (
          <div key={card} className={styles.mediaCard}>
            <div className={previewClassName}>
              <SkeletonItem className={styles.mediaBadgeLeft} />
              <SkeletonItem className={styles.mediaBadgeRight} />
              <SkeletonItem className={styles.mediaBadgeBottom} />
            </div>
            <div className={styles.mediaCardContent}>
              <div className={styles.mediaCardTitleRow}>
                <SkeletonItem className={styles.mediaCardTitle} />
                <SkeletonItem className={styles.mediaCardPill} />
              </div>
              <SkeletonItem className={styles.mediaCardSubtitle} />
            </div>
          </div>
        )
      ))}
    </Skeleton>
  );
}

export function DataGridSkeleton({
  columns = 5,
  rows = 8,
  columnTemplate,
  compact = false,
  className,
  thumbnailColumns = [],
  circularThumbnailColumns = [],
  actionColumns = [],
}: DataGridSkeletonProps) {
  const styles = useStyles();
  const gridTemplateColumns = columnTemplate || `repeat(${Math.max(columns, 1)}, minmax(0, 1fr))`;
  const rowPaddingStyle = compact
    ? {
        paddingTop: tokens.spacingVerticalXS,
        paddingBottom: tokens.spacingVerticalXS,
      }
    : undefined;

  return (
    <Skeleton
      animation="wave"
      className={mergeClasses(styles.dataGrid, className)}
      aria-busy="true"
      aria-label="Loading data"
    >
      <div className={styles.dataGridHeader} style={{ gridTemplateColumns }}>
        {range(columns).map((column) => (
          <SkeletonItem
            key={`header-${column}`}
            className={styles.dataGridCell}
            style={{ width: getCellWidth(column, 0, true) }}
          />
        ))}
      </div>

      {range(rows).map((row) => (
        <div
          key={row}
          className={styles.dataGridRow}
          style={{ gridTemplateColumns, ...rowPaddingStyle }}
        >
          {range(columns).map((column) => {
            if (thumbnailColumns.includes(column)) {
              return (
                <SkeletonItem
                  key={`cell-${row}-${column}`}
                  className={mergeClasses(
                    styles.dataGridThumb,
                    circularThumbnailColumns.includes(column) ? styles.dataGridThumbCircle : undefined,
                  )}
                />
              );
            }

            if (actionColumns.includes(column)) {
              return (
                <div key={`cell-${row}-${column}`} className={styles.dataGridActionGroup}>
                  {range(3).map((action) => (
                    <SkeletonItem key={action} className={styles.actionDot} />
                  ))}
                </div>
              );
            }

            return (
              <SkeletonItem
                key={`cell-${row}-${column}`}
                className={styles.dataGridCell}
                style={{ width: getCellWidth(column, row, false) }}
              />
            );
          })}
        </div>
      ))}
    </Skeleton>
  );
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
    ...(showCover ? ["56px"] : []),
    "minmax(280px, 1.8fr)",
    ...(showArtist ? ["minmax(140px, 1fr)"] : []),
    ...(showAlbum ? ["minmax(160px, 1fr)"] : []),
    "180px",
  ].join(" ");

  return (
    <div className={className} aria-busy="true" aria-label="Loading track table">
      <Skeleton animation="wave" className={styles.trackTableMobileList}>
        {range(rows).map((row) => (
          <div key={`mobile-${row}`} className={styles.trackTableMobileCard}>
            {showCover ? <SkeletonItem className={styles.trackTableCover} /> : null}
            <div className={styles.trackTableMobileInfo}>
              <SkeletonItem className={styles.trackTableTitle} />
              <SkeletonItem className={styles.trackTableMeta} style={{ width: "88px" }} />
              {showArtist || showAlbum ? (
                <SkeletonItem className={styles.trackTableMeta} style={{ width: row % 2 === 0 ? "128px" : "96px" }} />
              ) : null}
              <div className={styles.trackTableActions}>
                {range(4).map((action) => (
                  <SkeletonItem key={action} className={styles.actionDot} />
                ))}
              </div>
            </div>
          </div>
        ))}
      </Skeleton>

      <Skeleton animation="wave" className={styles.trackTable}>
        <div className={styles.trackTableHeader} style={{ gridTemplateColumns: columnTemplate }}>
          {showCover ? <SkeletonItem className={styles.trackTableMeta} style={{ width: "32px" }} /> : null}
          <SkeletonItem className={styles.trackTableMeta} style={{ width: "72px" }} />
          {showArtist ? <SkeletonItem className={styles.trackTableMeta} style={{ width: "56px" }} /> : null}
          {showAlbum ? <SkeletonItem className={styles.trackTableMeta} style={{ width: "56px" }} /> : null}
          <SkeletonItem className={styles.trackTableMeta} style={{ width: "84px", marginLeft: "auto" }} />
        </div>

        {range(rows).map((row) => (
          <div key={row} className={styles.trackTableRow} style={{ gridTemplateColumns: columnTemplate }}>
            {showCover ? <SkeletonItem className={styles.trackTableCover} /> : null}
            <div className={styles.trackTableTitleCell}>
              <SkeletonItem className={styles.trackTableTitle} />
              <SkeletonItem className={styles.trackTableMeta} style={{ width: row % 2 === 0 ? "112px" : "86px" }} />
            </div>
            {showArtist ? (
              <SkeletonItem className={styles.trackTableMeta} style={{ width: row % 2 === 0 ? "76%" : "62%" }} />
            ) : null}
            {showAlbum ? (
              <SkeletonItem className={styles.trackTableMeta} style={{ width: row % 3 === 0 ? "78%" : "64%" }} />
            ) : null}
            <div className={styles.trackTableActions}>
              {range(4).map((action) => (
                <SkeletonItem key={action} className={styles.actionDot} />
              ))}
            </div>
          </div>
        ))}
      </Skeleton>
    </div>
  );
}

export function QueueListSkeleton({
  rows = 6,
  className,
}: QueueListSkeletonProps) {
  const styles = useStyles();

  return (
    <Skeleton
      animation="wave"
      className={mergeClasses(styles.queueList, className)}
      aria-busy="true"
      aria-label="Loading queue"
    >
      {range(rows).map((row) => (
        <div key={row} className={styles.queueItem}>
          <SkeletonItem className={styles.queueStatusLead} />
          <SkeletonItem className={styles.queueCover} />
          <div className={styles.queueInfo}>
            <SkeletonItem className={styles.queueTitle} />
            <SkeletonItem className={styles.queueMeta} />
            {row % 2 === 0 ? <SkeletonItem className={styles.queueProgressBar} /> : null}
          </div>
          <div className={styles.queueActions}>
            {range(2 + (row % 2)).map((action) => (
              <SkeletonItem key={action} className={styles.actionDot} />
            ))}
          </div>
        </div>
      ))}
    </Skeleton>
  );
}

export function ActivityListSkeleton({
  rows = 6,
  className,
}: ActivityListSkeletonProps) {
  const styles = useStyles();

  return (
    <Skeleton
      animation="wave"
      className={mergeClasses(styles.activityList, className)}
      aria-busy="true"
      aria-label="Loading activity"
    >
      {range(rows).map((row) => (
        <div key={row} className={styles.activityItem}>
          <div className={styles.activityLead}>
            <SkeletonItem className={styles.activityLeadIcon} />
          </div>
          <div className={styles.activityContent}>
            <SkeletonItem className={styles.activityTitle} />
            <SkeletonItem
              className={styles.activitySubtitle}
              style={{ width: row % 2 === 0 ? "min(360px, 88%)" : "min(280px, 68%)" }}
            />
          </div>
          <SkeletonItem className={styles.activityTrailing} />
        </div>
      ))}
    </Skeleton>
  );
}

export function DetailPageSkeleton({
  artShape = "rounded",
  content = "tracks",
  rows = 8,
  cards = 6,
  className,
}: DetailPageSkeletonProps) {
  const styles = useStyles();

  return (
    <div className={mergeClasses(styles.detailPage, className)} aria-busy="true" aria-label="Loading page">
      <Skeleton animation="wave">
        <div className={styles.detailHeader}>
          <div className={styles.detailHeaderContent}>
            <SkeletonItem
              className={mergeClasses(
                styles.detailArt,
                artShape === "circle" ? styles.detailArtCircle : styles.detailArtRounded,
              )}
            />
            <div className={styles.detailInfo}>
              <SkeletonItem className={styles.detailTitle} />
              <SkeletonItem className={styles.detailSubtitle} />
              <div className={styles.detailMetadataRow}>
                <SkeletonItem className={styles.detailMetadataPill} style={{ width: "64px" }} />
                <SkeletonItem className={styles.detailMetadataPill} style={{ width: "46px" }} />
                <SkeletonItem className={styles.detailMetadataPill} style={{ width: "78px" }} />
              </div>
              <div className={styles.detailActions}>
                <SkeletonItem className={styles.detailAction} style={{ width: "104px" }} />
                <SkeletonItem className={styles.detailAction} style={{ width: "96px" }} />
                <SkeletonItem className={styles.detailAction} style={{ width: "88px" }} />
              </div>
            </div>
          </div>
        </div>
      </Skeleton>

      <div className={styles.detailSection}>
        <Skeleton animation="wave">
          <SkeletonItem className={styles.detailSectionTitle} />
        </Skeleton>
        {content === "cards" ? (
          <CardGridSkeleton cards={cards} />
        ) : (
          <TrackListSkeleton rows={rows} />
        )}
      </div>
    </div>
  );
}
