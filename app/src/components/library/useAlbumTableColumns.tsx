import { useMemo, type ReactNode } from "react";
import { Text, mergeClasses } from "@fluentui/react-components";
import { useDataGridCellStyles, type DataGridColumn } from "@/components/DataGrid";
import { ProviderQualityRow } from "@/components/ui/ProviderQualityPill";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { albumSelectedQualityOffers } from "@/utils/albumSelectedQualityOffers";
import { mediaCoverSrc, type MediaCoverEntity } from "@/utils/artwork";

export type AlbumTableRow = MediaCoverEntity & {
  id: string | number;
  title: string;
  artist_name?: string | null;
  release_date?: string | null;
  quality?: string | null;
  local_quality?: string | null;
  local_qualities?: string[] | null;
  is_downloaded?: boolean | null;
  downloaded?: boolean | number | null;
  track_file_count?: number | null;
  track_count?: number | null;
  num_tracks?: number | null;
  stereo_provider_id?: string | null;
  stereo_provider_url?: string | null;
  stereo_quality?: string | null;
  stereo_provider?: string | null;
  stereo_match_status?: string | null;
  stereo_release_mbid?: string | null;
  spatial_provider_id?: string | null;
  spatial_provider_url?: string | null;
  spatial_quality?: string | null;
  spatial_provider?: string | null;
  spatial_match_status?: string | null;
  spatial_release_mbid?: string | null;
  selected_provider?: string | null;
  selected_release_mbid?: string | null;
};

function providerQuality(album: AlbumTableRow): ReactNode {
  const offers = albumSelectedQualityOffers(album);
  if (offers.length > 0) {
    return <ProviderQualityRow size="small" offers={offers} />;
  }
  return album.quality ? <QualityBadge quality={album.quality} size="small" /> : null;
}

function localQualities(album: AlbumTableRow): string[] {
  const downloaded = Boolean(album.is_downloaded ?? album.downloaded);
  const raw = Array.isArray(album.local_qualities) && album.local_qualities.length > 0
    ? album.local_qualities
    : album.local_quality
      ? [album.local_quality]
      : downloaded && album.quality
        ? [album.quality]
        : [];
  return [...new Set(raw.map((quality) => String(quality || "").trim()).filter(Boolean))];
}

/**
 * Canonical album table definition shared by the library and artist pages.
 * Page-specific actions stay injected; artwork, metadata, quality, and column
 * order remain one implementation.
 */
export function useAlbumTableColumns<T extends AlbumTableRow = AlbumTableRow>({
  showArtist = false,
  renderActions,
}: {
  showArtist?: boolean;
  renderActions: (album: T) => ReactNode;
}): DataGridColumn<T>[] {
  const dgCell = useDataGridCellStyles();

  return useMemo<DataGridColumn<T>[]>(() => {
    const columns: DataGridColumn<T>[] = [
      {
        key: "thumb",
        header: "",
        width: "52px",
        media: true,
        render: (album) => {
          const src = mediaCoverSrc(album);
          return src ? (
            <img src={src} alt={album.title} className={dgCell.thumbnailSquare} />
          ) : (
            <div className={mergeClasses(dgCell.thumbnailSquare, dgCell.thumbnailPlaceholder)}>?</div>
          );
        },
      },
      {
        key: "title",
        header: "Title",
        width: "minmax(0, 1.5fr)",
        wrap: true,
        render: (album) => {
          const available = providerQuality(album);
          return (
            <div className={dgCell.nameStack}>
              <span className={dgCell.nameCell} title={album.title}>{album.title}</span>
              {showArtist && album.artist_name ? (
                <Text
                  size={200}
                  className={mergeClasses(dgCell.subtitleText, dgCell.showOnMobileOnly)}
                  truncate
                >
                  {album.artist_name}
                </Text>
              ) : null}
              {available ? (
                <div className={dgCell.mobileQuality} aria-label="Available provider quality">
                  {available}
                </div>
              ) : null}
            </div>
          );
        },
      },
    ];

    if (showArtist) {
      columns.push({
        key: "artist",
        header: "Artist",
        width: "minmax(0, 1fr)",
        wrap: true,
        hideBelowWidth: 768,
        className: dgCell.hideOnMobile,
        render: (album) => (
          <Text size={200} className={dgCell.subtitleText} truncate>
            {album.artist_name || "—"}
          </Text>
        ),
      });
    }

    columns.push(
      {
        key: "year",
        header: "Year",
        width: "60px",
        minWidth: 56,
        align: "center",
        hideBelowWidth: 768,
        className: dgCell.hideOnMobile,
        render: (album) => {
          const year = String(album.release_date || "").split("-", 1)[0];
          return <>{year || "—"}</>;
        },
      },
      {
        key: "tracks",
        header: "Tracks",
        width: "80px",
        minWidth: 64,
        align: "right",
        render: (album) => {
          const files = Number(album.track_file_count ?? 0);
          const total = Number(album.track_count ?? album.num_tracks ?? 0);
          const label = total > 0 ? `${files} / ${total}` : String(files);
          return (
            <Text size={200} title={`${files} on disk of ${total} tracks`}>
              {label}
            </Text>
          );
        },
      },
      {
        key: "quality",
        header: "Provider",
        width: "max-content",
        align: "left",
        hideBelowWidth: 768,
        className: dgCell.hideOnMobile,
        render: (album) => providerQuality(album),
      },
      {
        key: "localQuality",
        header: "Local Files",
        width: "max-content",
        align: "left",
        hideBelowWidth: 768,
        className: dgCell.hideOnMobile,
        render: (album) => {
          const qualities = localQualities(album);
          return (
            <div className={dgCell.badgeContainer}>
              {qualities.length > 0
                ? qualities.map((quality) => (
                  <QualityBadge key={quality} quality={quality} size="small" />
                ))
                : <Text size={200} className={dgCell.statSecondary}>—</Text>}
            </div>
          );
        },
      },
      {
        key: "actions",
        header: "",
        width: "max-content",
        align: "right",
        render: renderActions,
      },
    );

    return columns;
  }, [dgCell, renderActions, showArtist]);
}
