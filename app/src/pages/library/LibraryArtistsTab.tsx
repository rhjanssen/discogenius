/**
 * Artists tab pieces extracted from Library.tsx.
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
  Tag24Regular,
  Rename24Regular,
  Video24Regular,
  ArrowSync24Filled,
  ArrowDownload24Filled,
  Eye24Filled,
  EyeOff24Filled,
  ArrowSortDownLines24Filled,
  Search24Filled,
  Tag24Filled,
  Rename24Filled,
  Video24Filled,
  bundleIcon,
} from "@fluentui/react-icons";
import { useMemo, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { EmptyState } from "@/components/ui/ContentState";
import { CompletionProgressPill } from "@/components/ui/CompletionProgressPill";
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
const Tag24 = bundleIcon(Tag24Filled, Tag24Regular);
const Rename24 = bundleIcon(Rename24Filled, Rename24Regular);
const Video24 = bundleIcon(Video24Filled, Video24Regular);

/** MusicBrainz artist "type" (Person, Group, …) is stored as a JSON array on
 * artist_types. Show the primary type in the list, Lidarr-style. */
function formatArtistType(artistTypes: unknown): string | null {
  let value: unknown = artistTypes;
  if (typeof artistTypes === "string") {
    const trimmed = artistTypes.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("[")) {
      try {
        value = JSON.parse(trimmed);
      } catch {
        value = trimmed;
      }
    } else {
      value = trimmed;
    }
  }
  const first = Array.isArray(value) ? value[0] : value;
  const label = String(first ?? "").trim();
  if (!label || label.toLowerCase() === "artist") return null;
  return label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
}

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
  onRename: () => void;
  onWriteTags: () => void;
  onMonitor: () => void;
  onUnmonitor: () => void;
  fileToolsBusy?: boolean;
  renameIcon?: ReactNode;
  retagIcon?: ReactNode;
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
  onRename,
  onWriteTags,
  onMonitor,
  onUnmonitor,
  fileToolsBusy,
  renameIcon,
  retagIcon,
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
          key: "rename",
          label: "Preview Rename",
          icon: (renameIcon as ReactElement) ?? <Rename24 />,
          onClick: onRename,
          disabled: selectedCount === 0 || Boolean(fileToolsBusy),
        },
        {
          key: "retag",
          label: "Write Tags",
          icon: (retagIcon as ReactElement) ?? <Tag24 />,
          onClick: onWriteTags,
          disabled: selectedCount === 0 || Boolean(fileToolsBusy),
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
  /** Show the music-video counter column (gated on the music-videos setting). */
  showVideos?: boolean;
};

/** Column definitions for the artists DataGrid list view. */
export function useLibraryArtistColumns({
  onScan,
  onCurate,
  onDownload,
  onToggleMonitored,
  showVideos = false,
}: UseLibraryArtistColumnsOptions): DataGridColumn[] {
  const dgCell = useDataGridCellStyles();

  return useMemo<DataGridColumn[]>(() => {
    const columns: DataGridColumn[] = [
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
      width: "minmax(0, 1fr)",
      wrap: true,
      render: (artist: any) => {
        const monitoredAlbums = artist.monitored_album_count ?? 0;
        const totalAlbums = artist.album_count ?? 0;
        const albumLabel = `${monitoredAlbums} / ${totalAlbums} albums`;
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
      key: "type",
      header: "Type",
      width: "90px",
      align: "left",
      minWidth: 1024,
      className: dgCell.hideOnTablet,
      render: (artist: any) => {
        const type = formatArtistType(artist.artist_types);
        return type
          ? <Text size={200}>{type}</Text>
          : <Text size={200} className={dgCell.statSecondary}>—</Text>;
      },
    },
    {
      key: "albums",
      header: "Albums",
      width: "90px",
      align: "center",
      minWidth: 768,
      className: dgCell.hideOnMobile,
      render: (artist: any) => {
        const downloaded = artist.downloaded_album_count ?? 0;
        const monitored = artist.monitored_album_count ?? 0;
        return (
          <>
            <span className={dgCell.statPrimary}>{downloaded}</span>
            <span className={dgCell.statSecondary}> / {monitored}</span>
          </>
        );
      },
    },
    {
      key: "tracks",
      header: "Tracks",
      width: "140px",
      align: "center",
      minWidth: 768,
      className: dgCell.hideOnMobile,
      render: (artist: any) => {
        const downloaded = Number(artist.track_file_count ?? 0);
        const total = Number(artist.monitored_track_count ?? artist.track_count ?? 0);
        return (
          <CompletionProgressPill
            value={downloaded}
            total={total}
            title={`${downloaded} of ${total} tracks downloaded`}
          />
        );
      },
    },
    {
      key: "videos",
      header: "Videos",
      width: "80px",
      align: "center",
      minWidth: 768,
      className: dgCell.hideOnMobile,
      render: (artist: any) => {
        const videos = Number(artist.video_count ?? 0);
        return videos > 0
          ? (
            <span className={dgCell.badgeContainer} style={{ justifyContent: "center" }}>
              <Video24 style={{ fontSize: "16px", opacity: 0.6 }} />
              <span className={dgCell.statPrimary}>{videos}</span>
            </span>
          )
          : <span className={dgCell.statSecondary}>—</span>;
      },
    },
    {
      key: "scanned",
      header: "Scanned",
      width: "120px",
      align: "right",
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
    ];

    return showVideos ? columns : columns.filter((column) => column.key !== "videos");
  }, [dgCell, onScan, onCurate, onDownload, onToggleMonitored, showVideos]);
}
