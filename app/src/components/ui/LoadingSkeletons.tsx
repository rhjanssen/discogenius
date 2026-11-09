import {
  Skeleton,
  SkeletonItem,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";

type ThumbnailAspect = "square" | "video" | "videoWide";
type DetailSkeletonArtShape = "circle" | "rounded";
type DetailSkeletonContent = "cards" | "tracks";
type DetailSkeletonInfo = "metadata" | "bio";

interface CardGridSkeletonProps {
  cards?: number;
  thumbnailAspect?: ThumbnailAspect;
  className?: string;
}

interface VideoDetailSkeletonProps {
  className?: string;
  label?: string;
  actionWidths?: string[];
}

interface TrackListSkeletonProps {
  rows?: number;
  showCover?: boolean;
  showNumber?: boolean;
  showArtist?: boolean;
  showAlbum?: boolean;
  showQuality?: boolean;
  /** Desktop column-header row (album tracklist has one; search results don't). */
  showHeader?: boolean;
  /** Number of trailing action affordances per row. */
  actions?: number;
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
  actionsPerColumn?: number;
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
  /**
   * Shape of the header info column. "metadata" (album) renders a subtitle bar
   * plus a row of metadata pills; "bio" (artist) renders a multi-line paragraph.
   */
  info?: DetailSkeletonInfo;
  rows?: number;
  cards?: number;
  className?: string;
  cardsClassName?: string;
  label?: string;
  actionWidths?: string[];
}

const useStyles = makeStyles({
  // ── Track list (mirrors the Fluent Table in TrackList.tsx) ──────────────
  // Transparent like the real table: row separators only, no glass surface.
  tlTable: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
  },
  tlHeaderRow: {
    display: "none",
    "@media (min-width: 768px)": {
      display: "flex",
      alignItems: "center",
      gap: tokens.spacingHorizontalS,
      padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
      borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    },
  },
  tlHeaderLabel: {
    height: "10px",
    borderRadius: tokens.borderRadiusSmall,
  },
  tlHeaderLabelIndex: {
    width: "10px",
  },
  tlHeaderLabelTitle: {
    width: "40px",
  },
  tlHeaderLabelWide: {
    width: "48px",
  },
  tlHeaderLabelQuality: {
    width: "42px",
  },
  tlCoverHidden: {
    visibility: "hidden",
  },
  tlTitleBarEven: {
    width: "72%",
  },
  tlTitleBarOdd: {
    width: "56%",
  },
  tlArtistBarEven: {
    width: "58%",
  },
  tlArtistBarOdd: {
    width: "70%",
  },
  tlAlbumBarThird: {
    width: "64%",
  },
  tlAlbumBarDefault: {
    width: "50%",
  },
  tlRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke3}`,
    "@media (min-width: 768px)": {
      gap: tokens.spacingHorizontalS,
    },
    ":last-child": {
      borderBottom: "none",
    },
  },
  tlIndexCell: {
    flex: "0 0 26px",
    display: "flex",
    justifyContent: "center",
    flexShrink: 0,
    "@media (min-width: 768px)": {
      flex: "0 0 40px",
    },
  },
  tlIndexBar: {
    width: "14px",
    height: "12px",
    borderRadius: tokens.borderRadiusSmall,
  },
  tlCover: {
    width: "36px",
    height: "36px",
    borderRadius: tokens.borderRadiusSmall,
    flexShrink: 0,
  },
  tlTitleCell: {
    flex: "1 1 0px",
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    rowGap: tokens.spacingVerticalXXS,
  },
  tlTitleBar: {
    height: "14px",
    borderRadius: tokens.borderRadiusSmall,
  },
  // Artist/album stacked under the title on mobile (their own columns on desktop).
  tlMobileSubBar: {
    height: "10px",
    width: "44%",
    borderRadius: tokens.borderRadiusSmall,
    "@media (min-width: 768px)": {
      display: "none",
    },
  },
  tlFlexCell: {
    display: "none",
    "@media (min-width: 768px)": {
      display: "flex",
      flex: "1 1 0px",
      minWidth: 0,
    },
  },
  tlFlexBar: {
    height: "12px",
    borderRadius: tokens.borderRadiusSmall,
  },
  tlQualityCell: {
    flex: "0 0 auto",
    display: "flex",
    justifyContent: "flex-start",
    flexShrink: 0,
    "@media (min-width: 768px)": {
      flex: "0 0 120px",
    },
  },
  tlQualityPill: {
    width: "46px",
    height: "16px",
    borderRadius: tokens.borderRadiusCircular,
  },
  tlTimeCell: {
    flex: "0 0 auto",
    display: "flex",
    justifyContent: "flex-end",
    flexShrink: 0,
    "@media (min-width: 768px)": {
      flex: "0 0 56px",
    },
  },
  tlTimeBar: {
    width: "32px",
    height: "12px",
    borderRadius: tokens.borderRadiusSmall,
  },
  tlActionsCell: {
    flex: "0 0 auto",
    display: "flex",
    justifyContent: "flex-end",
    gap: tokens.spacingHorizontalXS,
    flexShrink: 0,
    "@media (min-width: 768px)": {
      flex: "0 0 36px",
    },
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
    "@media (min-width: 640px)": {
      gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    },
    "@media (min-width: 900px)": {
      gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
      gap: tokens.spacingHorizontalM,
    },
  },
  mediaCard: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    width: "100%",
    // Match useCardStyles `card` chrome (not a heavier custom glass mix).
    borderRadius: tokens.borderRadiusMedium,
    overflow: "hidden",
    backgroundColor: tokens.colorNeutralBackgroundAlpha,
    backdropFilter: "blur(10px)",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
    boxShadow: tokens.shadow8,
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
    // Alias kept for callers; video cards are 16:9 (cover-crop taller thumbs).
    aspectRatio: "16 / 9",
  },
  mediaPreviewFill: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    borderRadius: tokens.borderRadiusNone,
  },
  mediaCardContent: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    // Matches the real card surface (cardStyles.ts `cardContent`).
    padding: `${tokens.spacingVerticalSNudge} ${tokens.spacingHorizontalS}`,
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
  mediaCardSubtitle: {
    height: "12px",
    width: "60%",
    borderRadius: tokens.borderRadiusSmall,
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
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    "@media (min-width: 768px)": {
      gap: tokens.spacingHorizontalS,
    },
  },
  dataGridRow: {
    display: "grid",
    gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    alignItems: "center",
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorSubtleBackground,
    "@media (min-width: 768px)": {
      gap: tokens.spacingHorizontalS,
    },
    ":last-child": {
      borderBottom: "none",
    },
  },
  dataGridRowCompact: {
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
  },
  dataGridCols1: {
    gridTemplateColumns: "repeat(1, minmax(0, 1fr))",
  },
  dataGridCols2: {
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  },
  dataGridCols3: {
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  },
  dataGridCols4: {
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  },
  dataGridCols5: {
    gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
  },
  dataGridCols6: {
    gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
  },
  dataGridCols7: {
    gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
  },
  dataGridCols8: {
    gridTemplateColumns: "repeat(8, minmax(0, 1fr))",
  },
  dataGridColsLibraryArtists: {
    gridTemplateColumns: "48px minmax(180px, 2fr) minmax(90px, 0.9fr) minmax(90px, 0.9fr) minmax(80px, 0.7fr) 72px",
  },
  dataGridColsLibraryAlbums: {
    gridTemplateColumns: "48px minmax(200px, 2fr) minmax(140px, 1.3fr) 90px 110px 72px",
  },
  dataGridColsLibraryTracks: {
    gridTemplateColumns: "48px minmax(200px, 2fr) minmax(140px, 1.3fr) minmax(140px, 1.3fr) 110px 80px 72px",
  },
  dataGridColsLibraryVideos: {
    gridTemplateColumns: "72px minmax(200px, 2fr) minmax(140px, 1.3fr) 110px 80px 72px",
  },
  dataGridColsManualImport: {
    gridTemplateColumns: "minmax(260px, 2.2fr) minmax(240px, 1.8fr) minmax(160px, 1fr)",
  },
  dataGridCell: {
    height: "14px",
    borderRadius: tokens.borderRadiusSmall,
  },
  cellWidth58: {
    width: "58%",
  },
  cellWidth60: {
    width: "60%",
  },
  cellWidth72: {
    width: "72%",
  },
  cellWidth82: {
    width: "82%",
  },
  cellWidth88: {
    width: "88%",
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
  queueList: {
    display: "flex",
    flexDirection: "column",
    borderRadius: tokens.borderRadiusMedium,
    overflow: "hidden",
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 60%, transparent)`,
    backdropFilter: "blur(20px)",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  // Mirrors dashboardStyles.downloadItem (Active queue rows).
  queueItem: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
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
  // Mirrors dashboardStyles.activityItem (centered row, compact padding).
  activityItem: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    ":last-child": {
      borderBottom: "none",
    },
  },
  activityLead: {
    width: "28px",
    minWidth: "28px",
    display: "flex",
    justifyContent: "center",
    flexShrink: 0,
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
  activitySubtitleEven: {
    width: "min(360px, 88%)",
  },
  activitySubtitleOdd: {
    width: "min(280px, 68%)",
  },
  activityTrailing: {
    width: "56px",
    height: "12px",
    borderRadius: tokens.borderRadiusSmall,
    flexShrink: 0,
  },
  // Video detail: 16:9 player + open info block (matches VideoPage).
  videoDetailPage: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
    maxWidth: "1280px",
    width: "100%",
    margin: "0 auto",
    paddingBottom: tokens.spacingVerticalXXL,
  },
  videoPlayer: {
    position: "relative",
    width: "100%",
    aspectRatio: "16 / 9",
    borderRadius: tokens.borderRadiusMedium,
    overflow: "hidden",
    backgroundColor: tokens.colorNeutralBackground3,
    boxShadow: tokens.shadow16,
    flexShrink: 0,
  },
  videoPlayerFill: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    borderRadius: tokens.borderRadiusNone,
  },
  videoInfo: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXXS}`,
    "@media (min-width: 768px)": {
      padding: `${tokens.spacingVerticalM} 0`,
    },
  },
  videoTitleBlock: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    minWidth: 0,
    "@media (min-width: 768px)": {
      gap: tokens.spacingVerticalSNudge,
    },
  },
  videoPersona: {
    width: "120px",
    height: "16px",
    borderRadius: tokens.borderRadiusSmall,
  },
  videoTitle: {
    height: "28px",
    width: "min(420px, 78%)",
    borderRadius: tokens.borderRadiusMedium,
  },
  videoMetaRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  detailPage: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXL,
    width: "100%",
  },
  detailHeader: {
    // Matches the real ArtistPage/AlbumPage header: a transparent rounded
    // region sitting over the global UltraBlur background — NOT a bordered
    // glass card. (No background/border/backdrop here on purpose.)
    position: "relative",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusXLarge,
    overflow: "hidden",
    "@media (min-width: 768px)": {
      padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
    },
  },
  detailHeaderRounded: {
    paddingBottom: tokens.spacingVerticalS,
  },
  detailHeaderContent: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalS,
    width: "100%",
    "@media (min-width: 768px)": {
      flexDirection: "row",
      alignItems: "stretch",
      gap: tokens.spacingHorizontalXL,
    },
  },
  detailArt: {
    flexShrink: 0,
  },
  // Artist avatar sizing (matches ArtistPage `artistImage`: 160 / 180 / 200).
  detailArtCircle: {
    borderRadius: tokens.borderRadiusCircular,
    width: "160px",
    height: "160px",
    "@media (min-width: 480px)": {
      width: "180px",
      height: "180px",
    },
    "@media (min-width: 768px)": {
      width: "200px",
      height: "200px",
    },
  },
  // Album cover sizing (matches AlbumPage `coverArt`: 200 / 220 / 220).
  detailArtRounded: {
    borderRadius: tokens.borderRadiusLarge,
    width: "200px",
    height: "200px",
    "@media (min-width: 480px)": {
      width: "220px",
      height: "220px",
    },
    "@media (min-width: 768px)": {
      width: "220px",
      height: "220px",
    },
  },
  detailInfo: {
    display: "flex",
    flexDirection: "column",
    // Match AlbumPage/ArtistPage info columns (section rhythm = M).
    gap: tokens.spacingVerticalM,
    alignItems: "center",
    width: "100%",
    "@media (min-width: 768px)": {
      alignItems: "flex-start",
      justifyContent: "flex-end",
      flex: 1,
    },
  },
  // Title block is tighter than section rhythm (persona/byline ↔ title).
  detailTitleBlock: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalXS,
    width: "100%",
    minWidth: 0,
    "@media (min-width: 768px)": {
      alignItems: "flex-start",
      gap: tokens.spacingVerticalSNudge,
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
  // Artist header info is a name + multi-line biography paragraph (no subtitle
  // bar or metadata pills), so mirror that shape instead of the album layout.
  detailBioBlock: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    width: "100%",
    alignItems: "center",
    "@media (min-width: 768px)": {
      alignItems: "flex-start",
      maxWidth: "560px",
    },
  },
  detailBioLine: {
    height: "13px",
    borderRadius: tokens.borderRadiusSmall,
  },
  detailBioLineFirst: {
    width: "94%",
  },
  detailBioLineSecond: {
    width: "88%",
  },
  detailBioLineThird: {
    width: "66%",
  },
  detailMetadataPill: {
    height: "14px",
    borderRadius: tokens.borderRadiusCircular,
  },
  detailPill46: {
    width: "46px",
  },
  detailPill48: {
    width: "48px",
  },
  detailPill54: {
    width: "54px",
  },
  detailPill64: {
    width: "64px",
  },
  detailPill72: {
    width: "72px",
  },
  detailPill78: {
    width: "78px",
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
    width: "96px",
  },
  actionWidth72: {
    width: "72px",
  },
  actionWidth82: {
    width: "82px",
  },
  actionWidth84: {
    width: "84px",
  },
  actionWidth88: {
    width: "88px",
  },
  actionWidth92: {
    width: "92px",
  },
  actionWidth96: {
    width: "96px",
  },
  actionWidth104: {
    width: "104px",
  },
  actionWidth110: {
    width: "110px",
  },
  actionWidth112: {
    width: "112px",
  },
  actionWidth116: {
    width: "116px",
  },
  actionWidth142: {
    width: "142px",
  },
  actionWidth154: {
    width: "154px",
  },
  detailActionOptional: {
    display: "none",
    "@media (min-width: 768px)": {
      display: "block",
    },
  },
  detailSection: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  detailSectionTitle: {
    // Matches Title2 (fontSizeHero700 ≈ 28px) used for section headers.
    height: "28px",
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

function getCellWidthClass(
  styles: ReturnType<typeof useStyles>,
  columnIndex: number,
  rowIndex: number,
  isHeader: boolean,
) {
  if (isHeader) {
    return columnIndex % 2 === 0 ? styles.cellWidth72 : styles.cellWidth58;
  }

  const widths = [
    styles.cellWidth88,
    styles.cellWidth72,
    styles.cellWidth60,
    styles.cellWidth82,
  ];
  return widths[(columnIndex + rowIndex) % widths.length];
}

function getDataGridColumnClass(
  styles: ReturnType<typeof useStyles>,
  columns: number,
  columnTemplate?: string,
) {
  switch (columnTemplate) {
    case "48px minmax(180px, 2fr) minmax(90px, 0.9fr) minmax(90px, 0.9fr) minmax(80px, 0.7fr) 72px":
      return styles.dataGridColsLibraryArtists;
    case "48px minmax(200px, 2fr) minmax(140px, 1.3fr) 90px 110px 72px":
      return styles.dataGridColsLibraryAlbums;
    case "48px minmax(200px, 2fr) minmax(140px, 1.3fr) minmax(140px, 1.3fr) 110px 80px 72px":
      return styles.dataGridColsLibraryTracks;
    case "72px minmax(200px, 2fr) minmax(140px, 1.3fr) 110px 80px 72px":
      return styles.dataGridColsLibraryVideos;
    case "minmax(260px, 2.2fr) minmax(240px, 1.8fr) minmax(160px, 1fr)":
      return styles.dataGridColsManualImport;
    default:
      break;
  }

  switch (Math.max(columns, 1)) {
    case 1:
      return styles.dataGridCols1;
    case 2:
      return styles.dataGridCols2;
    case 3:
      return styles.dataGridCols3;
    case 4:
      return styles.dataGridCols4;
    case 6:
      return styles.dataGridCols6;
    case 7:
      return styles.dataGridCols7;
    case 8:
      return styles.dataGridCols8;
    case 5:
    default:
      return styles.dataGridCols5;
  }
}

function getActionWidthClass(styles: ReturnType<typeof useStyles>, width: string) {
  switch (width) {
    case "72px":
      return styles.actionWidth72;
    case "82px":
      return styles.actionWidth82;
    case "84px":
      return styles.actionWidth84;
    case "88px":
      return styles.actionWidth88;
    case "92px":
      return styles.actionWidth92;
    case "96px":
      return styles.actionWidth96;
    case "104px":
      return styles.actionWidth104;
    case "110px":
      return styles.actionWidth110;
    case "112px":
      return styles.actionWidth112;
    case "116px":
      return styles.actionWidth116;
    case "142px":
      return styles.actionWidth142;
    case "154px":
      return styles.actionWidth154;
    default:
      return styles.actionWidth96;
  }
}

export function TrackListSkeleton({
  rows = 8,
  showCover = false,
  showNumber = true,
  showArtist = false,
  showAlbum = false,
  showQuality = true,
  showHeader = true,
  actions = 1,
  className,
}: TrackListSkeletonProps) {
  const styles = useStyles();
  const actionCount = Math.max(actions, 1);

  return (
    <Skeleton
      animation="wave"
      className={mergeClasses(styles.tlTable, className)}
      aria-busy="true"
      aria-label="Loading tracks"
    >
      {/* Desktop-only header row, mirroring the real table's columns. */}
      {showHeader ? (
        <div className={styles.tlHeaderRow}>
          {showNumber ? (
            <div className={styles.tlIndexCell}>
              <SkeletonItem className={mergeClasses(styles.tlHeaderLabel, styles.tlHeaderLabelIndex)} />
            </div>
          ) : null}
          {showCover ? <div className={mergeClasses(styles.tlCover, styles.tlCoverHidden)} /> : null}
          <div className={styles.tlTitleCell}>
            <SkeletonItem className={mergeClasses(styles.tlHeaderLabel, styles.tlHeaderLabelTitle)} />
          </div>
          {showArtist ? (
            <div className={styles.tlFlexCell}>
              <SkeletonItem className={mergeClasses(styles.tlHeaderLabel, styles.tlHeaderLabelWide)} />
            </div>
          ) : null}
          {showAlbum ? (
            <div className={styles.tlFlexCell}>
              <SkeletonItem className={mergeClasses(styles.tlHeaderLabel, styles.tlHeaderLabelWide)} />
            </div>
          ) : null}
          {showQuality ? (
            <div className={styles.tlQualityCell}>
              <SkeletonItem className={mergeClasses(styles.tlHeaderLabel, styles.tlHeaderLabelQuality)} />
            </div>
          ) : null}
          <div className={styles.tlTimeCell}>
            <SkeletonItem className={mergeClasses(styles.tlHeaderLabel, styles.tlHeaderLabelWide)} />
          </div>
          <div className={styles.tlActionsCell} />
        </div>
      ) : null}

      {range(rows).map((row) => (
        <div key={row} className={styles.tlRow}>
          {showNumber ? (
            <div className={styles.tlIndexCell}>
              <SkeletonItem className={styles.tlIndexBar} />
            </div>
          ) : null}
          {showCover ? <SkeletonItem className={styles.tlCover} /> : null}
          <div className={styles.tlTitleCell}>
            <SkeletonItem
              className={mergeClasses(
                styles.tlTitleBar,
                row % 2 === 0 ? styles.tlTitleBarEven : styles.tlTitleBarOdd,
              )}
            />
            {showArtist || showAlbum || showCover ? <SkeletonItem className={styles.tlMobileSubBar} /> : null}
          </div>
          {showArtist ? (
            <div className={styles.tlFlexCell}>
              <SkeletonItem
                className={mergeClasses(
                  styles.tlFlexBar,
                  row % 2 === 0 ? styles.tlArtistBarEven : styles.tlArtistBarOdd,
                )}
              />
            </div>
          ) : null}
          {showAlbum ? (
            <div className={styles.tlFlexCell}>
              <SkeletonItem
                className={mergeClasses(
                  styles.tlFlexBar,
                  row % 3 === 0 ? styles.tlAlbumBarThird : styles.tlAlbumBarDefault,
                )}
              />
            </div>
          ) : null}
          {showQuality ? (
            <div className={styles.tlQualityCell}>
              <SkeletonItem className={styles.tlQualityPill} />
            </div>
          ) : null}
          <div className={styles.tlTimeCell}>
            <SkeletonItem className={styles.tlTimeBar} />
          </div>
          <div className={styles.tlActionsCell}>
            {range(actionCount).map((action) => (
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
  className,
}: CardGridSkeletonProps) {
  const styles = useStyles();
  const previewClassName = getPreviewClassName(styles, thumbnailAspect);

  return (
    <Skeleton
      animation="wave"
      className={mergeClasses(styles.cardGrid, className)}
      aria-busy="true"
      aria-label="Loading cards"
    >
      {range(cards).map((card) => (
        <div key={card} className={styles.mediaCard}>
          <div className={previewClassName}>
            <SkeletonItem className={styles.mediaPreviewFill} />
          </div>
          <div className={styles.mediaCardContent}>
            <div className={styles.mediaCardTitleRow}>
              <SkeletonItem className={styles.mediaCardTitle} />
            </div>
            <SkeletonItem className={styles.mediaCardSubtitle} />
          </div>
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
  thumbnailColumns = [],
  circularThumbnailColumns = [],
  actionColumns = [],
  actionsPerColumn = 1,
}: DataGridSkeletonProps) {
  const styles = useStyles();
  const columnLayoutClass = getDataGridColumnClass(styles, columns, columnTemplate);

  return (
    <Skeleton
      animation="wave"
      className={mergeClasses(styles.dataGrid, className)}
      aria-busy="true"
      aria-label="Loading data"
    >
      <div className={mergeClasses(styles.dataGridHeader, columnLayoutClass)}>
        {range(columns).map((column) => (
          <SkeletonItem
            key={`header-${column}`}
            className={mergeClasses(styles.dataGridCell, getCellWidthClass(styles, column, 0, true))}
          />
        ))}
      </div>

      {range(rows).map((row) => (
        <div
          key={row}
          className={mergeClasses(
            styles.dataGridRow,
            columnLayoutClass,
            compact ? styles.dataGridRowCompact : undefined,
          )}
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
                  {range(actionsPerColumn).map((action) => (
                    <SkeletonItem key={action} className={styles.actionDot} />
                  ))}
                </div>
              );
            }

            return (
              <SkeletonItem
                key={`cell-${row}-${column}`}
                className={mergeClasses(styles.dataGridCell, getCellWidthClass(styles, column, row, false))}
              />
            );
          })}
        </div>
      ))}
    </Skeleton>
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
              className={mergeClasses(
                styles.activitySubtitle,
                row % 2 === 0 ? styles.activitySubtitleEven : styles.activitySubtitleOdd,
              )}
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
  info = "metadata",
  rows = 8,
  cards = 6,
  className,
  cardsClassName,
  label = "Loading page details...",
  actionWidths = ["104px", "96px", "88px", "116px", "84px"],
}: DetailPageSkeletonProps) {
  const styles = useStyles();

  return (
    <div
      className={mergeClasses(styles.detailPage, className)}
      aria-busy="true"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <Skeleton animation="wave">
        <div className={mergeClasses(
          styles.detailHeader,
          artShape === "rounded" ? styles.detailHeaderRounded : undefined,
        )}>
          <div className={styles.detailHeaderContent}>
            <SkeletonItem
              className={mergeClasses(
                styles.detailArt,
                artShape === "circle" ? styles.detailArtCircle : styles.detailArtRounded,
              )}
            />
            <div className={styles.detailInfo}>
              {info === "bio" ? (
                <>
                  <div className={styles.detailTitleBlock}>
                    <SkeletonItem className={styles.detailTitle} />
                  </div>
                  <div className={styles.detailBioBlock}>
                    <SkeletonItem className={mergeClasses(styles.detailBioLine, styles.detailBioLineFirst)} />
                    <SkeletonItem className={mergeClasses(styles.detailBioLine, styles.detailBioLineSecond)} />
                    <SkeletonItem className={mergeClasses(styles.detailBioLine, styles.detailBioLineThird)} />
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.detailTitleBlock}>
                    <SkeletonItem className={styles.detailSubtitle} />
                    <SkeletonItem className={styles.detailTitle} />
                  </div>
                  <div className={styles.detailMetadataRow}>
                    <SkeletonItem className={mergeClasses(styles.detailMetadataPill, styles.detailPill64)} />
                    <SkeletonItem className={mergeClasses(styles.detailMetadataPill, styles.detailPill46)} />
                    <SkeletonItem className={mergeClasses(styles.detailMetadataPill, styles.detailPill78)} />
                  </div>
                </>
              )}
              <div className={styles.detailActions}>
                {actionWidths.map((width, index) => (
                  <SkeletonItem
                    key={`${width}-${index}`}
                    className={mergeClasses(
                      styles.detailAction,
                      getActionWidthClass(styles, width),
                      index >= 3 ? styles.detailActionOptional : undefined,
                    )}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </Skeleton>

      {/*
        Header + primary content only. Album release-availability (and other
        deferred rails) paint after /page — do not reserve a Releases block here.
      */}
      <div className={styles.detailSection}>
        <Skeleton animation="wave">
          <SkeletonItem className={styles.detailSectionTitle} />
        </Skeleton>
        {content === "cards" ? (
          <CardGridSkeleton cards={cards} className={cardsClassName} />
        ) : (
          <TrackListSkeleton rows={rows} showArtist showQuality />
        )}
      </div>
    </div>
  );
}

export function VideoDetailSkeleton({
  className,
  label = "Loading video…",
  actionWidths = ["104px", "88px", "96px", "84px"],
}: VideoDetailSkeletonProps) {
  const styles = useStyles();

  return (
    <div
      className={mergeClasses(styles.videoDetailPage, className)}
      aria-busy="true"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <Skeleton animation="wave">
        <div className={styles.videoPlayer}>
          <SkeletonItem className={styles.videoPlayerFill} />
        </div>
        <div className={styles.videoInfo}>
          <div className={styles.videoTitleBlock}>
            <SkeletonItem className={styles.videoPersona} />
            <SkeletonItem className={styles.videoTitle} />
          </div>
          <div className={styles.videoMetaRow}>
            <SkeletonItem className={mergeClasses(styles.detailMetadataPill, styles.detailPill54)} />
            <SkeletonItem className={mergeClasses(styles.detailMetadataPill, styles.detailPill72)} />
            <SkeletonItem className={mergeClasses(styles.detailMetadataPill, styles.detailPill48)} />
          </div>
          <div className={styles.detailActions}>
            {actionWidths.map((width, index) => (
              <SkeletonItem
                key={`${width}-${index}`}
                className={mergeClasses(
                  styles.detailAction,
                  getActionWidthClass(styles, width),
                  index >= 3 ? styles.detailActionOptional : undefined,
                )}
              />
            ))}
          </div>
        </div>
      </Skeleton>
    </div>
  );
}
