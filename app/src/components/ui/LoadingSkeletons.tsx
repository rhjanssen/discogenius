import { Skeleton, SkeletonItem, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";

type ThumbnailAspect = "square" | "video" | "videoWide";

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

interface TrackTableSkeletonProps {
  rows?: number;
  showCover?: boolean;
  showArtist?: boolean;
  showAlbum?: boolean;
  className?: string;
}

const useStyles = makeStyles({
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
    <Skeleton animation="wave" className={mergeClasses(styles.trackList, className)} aria-busy="true" aria-label="Loading tracks">
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
    <Skeleton animation="wave" className={mergeClasses(styles.cardGrid, className)} style={gridStyle} aria-busy="true" aria-label="Loading cards">
      {range(cards).map((card) => (
        <div key={card} className={styles.card}>
          <SkeletonItem className={thumbClassName} />
          <SkeletonItem className={styles.cardTitle} />
          <SkeletonItem className={styles.cardSubtitle} />
        </div>
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
    <Skeleton animation="wave" className={mergeClasses(styles.dataGrid, className)} aria-busy="true" aria-label="Loading data">
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
    ...(showCover ? ["40px"] : []),
    "minmax(240px, 1.75fr)",
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

      <Skeleton animation="wave" className={styles.trackTable}>
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
  );
}

