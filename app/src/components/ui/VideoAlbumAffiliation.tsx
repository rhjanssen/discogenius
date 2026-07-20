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
import { renderableArtworkUrl } from "@/utils/artwork";
import { navigateToAlbum, navigateToAlbumTrack } from "@/utils/albumNavigation";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    minWidth: 0,
  },
  label: {
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    minWidth: 0,
  },
  // Queue-inspired media object: square cover + title/subtitle, whole row navigates.
  row: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
    maxWidth: "420px",
    margin: 0,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    border: `${tokens.strokeWidthThin} solid transparent`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: "transparent",
    color: "inherit",
    textAlign: "left",
    cursor: "pointer",
    transitionProperty: "background-color, border-color",
    transitionDuration: tokens.durationFaster,
    transitionTimingFunction: tokens.curveEasyEase,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
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

function formatTrackPosition(album: VideoAlbumRefContract): string | null {
  if (album.track_number == null || !Number.isFinite(album.track_number)) {
    return null;
  }
  const track = Math.trunc(album.track_number);
  if (track <= 0) {
    return null;
  }
  const volume = album.volume_number == null ? null : Math.trunc(album.volume_number);
  if (volume != null && volume > 1) {
    return `Disc ${volume} · Track ${track}`;
  }
  return `Track ${track}`;
}

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
          const coverUrl = renderableArtworkUrl(album.cover_id) || undefined;
          const position = formatTrackPosition(album);
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
