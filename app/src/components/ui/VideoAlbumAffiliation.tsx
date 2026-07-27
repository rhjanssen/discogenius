import {
  Caption1,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { MusicNote224Regular } from "@fluentui/react-icons";
import { useNavigate } from "react-router-dom";
import type { VideoAlbumRefContract } from "@contracts/media";
import { mediaCoverSrc } from "@/utils/artwork";
import { navigateToAlbum, navigateToAlbumTrack } from "@/utils/albumNavigation";
import { formatDescriptiveTrackPosition } from "@/utils/trackPosition";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    minWidth: 0,
    width: "100%",
  },
  label: {
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
  },
  // Mobile: stacked list. Desktop: up to 3 cards across (covers stay readable).
  list: {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: tokens.spacingVerticalXS,
    width: "100%",
    minWidth: 0,
    "@media (min-width: 640px)": {
      gridTemplateColumns: "repeat(2, minmax(200px, 1fr))",
      gap: tokens.spacingHorizontalS,
    },
    "@media (min-width: 960px)": {
      gridTemplateColumns: "repeat(3, minmax(220px, 1fr))",
    },
  },
  // Tracklist-style frosted hover (DataGrid row).
  row: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
    width: "100%",
    margin: 0,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    border: `${tokens.strokeWidthThin} solid transparent`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorSubtleBackground,
    color: "inherit",
    textAlign: "left",
    cursor: "pointer",
    transitionProperty: "background-color, backdrop-filter",
    transitionDuration: tokens.durationFast,
    transitionTimingFunction: tokens.curveEasyEase,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackgroundAlpha,
      backdropFilter: "blur(14px) saturate(140%)",
      WebkitBackdropFilter: "blur(14px) saturate(140%)",
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
    },
  },
  cover: {
    width: "40px",
    height: "40px",
    borderRadius: tokens.borderRadiusSmall,
    objectFit: "cover",
    backgroundColor: tokens.colorNeutralBackground3,
    flexShrink: 0,
  },
  coverPlaceholder: {
    width: "40px",
    height: "40px",
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground3,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    color: tokens.colorNeutralForeground4,
  },
  info: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  title: {
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  subtitle: {
    color: tokens.colorNeutralForeground3,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

export function VideoAlbumAffiliation({
  albums,
  className,
}: {
  albums: VideoAlbumRefContract[];
  className?: string;
}) {
  const styles = useStyles();
  const navigate = useNavigate();

  if (albums.length === 0) {
    return null;
  }

  return (
    <div className={mergeClasses(styles.root, className)}>
      <Caption1 className={styles.label}>
        {albums.length === 1 ? "Appears on" : "Appears on albums"}
      </Caption1>
      <div className={styles.list}>
        {albums.map((album) => {
          const coverUrl = mediaCoverSrc(album) || undefined;
          const position = formatDescriptiveTrackPosition(album);
          const goToAlbum = () => {
            if (album.track_mbid) {
              navigateToAlbumTrack(navigate, album.id, album.track_mbid);
            } else {
              navigateToAlbum(navigate, album.id);
            }
          };

          return (
            <button
              key={album.id}
              type="button"
              className={styles.row}
              onClick={goToAlbum}
              aria-label={
                position
                  ? `Open album ${album.title}, ${position}`
                  : `Open album ${album.title}`
              }
            >
              {coverUrl ? (
                <img src={coverUrl} alt="" className={styles.cover} />
              ) : (
                <div className={styles.coverPlaceholder} aria-hidden="true">
                  <MusicNote224Regular />
                </div>
              )}
              <div className={styles.info}>
                <Text className={styles.title}>{album.title}</Text>
                {position ? (
                  <Caption1 className={styles.subtitle}>{position}</Caption1>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
