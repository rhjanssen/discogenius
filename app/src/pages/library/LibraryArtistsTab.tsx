/**
 * Artists tab pieces extracted from Library.tsx (Lidarr-style incremental split).
 * Column defs, no-results empty state, and selection toolbar — Fluent UI.
 */
import { Text, mergeClasses } from "@fluentui/react-components";
import {
  ArrowSync24Regular,
  ArrowDownload24Regular,
  Eye24Regular,
  EyeOff24Regular,
  ArrowSortDownLines24Regular,
  Search24Regular,
  ArrowSync24Filled,
  ArrowDownload24Filled,
  Eye24Filled,
  EyeOff24Filled,
  ArrowSortDownLines24Filled,
  Search24Filled,
  bundleIcon,
} from "@fluentui/react-icons";
import { useMemo, type MouseEvent, type ReactElement } from "react";
import { EmptyState } from "@/components/ui/ContentState";
import { NotScannedBadge } from "@/components/ui/StatusBadges";
import { LibraryRowActions } from "@/components/library/LibraryRowActions";
import { LibrarySelectionBar } from "@/components/library/LibrarySelectionBar";
import type { DataGridColumn } from "@/components/DataGrid";
import { useDataGridCellStyles } from "@/components/DataGrid";

const ArrowSync24 = bundleIcon(ArrowSync24Filled, ArrowSync24Regular);
const ArrowDownload24 = bundleIcon(ArrowDownload24Filled, ArrowDownload24Regular);
const Eye24 = bundleIcon(Eye24Filled, Eye24Regular);
const EyeOff24 = bundleIcon(EyeOff24Filled, EyeOff24Regular);
const ArrowSortDownLines24 = bundleIcon(ArrowSortDownLines24Filled, ArrowSortDownLines24Regular);
const Search24 = bundleIcon(Search24Filled, Search24Regular);

export function formatArtistLastScanned(date: string | null): string | null {
  if (!date) return null;
  const d = new Date(date);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

export function LibraryArtistsNoResults(): ReactElement {
  return (
    <EmptyState
      title="No artists found"
      description="No artists match your current filters."
      icon={<Search24 />}
      minHeight="220px"
    />
  );
}

type ArtistSelectionBarProps = {
  selectedCount: number;
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
  onSelectAllVisible: () => void;
  onClearSelection: () => void;
  onScan: () => void;
  onCurate: () => void;
  onDownload: () => void;
  onMonitor: () => void;
  onUnmonitor: () => void;
};

/** Selection toolbar shown above the artists grid/list when selection mode is on. */
export function LibraryArtistsSelectionBar({
  selectedCount,
  allVisibleSelected,
  someVisibleSelected,
  onSelectAllVisible,
  onClearSelection,
  onScan,
  onCurate,
  onDownload,
  onMonitor,
  onUnmonitor,
}: ArtistSelectionBarProps): ReactElement {
  return (
    <LibrarySelectionBar
      selectedCount={selectedCount}
      allVisibleSelected={allVisibleSelected}
      someVisibleSelected={someVisibleSelected}
      onSelectAllVisible={onSelectAllVisible}
      onClearSelection={onClearSelection}
      actions={[
        {
          key: "scan",
          label: "Refresh & scan",
          icon: <ArrowSync24 />,
          onClick: onScan,
          disabled: selectedCount === 0,
        },
        {
          key: "curate",
          label: "Curate selected",
          icon: <ArrowSortDownLines24 />,
          onClick: onCurate,
          disabled: selectedCount === 0,
        },
        {
          key: "download",
          label: "Download missing",
          icon: <ArrowDownload24 />,
          onClick: onDownload,
          disabled: selectedCount === 0,
        },
        {
          key: "monitor",
          label: "Monitor",
          icon: <Eye24 />,
          onClick: onMonitor,
          disabled: selectedCount === 0,
        },
        {
          key: "unmonitor",
          label: "Unmonitor",
          icon: <EyeOff24 />,
          onClick: onUnmonitor,
          disabled: selectedCount === 0,
        },
      ]}
    />
  );
}

type UseLibraryArtistColumnsOptions = {
  onScan: (event: MouseEvent, artist: any) => void;
  onCurate: (event: MouseEvent, artist: any) => void;
  onDownload: (event: MouseEvent, artist: any) => void;
  onToggleMonitored: (artistId: string, monitored: boolean) => void;
};

/** Column definitions for the artists DataGrid list view. */
export function useLibraryArtistColumns({
  onScan,
  onCurate,
  onDownload,
  onToggleMonitored,
}: UseLibraryArtistColumnsOptions): DataGridColumn[] {
  const dgCell = useDataGridCellStyles();

  return useMemo<DataGridColumn[]>(() => [
    {
      key: "thumb",
      header: "",
      width: "40px",
      media: true,
      render: (artist: any) => {
        const src = artist.picture || artist.cover_image_url;
        return src ? (
          <img src={src} alt={artist.name} className={dgCell.thumbnailCircle} />
        ) : (
          <div className={mergeClasses(dgCell.thumbnailCircle, dgCell.thumbnailPlaceholder)}>
            {artist.name?.charAt(0)?.toUpperCase() || "?"}
          </div>
        );
      },
    },
    {
      key: "name",
      header: "Name",
      // minmax(0, 1fr) so the name column can shrink on narrow viewports;
      // Albums/Scanned stack under the name below 768px (Fluent list pattern).
      width: "minmax(0, 1fr)",
      wrap: true,
      render: (artist: any) => {
        const albumLabel = `${artist.monitored_album_count ?? "--"} / ${artist.album_count ?? "--"} albums`;
        const scannedLabel = artist.last_scanned
          ? formatArtistLastScanned(artist.last_scanned)
          : "Not scanned";
        return (
          <div className={dgCell.nameStack}>
            <span className={dgCell.nameCell} title={artist.name}>{artist.name}</span>
            <div className={dgCell.mobileMetaLine}>
              <span className={dgCell.mobileMetaText}>{albumLabel}</span>
              <span className={dgCell.mobileMetaText}>·</span>
              <span className={dgCell.mobileMetaText}>{scannedLabel}</span>
            </div>
          </div>
        );
      },
    },
    {
      key: "albums",
      header: "Albums",
      width: "70px",
      align: "center",
      minWidth: 768,
      className: dgCell.hideOnMobile,
      render: (artist: any) => (
        <>
          <span className={dgCell.statPrimary}>{artist.monitored_album_count ?? "--"}</span>
          <span className={dgCell.statSecondary}> / {artist.album_count ?? "--"}</span>
        </>
      ),
    },
    {
      key: "tracks",
      header: "Tracks",
      width: "70px",
      align: "center",
      minWidth: 768,
      className: dgCell.hideOnMobile,
      render: (artist: any) => (
        <>
          <span className={dgCell.statPrimary}>{artist.monitored_track_count ?? "--"}</span>
          <span className={dgCell.statSecondary}> / {artist.track_count ?? "--"}</span>
        </>
      ),
    },
    {
      key: "scanned",
      header: "Scanned",
      width: "132px",
      align: "center",
      minWidth: 768,
      className: dgCell.hideOnMobile,
      render: (artist: any) => artist.last_scanned
        ? <Text size={200}>{formatArtistLastScanned(artist.last_scanned)}</Text>
        : <NotScannedBadge />,
    },
    {
      key: "actions",
      header: "",
      width: "max-content",
      align: "right",
      render: (artist: any) => (
        <LibraryRowActions
          actions={[
            {
              key: "scan",
              label: "Refresh & scan",
              icon: <ArrowSync24 />,
              onClick: (event) => onScan(event, artist),
            },
            {
              key: "curate",
              label: "Curate artist",
              icon: <ArrowSortDownLines24 />,
              onClick: (event) => onCurate(event, artist),
            },
            {
              key: "download",
              label: "Download missing",
              icon: <ArrowDownload24 />,
              onClick: (event) => onDownload(event, artist),
            },
            {
              key: "monitor",
              label: artist.is_monitored ? "Unmonitor" : "Monitor",
              icon: artist.is_monitored ? <EyeOff24 /> : <Eye24 />,
              onClick: (event) => {
                event.stopPropagation();
                onToggleMonitored(artist.id, !artist.is_monitored);
              },
            },
          ]}
        />
      ),
    },
  ], [dgCell, onScan, onCurate, onDownload, onToggleMonitored]);
}
