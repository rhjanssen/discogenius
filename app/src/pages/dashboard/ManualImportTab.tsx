import {
  useCallback,
  useEffect,
  useMemo,
  useState } from 'react';
import {
    Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
  } from '@fluentui/react-components';
import {
  Delete24Regular,
  DocumentSearch24Regular,
  Eye24Regular,
  EyeOff24Regular,
  Search24Regular,
  Record24Regular,
  DocumentSearch24Filled,
  Eye24Filled,
  EyeOff24Filled,
  Search24Filled,
  bundleIcon,
  Delete24Filled
} from "@fluentui/react-icons";
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DataGrid, type DataGridColumn } from '@/components/DataGrid';
import { MediaTypeBadge } from '@/components/ui/MediaTypeBadge';
import { EmptyState } from '@/components/ui/ContentState';
import { DataGridSkeleton } from '@/components/ui/LoadingSkeletons';
import { glassButtonStyles, glassDangerButtonStyles, glassPrimaryButtonStyles } from '@/components/ui/glassButtonStyles';
import { glassSurfaceStyles } from '@/components/ui/glassSurfaceStyles';
import { useDelayedVisible } from '@/hooks/useDelayedVisible';
import { useGlobalEvents } from '@/hooks/useGlobalEvents';
import { useSelectableCollection } from '@/hooks/useSelectableCollection';
import { useToast } from '@/hooks/useToast';
import { api } from '@/services/api';
import { isSpatialAudioQuality } from '@/utils/spatialAudio';
import { mediaCoverProxySrc, renderableArtworkUrl } from '@/utils/artwork';
import ManualImportModal from './ManualImportModal';

const Delete24 = bundleIcon(Delete24Filled, Delete24Regular);

const DocumentSearch24 = bundleIcon(DocumentSearch24Filled, DocumentSearch24Regular);
const Eye24 = bundleIcon(Eye24Filled, Eye24Regular);
const EyeOff24 = bundleIcon(EyeOff24Filled, EyeOff24Regular);
const Search24 = bundleIcon(Search24Filled, Search24Regular);

const GROUP_MIN_FILES = 2;
const GROUP_MIN_RATIO = 0.6;
const UNMAPPED_PAGE_SIZE = 100;

export type UnmappedFile = {
    id: number;
    file_path: string;
    relative_path: string;
    library_root: string;
    filename: string;
    extension: string;
    file_size: number | null;
    duration?: number | null;
    bitrate?: number | null;
    sample_rate?: number | null;
    bit_depth?: number | null;
    channels?: number | null;
    codec?: string | null;
    detected_artist?: string | null;
    detected_album?: string | null;
    detected_track?: string | null;
    audio_quality?: string | null;
    reason?: string | null;
    ignored: boolean;
    created_at?: string;
};

type SortKey = 'filename' | 'detected_artist' | 'detected_album' | 'detected_track' | 'audio_quality' | 'codec' | 'file_size' | 'duration' | 'reason' | 'candidate' | 'created_at';
type DecisionState = 'ready' | 'blocked' | 'ignored';
type DisplayRowKind = 'file' | 'group';

type DisplayRow = {
    id: string;
    kind: DisplayRowKind;
    files: UnmappedFile[];
    anchorFile: UnmappedFile;
    ignored: boolean;
    title: string;
    subtitle: string;
    directory: string;
    relativeDirectory: string;
    artistLabel: string;
    albumLabel: string;
    trackLabel: string;
    primaryQuality: string;
    totalSize: number;
    totalDuration: number | null;
    fileKindLabel: string;
    rejectionReasons: string[];
    decisionState: DecisionState;
    candidate?: { title: string; artistName: string; cover: string | null; score?: number };
    sortValues: Record<SortKey, string | number>;
};

const useStyles = makeStyles({
    container: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalL,
        paddingBottom: tokens.spacingVerticalXXL,
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
    },
    emptyState: {
        padding: tokens.spacingVerticalXXL,
    },
    toolbar: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: tokens.spacingHorizontalM,
        flexWrap: 'wrap',
        padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
        ...glassSurfaceStyles,
        backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 72%, transparent)`,
        borderRadius: tokens.borderRadiusLarge,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    },
    toolbarMeta: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
        minWidth: 0,
    },
    toolbarSummary: {
        color: tokens.colorNeutralForeground1,
        fontWeight: tokens.fontWeightSemibold,
    },
    toolbarHint: {
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase200,
    },
    sortableHeaderButton: {
        appearance: 'none',
        background: 'transparent',
        border: 'none',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalXXS,
    },
    toolbarActions: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        '@media (max-width: 959px)': {
            width: '100%',
            justifyContent: 'flex-start',
        },
    },
    bulkActionRow: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
        flexWrap: 'wrap',
    },
    bulkBadge: {
        paddingLeft: tokens.spacingHorizontalS,
        paddingRight: tokens.spacingHorizontalS,
    },
    tableShell: {
        ...glassSurfaceStyles,
        backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 72%, transparent)`,
        borderRadius: tokens.borderRadiusLarge,
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
        overflowX: 'auto',
        overflowY: 'hidden',
        WebkitOverflowScrolling: 'touch',
        touchAction: 'pan-x pan-y',
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}`,
        boxShadow: tokens.shadow8,
    },
    tableGrid: {
        width: '100%',
        minWidth: '100%',
        maxWidth: '100%',
        boxSizing: 'border-box',
    },
    rowIgnored: {
        opacity: 0.62,
    },
    titleStack: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
        minWidth: 0,
    },
    titleRow: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalXS,
        flexWrap: 'wrap',
        minWidth: 0,
    },
    fileTitle: {
        color: tokens.colorNeutralForeground1,
        fontWeight: tokens.fontWeightSemibold,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    subtitle: {
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase200,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    tagRow: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalXS,
        flexWrap: 'wrap',
    },
    wrappingCell: {
        whiteSpace: 'normal',
        minWidth: 0,
        overflow: 'hidden',
    },
    identifiedInfo: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
        minWidth: 0,
    },
    identifiedLine: {
        display: 'grid',
        gridTemplateColumns: '48px minmax(0, 1fr)',
        gap: tokens.spacingHorizontalXS,
        alignItems: 'baseline',
    },
    identifiedLabel: {
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase200,
    },
    identifiedValue: {
        color: tokens.colorNeutralForeground1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    qualityInfo: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
        minWidth: 0,
    },
    qualityLine: {
        display: 'grid',
        gridTemplateColumns: '56px minmax(0, 1fr)',
        gap: tokens.spacingHorizontalXS,
        alignItems: 'baseline',
    },
    qualityLabel: {
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase200,
    },
    qualityValue: {
        color: tokens.colorNeutralForeground1,
        minWidth: 0,
        whiteSpace: 'nowrap',
    },
    reasonText: {
        color: tokens.colorNeutralForeground2,
        fontSize: tokens.fontSizeBase200,
        lineHeight: tokens.lineHeightBase300,
        display: '-webkit-box',
        WebkitBoxOrient: 'vertical',
        WebkitLineClamp: '3',
        overflow: 'hidden',
    },
    reasonTextMuted: {
        color: tokens.colorNeutralForeground3,
    },
    candidateRow: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
        minWidth: 0,
    },
    candidateArt: {
        width: '40px',
        height: '40px',
        borderRadius: tokens.borderRadiusMedium,
        objectFit: 'cover',
        backgroundColor: tokens.colorNeutralBackground3,
        flexShrink: 0,
    },
    candidateMeta: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
        minWidth: 0,
        overflow: 'hidden',
    },
    candidateTitle: {
        color: tokens.colorNeutralForeground1,
        fontWeight: tokens.fontWeightSemibold,
        fontSize: tokens.fontSizeBase300,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    candidateSubtitle: {
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase200,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    actionGroup: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalXXS,
        justifyContent: 'flex-end',
        flexWrap: 'nowrap',
    },
    actionButton: {
        ...glassButtonStyles,
    },
    primaryActionButton: {
        ...glassPrimaryButtonStyles,
    },
    actionCell: {
        minWidth: 0,
        overflow: 'hidden',
    },
    destructiveButton: {
        ...glassDangerButtonStyles,
    },
});

function normalizeComparableText(value?: string | null): string {
    return (value || '')
        .toLowerCase()
        .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
        .replace(/[_./\\-]+/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function formatBytes(bytes: number | null | undefined) {
    if (!bytes) return '0 B';
    const base = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.floor(Math.log(bytes) / Math.log(base));
    return `${parseFloat((bytes / Math.pow(base, index)).toFixed(2))} ${sizes[index]}`;
}

function formatDuration(seconds: number | null | undefined) {
    if (!seconds || seconds <= 0) return null;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
    }
    return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function formatBitrate(bitrate: number | null | undefined) {
    if (!bitrate || bitrate <= 0) return null;
    return `${Math.round(bitrate / 1000)} kbps`;
}


function formatSampleRateCompact(sampleRate: number | null | undefined) {
    if (!sampleRate || sampleRate <= 0) return null;
    return `${(sampleRate / 1000).toFixed(sampleRate % 1000 === 0 ? 0 : 1)}KHZ`;
}

function normalizeCodecLabel(codec: string | null | undefined) {
    if (!codec) return null;
    const normalized = codec.trim().toUpperCase();
    if (!normalized) return null;
    if (normalized === 'M4A') return 'AAC';
    return normalized;
}

function normalizeQualityText(value: string) {
    return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

function splitFilePath(input: string) {
    const parts = input.split(/[\\/]+/).filter(Boolean);
    const fileName = parts.pop() || input;
    return {
        fileName,
        directory: parts.join(' / '),
    };
}

function getRelativeDirectory(input: string) {
    const normalized = input.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash >= 0 ? normalized.slice(0, lastSlash) : '';
}

function getReasonList(reason: string | null | undefined) {
    return String(reason || '')
        .split(/;\s+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function formatRejectionReason(reason: string) {
    const normalized = reason.trim().replace(/\s+/g, ' ');
    const lower = normalized.toLowerCase();

    if (lower === 'no matching tidal track found' || lower === 'no matching provider item found') return 'No matching provider item';
    if (lower === 'duplicate of an existing imported library file') return 'Already imported in library';
    if (lower === 'locked file, try again later') return 'File is locked';
    if (lower === 'unable to process file') return 'Unable to process file';
    if (lower.startsWith('album already imported at ')) return 'Album already imported in library';
    if (lower.startsWith('destination artist folder ')) return 'Artist folder is outside a root folder';

    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function getRejectionReasons(file: UnmappedFile) {
    return getReasonList(file.reason).map(formatRejectionReason);
}

function getDecisionState(files: UnmappedFile[], rejectionReasons: string[]): DecisionState {
    if (files.every((file) => file.ignored)) return 'ignored';
    return rejectionReasons.length > 0 ? 'blocked' : 'ready';
}

function mostCommonNonEmpty(values: Array<string | null | undefined>): string | null {
    const counts = new Map<string, number>();
    for (const value of values) {
        const trimmed = value?.trim();
        if (!trimmed) continue;
        counts.set(trimmed, (counts.get(trimmed) || 0) + 1);
    }

    let winner: string | null = null;
    let winnerCount = -1;
    for (const [value, count] of counts.entries()) {
        if (count > winnerCount) {
            winner = value;
            winnerCount = count;
        }
    }

    return winner;
}

function getFileKind(file: UnmappedFile): 'Video' | 'Track' {
    const extension = String(file.extension || '').toLowerCase().replace(/^\./, '');
    return ['mp4', 'm4v', 'mkv', 'mov', 'webm', 'ts'].includes(extension) || String(file.library_root || '').includes('video')
        ? 'Video'
        : 'Track';
}

function buildPrimaryQualityLabel(files: UnmappedFile[]) {
    const firstWithAudioQuality = files.find((file) => file.audio_quality?.trim());
    const codec = normalizeCodecLabel(mostCommonNonEmpty(files.map((file) => file.codec)));
    const bitrate = files.map((file) => Number(file.bitrate || 0)).find((value) => value > 0) || null;
    const sampleRate = files.map((file) => Number(file.sample_rate || 0)).find((value) => value > 0) || null;
    const bitDepth = files.map((file) => Number(file.bit_depth || 0)).find((value) => value > 0) || null;
    const channels = files.map((file) => Number(file.channels || 0)).find((value) => value > 0) || null;
    const qualityText = firstWithAudioQuality?.audio_quality?.trim() || '';
    const normalizedQualityText = qualityText ? normalizeQualityText(qualityText) : '';
    const isSpatial = isSpatialAudioQuality(normalizedQualityText) || (channels !== null && channels > 2) || codec === 'EAC3';

    if (isSpatial) {
        const bitrateLabel = formatBitrate(bitrate);
        const base = [bitrateLabel, codec || 'EAC3'].filter(Boolean).join(' ');
        return base ? `${base} (spatial audio)` : 'SPATIAL AUDIO';
    }

    if (normalizedQualityText && !['LOSSLESS', 'HIRES_LOSSLESS', 'DOLBY_ATMOS', 'HIGH', 'NORMAL', 'LOW'].includes(normalizedQualityText)) {
        return normalizedQualityText;
    }

    if (bitDepth && sampleRate) {
        return [
            `${bitDepth}-BIT`,
            formatSampleRateCompact(sampleRate),
            codec,
        ].filter(Boolean).join(' ');
    }

    if (bitrate || normalizedQualityText === 'HIGH' || normalizedQualityText === 'NORMAL' || normalizedQualityText === 'LOW') {
        const fallbackBitrate = bitrate
            ? formatBitrate(bitrate)
            : normalizedQualityText === 'HIGH'
                ? '320 kbps'
                : normalizedQualityText === 'NORMAL'
                    ? '160 kbps'
                    : '96 kbps';
        return [fallbackBitrate, codec || 'AAC'].filter(Boolean).join(' ');
    }

    if (codec) {
        return codec;
    }

    return normalizedQualityText || 'Unknown quality';
}

function createDisplayRow(files: UnmappedFile[], kind: DisplayRowKind, candidatesMap?: Record<number, any>): DisplayRow {
    const orderedFiles = [...files].sort((left, right) => left.filename.localeCompare(right.filename));
    const anchorFile = orderedFiles[0];
    const { fileName, directory } = splitFilePath(anchorFile.file_path);
    const relativeDirectory = getRelativeDirectory(anchorFile.relative_path || anchorFile.file_path);
    const artistLabel = mostCommonNonEmpty(orderedFiles.map((file) => file.detected_artist)) || 'Unknown artist';
    const albumLabel = mostCommonNonEmpty(orderedFiles.map((file) => file.detected_album)) || 'Unknown album';
    const rejectionReasons = Array.from(new Set(orderedFiles.flatMap((file) => getRejectionReasons(file))));
    const decisionState = getDecisionState(orderedFiles, rejectionReasons);
    const totalSize = orderedFiles.reduce((sum, file) => sum + Number(file.file_size || 0), 0);
    const durationValues = orderedFiles.map((file) => Number(file.duration || 0)).filter((value) => value > 0);
    const totalDuration = durationValues.length > 0 ? durationValues.reduce((sum, value) => sum + value, 0) : null;
    const primaryQuality = buildPrimaryQualityLabel(orderedFiles);
    const countLabel = orderedFiles.length === 1 ? getFileKind(anchorFile) : `${orderedFiles.length} files`;
    const groupTitle = relativeDirectory.split('/').filter(Boolean).pop() || fileName;
    const title = kind === 'group' ? (albumLabel !== 'Unknown album' ? albumLabel : groupTitle) : fileName;
    const subtitle = kind === 'group'
        ? `${artistLabel} • ${groupTitle}`
        : (directory || '/');
    const trackLabel = kind === 'group'
        ? `${orderedFiles.length} tracks in folder review`
        : (anchorFile.detected_track || 'Unknown track');
    const candidate = candidatesMap?.[anchorFile.id];

    return {
        id: kind === 'group'
            ? `group:${anchorFile.library_root}:${relativeDirectory}:${normalizeComparableText(albumLabel)}:${anchorFile.ignored ? 'ignored' : 'active'}`
            : `file:${anchorFile.id}`,
        kind,
        files: orderedFiles,
        anchorFile,
        ignored: orderedFiles.every((file) => file.ignored),
        title,
        subtitle,
        directory,
        relativeDirectory,
        artistLabel,
        albumLabel,
        trackLabel,
        primaryQuality,
        totalSize,
        totalDuration,
        fileKindLabel: countLabel,
        rejectionReasons,
        decisionState,
        candidate,
        sortValues: {
            filename: title.toLowerCase(),
            detected_artist: artistLabel.toLowerCase(),
            detected_album: albumLabel.toLowerCase(),
            detected_track: trackLabel.toLowerCase(),
            audio_quality: primaryQuality.toLowerCase(),
            codec: normalizeCodecLabel(anchorFile.codec)?.toLowerCase() || '',
            file_size: totalSize,
            duration: totalDuration || 0,
            reason: rejectionReasons.join(' ').toLowerCase(),
            candidate: (candidate?.title || '').toLowerCase(),
            created_at: Math.max(...orderedFiles.map((file) => Date.parse(file.created_at || '') || 0), 0),
        },
    };
}

function buildDisplayRows(files: UnmappedFile[], candidatesMap?: Record<number, any>): DisplayRow[] {
    const buckets = new Map<string, UnmappedFile[]>();

    for (const file of files) {
        const key = [file.library_root, getRelativeDirectory(file.relative_path || file.file_path), file.ignored ? 'ignored' : 'active'].join('::');
        const current = buckets.get(key) || [];
        current.push(file);
        buckets.set(key, current);
    }

    const rows: DisplayRow[] = [];

    for (const bucketFiles of buckets.values()) {
        const orderedBucket = [...bucketFiles].sort((left, right) => left.filename.localeCompare(right.filename));
        const albumBuckets = new Map<string, UnmappedFile[]>();

        for (const file of orderedBucket) {
            const albumKey = normalizeComparableText(file.detected_album);
            if (!albumKey) {
                continue;
            }

            const artistKey = normalizeComparableText(file.detected_artist);
            const key = `${albumKey}::${artistKey}`;
            const current = albumBuckets.get(key) || [];
            current.push(file);
            albumBuckets.set(key, current);
        }

        const consumedIds = new Set<number>();
        const groupedCandidates = Array.from(albumBuckets.values())
            .filter((candidateFiles) => {
                if (candidateFiles.length < GROUP_MIN_FILES) {
                    return false;
                }
                return candidateFiles.length / orderedBucket.length >= GROUP_MIN_RATIO;
            })
            .sort((left, right) => right.length - left.length);

        for (const candidateFiles of groupedCandidates) {
            const remainingFiles = candidateFiles.filter((file) => !consumedIds.has(file.id));
            if (remainingFiles.length < GROUP_MIN_FILES) {
                continue;
            }

            remainingFiles.forEach((file) => consumedIds.add(file.id));
            rows.push(createDisplayRow(remainingFiles, 'group', candidatesMap));
        }

        for (const file of orderedBucket) {
            if (consumedIds.has(file.id)) {
                continue;
            }
            rows.push(createDisplayRow([file], 'file', candidatesMap));
        }
    }

    return rows;
}

const ManualImportTab = () => {
    const styles = useStyles();
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const [showIgnored, setShowIgnored] = useState(false);
    const [manualImportFile, setManualImportFile] = useState<UnmappedFile | null>(null);
    const [manualImportCandidate, setManualImportCandidate] = useState<any | null>(null);
    const [sortKey, setSortKey] = useState<SortKey>('created_at');
    const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

    const { data: unmappedData, isLoading } = useQuery<{ files: UnmappedFile[]; candidates: Record<number, any> }>({
        queryKey: ['unmapped-files'],
        queryFn: async () => {
            const allFiles: UnmappedFile[] = [];
            let candidatesMap: Record<number, any> = {};
            let offset = 0;

            while (true) {
                const response: any = await api.getUnmappedFiles({ limit: UNMAPPED_PAGE_SIZE, offset });
                const pageItems: UnmappedFile[] = Array.isArray(response) ? response : (response?.items || []);
                if (response?.candidates) {
                    candidatesMap = { ...candidatesMap, ...response.candidates };
                }
                allFiles.push(...pageItems);

                if (Array.isArray(response) || !response?.hasMore || pageItems.length === 0) {
                    break;
                }

                offset += pageItems.length;
            }

            return { files: allFiles, candidates: candidatesMap };
        },
    });

    // Shared delayed-loading policy: no skeleton flash for sub-second loads.
    const showLoadingSkeleton = useDelayedVisible(isLoading);

    const lastEvent = useGlobalEvents(['file.added', 'file.deleted']);

    useEffect(() => {
        if (lastEvent) {
            queryClient.invalidateQueries({ queryKey: ['unmapped-files'] });
        }
    }, [lastEvent, queryClient]);

    const fileList = Array.isArray(unmappedData?.files) ? unmappedData.files : [];
    const visibleFiles = showIgnored ? fileList : fileList.filter((file) => !file.ignored);

    const displayRows = useMemo(
        () => buildDisplayRows(visibleFiles, unmappedData?.candidates),
        [visibleFiles, unmappedData?.candidates],
    );

    const sortedRows = useMemo(() => {
        const nextRows = [...displayRows];
        nextRows.sort((left, right) => {
            const a = left.sortValues[sortKey];
            const b = right.sortValues[sortKey];
            const order = sortDirection === 'asc' ? 1 : -1;

            if (typeof a === 'number' && typeof b === 'number') {
                return (a - b) * order;
            }

            return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }) * order;
        });
        return nextRows;
    }, [displayRows, sortDirection, sortKey]);

    const rowSelection = useSelectableCollection({
        items: sortedRows,
        getItemId: (row: DisplayRow) => row.id,
    });
    const selectedRows = rowSelection.selectedItems;

    const selectedFiles = useMemo(() => {
        const selectedById = new Map<number, UnmappedFile>();
        for (const row of selectedRows) {
            for (const file of row.files) {
                selectedById.set(file.id, file);
            }
        }
        return Array.from(selectedById.values());
    }, [selectedRows]);

    const actionMutation = useMutation({
        mutationFn: (args: { id: number; action: 'ignore' | 'unignore' | 'delete' }) => api.actionUnmappedFile(args.id, args.action),
        onSuccess: (data: any) => {
            queryClient.invalidateQueries({ queryKey: ['unmapped-files'] });
            rowSelection.clearSelection();
            toast({ title: 'Success', description: data.message });
        },
        onError: (error: any) => {
            toast({ title: 'Action failed', description: error.message, variant: 'destructive' });
        },
    });

    const bulkActionMutation = useMutation({
        mutationFn: (args: { ids: number[]; action: 'ignore' | 'unignore' | 'delete' }) => api.bulkActionUnmappedFiles(args.ids, args.action),
        onSuccess: (data: any) => {
            queryClient.invalidateQueries({ queryKey: ['unmapped-files'] });
            rowSelection.clearSelection();
            toast({ title: 'Success', description: data.message });
        },
        onError: (error: any) => {
            toast({ title: 'Action failed', description: error.message, variant: 'destructive' });
        },
    });

    const selectedFileIds = useMemo(() => selectedFiles.map((file) => file.id), [selectedFiles]);
    const selectedIgnoredCount = selectedFiles.filter((file) => file.ignored).length;
    const selectedActiveCount = selectedFiles.length - selectedIgnoredCount;
    const pendingCount = fileList.filter((file) => !file.ignored).length;
    const ignoredCount = fileList.filter((file) => file.ignored).length;
    const mutationPending = actionMutation.isPending || bulkActionMutation.isPending;

    const toggleSort = useCallback((key: SortKey) => {
        if (sortKey === key) {
            setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
            return;
        }

        setSortKey(key);
        setSortDirection(key === 'file_size' || key === 'duration' || key === 'created_at' ? 'desc' : 'asc');
    }, [sortKey]);

    const getSortLabel = useCallback((key: SortKey, label: string) => {
        if (sortKey !== key) return label;
        return `${label} ${sortDirection === 'asc' ? '↑' : '↓'}`;
    }, [sortDirection, sortKey]);

    // Fluent confirmation dialog state for the destructive disk delete; a
    // single-file row deletes through the single-item mutation, everything
    // else routes through the bulk mutation.
    const [pendingDelete, setPendingDelete] = useState<{ single?: number; ids?: number[] } | null>(null);
    const pendingDeleteCount = pendingDelete ? (pendingDelete.single !== undefined ? 1 : pendingDelete.ids?.length ?? 0) : 0;

    const confirmPendingDelete = useCallback(() => {
        if (!pendingDelete) return;
        if (pendingDelete.single !== undefined) {
            actionMutation.mutate({ id: pendingDelete.single, action: 'delete' });
        } else if (pendingDelete.ids?.length) {
            bulkActionMutation.mutate({ ids: pendingDelete.ids, action: 'delete' });
        }
        setPendingDelete(null);
    }, [actionMutation, bulkActionMutation, pendingDelete]);

    const runBulkAction = useCallback((ids: number[], action: 'ignore' | 'unignore' | 'delete') => {
        if (ids.length === 0) {
            return;
        }
        if (action === 'delete') {
            setPendingDelete({ ids });
            return;
        }
        bulkActionMutation.mutate({ ids, action });
    }, [bulkActionMutation]);

    const runRowAction = useCallback((row: DisplayRow, action: 'ignore' | 'unignore' | 'delete') => {
        if (row.files.length === 1) {
            if (action === 'delete') {
                setPendingDelete({ single: row.anchorFile.id });
                return;
            }
            actionMutation.mutate({ id: row.anchorFile.id, action });
            return;
        }

        runBulkAction(row.files.map((file) => file.id), action);
    }, [actionMutation, runBulkAction]);

    const getKindBadgeLabel = useCallback((row: DisplayRow) => {
        if (row.kind === 'group') {
            return 'Album Group';
        }

        return getFileKind(row.anchorFile);
    }, []);

    const getKindBadgeKind = useCallback((row: DisplayRow) => {
        if (row.kind === 'group') {
            return 'album-group' as const;
        }

        return getFileKind(row.anchorFile) === 'Video' ? 'video' as const : 'track' as const;
    }, []);

    const getReasonText = useCallback((row: DisplayRow) => {
        if (row.decisionState === 'ignored') {
            return 'Ignored until restored.';
        }

        if (row.rejectionReasons.length > 0) {
            return row.rejectionReasons.join(' • ');
        }

        return row.kind === 'group'
            ? 'Ready for grouped manual import review.'
            : 'Ready for manual import review.';
    }, []);

    const renderActionButtons = useCallback((row: DisplayRow) => (
        <div className={styles.actionGroup}>
            <Button
                appearance="subtle"
                size="small"
                icon={<Search24 />}
                title={row.kind === 'group' ? 'Review grouped files' : 'Search mapping'}
                aria-label={`Review ${row.title}`}
                className={styles.actionButton}
                disabled={row.ignored || mutationPending}
                onClick={(event) => {
                    event.stopPropagation();
                    setManualImportFile(row.anchorFile);
                }}
            />
            {row.ignored ? (
                <Button
                    appearance="subtle"
                    size="small"
                    icon={<Eye24 />}
                    title="Restore file"
                    aria-label={`Restore ${row.title}`}
                    className={styles.actionButton}
                    disabled={mutationPending}
                    onClick={(event) => {
                        event.stopPropagation();
                        runRowAction(row, 'unignore');
                    }}
                />
            ) : (
                <Button
                    appearance="subtle"
                    size="small"
                    icon={<EyeOff24 />}
                    title="Ignore file"
                    aria-label={`Ignore ${row.title}`}
                    className={styles.actionButton}
                    disabled={mutationPending}
                    onClick={(event) => {
                        event.stopPropagation();
                        runRowAction(row, 'ignore');
                    }}
                />
            )}
            <Button
                appearance="subtle"
                size="small"
                icon={<Delete24 />}
                title="Delete file"
                aria-label={`Delete ${row.title}`}
                className={styles.destructiveButton}
                disabled={mutationPending}
                onClick={(event) => {
                    event.stopPropagation();
                    runRowAction(row, 'delete');
                }}
            />
        </div>
    ), [mutationPending, runRowAction, styles.actionButton, styles.actionGroup, styles.destructiveButton]);

    const columns = useMemo<DataGridColumn<DisplayRow>[]>(() => [
        {
            key: 'file',
            header: (
                <button type="button" className={styles.sortableHeaderButton} onClick={() => toggleSort('filename')}>
                    {getSortLabel('filename', 'Filename / Path')}
                </button>
            ),
            width: 'minmax(140px, 1.15fr)',
            minWidth: 120,
            wrap: true,
            className: styles.wrappingCell,
            render: (row) => (
                <div className={styles.titleStack}>
                    <div className={styles.titleRow}>
                        <Text className={styles.fileTitle}>{row.title}</Text>
                    </div>
                    <Text className={styles.subtitle} title={row.subtitle}>{row.subtitle}</Text>
                    <div className={styles.tagRow}>
                        <MediaTypeBadge kind={getKindBadgeKind(row)} label={getKindBadgeLabel(row)} size="small" />
                        {row.ignored ? <Badge appearance="filled" size="small">Ignored</Badge> : null}
                    </div>
                </div>
            ),
        },
        {
            key: 'identified',
            header: (
                <button type="button" className={styles.sortableHeaderButton} onClick={() => toggleSort('detected_artist')}>
                    {getSortLabel('detected_artist', 'Identified')}
                </button>
            ),
            width: 'minmax(140px, 1fr)',
            minWidth: 120,
            hideBelowWidth: 900,
            wrap: true,
            className: styles.wrappingCell,
            render: (row) => (
                <div className={styles.identifiedInfo}>
                    <div className={styles.identifiedLine}>
                        <Text className={styles.identifiedLabel}>Artist</Text>
                        <Text className={styles.identifiedValue} title={row.artistLabel}>{row.artistLabel}</Text>
                    </div>
                    <div className={styles.identifiedLine}>
                        <Text className={styles.identifiedLabel}>Album</Text>
                        <Text className={styles.identifiedValue} title={row.albumLabel}>{row.albumLabel}</Text>
                    </div>
                    <div className={styles.identifiedLine}>
                        <Text className={styles.identifiedLabel}>Track</Text>
                        <Text className={styles.identifiedValue} title={row.trackLabel}>{row.trackLabel}</Text>
                    </div>
                </div>
            ),
        },
        {
            key: 'quality',
            header: (
                <button type="button" className={styles.sortableHeaderButton} onClick={() => toggleSort('audio_quality')}>
                    {getSortLabel('audio_quality', 'Properties')}
                </button>
            ),
            // Fit common quality strings like "24-BIT 44.1KHZ FLAC" without truncation.
            width: 'minmax(188px, max-content)',
            minWidth: 168,
            hideBelowWidth: 1100,
            wrap: true,
            className: styles.wrappingCell,
            render: (row) => (
                <div className={styles.qualityInfo}>
                    <div className={styles.qualityLine}>
                        <Text className={styles.qualityLabel}>Quality</Text>
                        <Text className={styles.qualityValue} title={row.primaryQuality}>{row.primaryQuality}</Text>
                    </div>
                    <div className={styles.qualityLine}>
                        <Text className={styles.qualityLabel}>Size</Text>
                        <Text className={styles.qualityValue}>{formatBytes(row.totalSize)}</Text>
                    </div>
                    <div className={styles.qualityLine}>
                        <Text className={styles.qualityLabel}>Duration</Text>
                        <Text className={styles.qualityValue}>{formatDuration(row.totalDuration) || '—'}</Text>
                    </div>
                </div>
            ),
        },
        {
            key: 'candidate',
            header: (
                <button type="button" className={styles.sortableHeaderButton} onClick={() => toggleSort('candidate')}>
                    {getSortLabel('candidate', '#1 Candidate Guess')}
                </button>
            ),
            width: 'minmax(180px, 1.2fr)',
            minWidth: 160,
            hideBelowWidth: 700,
            wrap: true,
            className: styles.wrappingCell,
            render: (row) => {
                const candidate = row.candidate;
                const title = candidate?.title || (row.albumLabel !== 'Unknown album' ? row.albumLabel : null);
                const artist = candidate?.artistName || (row.artistLabel !== 'Unknown artist' ? row.artistLabel : null);

                if (!title && !artist) {
                    return <Text className={styles.reasonTextMuted}>No candidate match</Text>;
                }

                const coverSrc = candidate?.cover
                    ? (mediaCoverProxySrc({ cover_art_url: candidate.cover }, 250) || renderableArtworkUrl(candidate.cover))
                    : null;

                return (
                    <div
                        className={styles.candidateRow}
                        style={{ cursor: 'pointer', paddingLeft: tokens.spacingHorizontalL }}
                        title="Click to open manual import for this candidate"
                        onClick={(e) => {
                            e.stopPropagation();
                            setManualImportCandidate(candidate || null);
                            setManualImportFile(row.anchorFile);
                        }}
                    >
                        {coverSrc ? (
                            <img
                                src={coverSrc}
                                alt=""
                                className={styles.candidateArt}
                                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                            />
                        ) : (
                            <div className={styles.candidateArt} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <Record24Regular style={{ color: tokens.colorNeutralForeground4 }} />
                            </div>
                        )}
                        <div className={styles.candidateMeta}>
                            <Text className={styles.candidateTitle} title={title || 'Catalog Guess'}>{title || 'Catalog Guess'}</Text>
                            {artist ? <Text className={styles.candidateSubtitle} title={artist}>{artist}</Text> : null}
                        </div>
                    </div>
                );
            },
        },
        {
            key: 'actions',
            header: 'Actions',
            width: '88px',
            minWidth: 88,
            align: 'right',
            className: mergeClasses(styles.wrappingCell, styles.actionCell),
            render: (row) => renderActionButtons(row),
        },
    ], [
        getKindBadgeKind,
        getKindBadgeLabel,
        getReasonText,
        getSortLabel,
        renderActionButtons,
        styles.actionCell,
        styles.fileTitle,
        styles.identifiedInfo,
        styles.identifiedLabel,
        styles.identifiedLine,
        styles.identifiedValue,
        styles.qualityInfo,
        styles.qualityLabel,
        styles.qualityLine,
        styles.qualityValue,
        styles.reasonText,
        styles.reasonTextMuted,
        styles.sortableHeaderButton,
        styles.subtitle,
        styles.tagRow,
        styles.titleRow,
        styles.titleStack,
        styles.wrappingCell,
        toggleSort,
    ]);

    if (isLoading) {
        if (!showLoadingSkeleton) {
            return <div className={styles.emptyState} />;
        }
        return (
            <div className={styles.emptyState}>
                <DataGridSkeleton
                  rows={8}
                  columns={5}
                  columnTemplate="minmax(140px, 1.2fr) minmax(120px, 0.9fr) minmax(100px, 0.55fr) minmax(120px, 0.75fr) 88px"
                  compact
                  actionColumns={[4]}
                />
            </div>
        );
    }

    return (
        <div className={styles.container}>
            {sortedRows.length === 0 ? (
                <EmptyState
                    className={styles.emptyState}
                    title="No unmapped files found"
                    description={fileList.length === 0
                        ? 'There are no files waiting for review in your library folders.'
                        : 'No active unmapped files match this view. Show ignored files to review the remaining items.'}
                    icon={<DocumentSearch24 />}
                />
            ) : (
                <>
                    <div className={styles.toolbar}>
                        <div className={styles.toolbarMeta}>
                            <Text className={styles.toolbarSummary}>
                                {pendingCount} file{pendingCount === 1 ? '' : 's'} awaiting review
                                {ignoredCount > 0 ? ` • ${ignoredCount} ignored` : ''}
                            </Text>
                            <Text className={styles.toolbarHint}>
                                Review files here, then open Manual Import to confirm the correct release and track mapping.
                            </Text>
                        </div>
                        <div className={styles.toolbarActions}>
                            <Button
                                appearance={showIgnored ? 'primary' : 'outline'}
                                size="small"
                                className={showIgnored ? styles.primaryActionButton : styles.actionButton}
                                onClick={() => setShowIgnored((current) => !current)}
                            >
                                {showIgnored ? 'Hide Ignored' : `Show Ignored (${ignoredCount})`}
                            </Button>
                            {selectedFileIds.length > 0 ? (
                                <Badge appearance="filled" size="large" className={styles.bulkBadge}>
                                    {selectedFileIds.length} selected
                                </Badge>
                            ) : null}
                            <div className={styles.bulkActionRow}>
                                {selectedActiveCount > 0 ? (
                                    <Button
                                        appearance="subtle"
                                        size="small"
                                        icon={<EyeOff24 />}
                                        className={styles.actionButton}
                                        disabled={mutationPending}
                                        onClick={() => runBulkAction(selectedFileIds.filter((id) => selectedFiles.some((file) => file.id === id && !file.ignored)), 'ignore')}
                                    >
                                        Ignore Selected
                                    </Button>
                                ) : null}
                                {selectedIgnoredCount > 0 ? (
                                    <Button
                                        appearance="subtle"
                                        size="small"
                                        icon={<Eye24 />}
                                        className={styles.actionButton}
                                        disabled={mutationPending}
                                        onClick={() => runBulkAction(selectedFileIds.filter((id) => selectedFiles.some((file) => file.id === id && file.ignored)), 'unignore')}
                                    >
                                        Restore Selected
                                    </Button>
                                ) : null}
                                {selectedFileIds.length > 0 ? (
                                    <Button
                                        appearance="subtle"
                                        size="small"
                                        icon={<Delete24 />}
                                        className={styles.destructiveButton}
                                        disabled={mutationPending}
                                        onClick={() => runBulkAction(selectedFileIds, 'delete')}
                                    >
                                        Delete Selected
                                    </Button>
                                ) : null}
                            </div>
                        </div>
                    </div>

                    <div className={styles.tableShell}>
                        <DataGrid
                            columns={columns}
                            items={sortedRows}
                            className={styles.tableGrid}
                            resizableColumns
                            columnResizeStorageKey="discogenius-unmapped-files-column-widths-v3"
                            getRowKey={(row) => row.id}
                            getRowClassName={(row) => row.ignored ? styles.rowIgnored : undefined}
                            selection={{
                                ...rowSelection.selection,
                                getSelectionLabel: (row) => `Select ${row.title}`,
                            }}
                        />
                    </div>
                </>
            )}

            <ManualImportModal
                isOpen={!!manualImportFile}
                onClose={() => {
                    setManualImportFile(null);
                    setManualImportCandidate(null);
                }}
                initialFile={manualImportFile}
                initialMatch={manualImportCandidate}
                allFiles={fileList}
            />

            <Dialog open={pendingDelete !== null} onOpenChange={(_, data) => { if (!data.open) setPendingDelete(null); }}>
                <DialogSurface>
                    <DialogBody>
                        <DialogTitle>Delete {pendingDeleteCount === 1 ? 'file' : `${pendingDeleteCount} files`} from disk?</DialogTitle>
                        <DialogContent>
                            This permanently removes the {pendingDeleteCount === 1 ? 'file' : 'files'} from the
                            library folder. This cannot be undone.
                        </DialogContent>
                        <DialogActions>
                            <Button appearance="secondary" onClick={() => setPendingDelete(null)}>Cancel</Button>
                            <Button
                                appearance="primary"
                                className={styles.destructiveButton}
                                icon={<Delete24 />}
                                disabled={mutationPending}
                                onClick={confirmPendingDelete}
                            >
                                Delete
                            </Button>
                        </DialogActions>
                    </DialogBody>
                </DialogSurface>
            </Dialog>
        </div>
    );
};

export default ManualImportTab;
