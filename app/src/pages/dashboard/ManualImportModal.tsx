import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Select,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  tokens,
  } from '@fluentui/react-components';
import {
  ArrowImport24Regular,
  Search24Regular,
  Search24Filled,
  bundleIcon,
  ArrowImport24Filled
} from "@fluentui/react-icons";
import { useMutation, useQueryClient } from '@tanstack/react-query';
import MediaCard from '@/components/cards/MediaCard';
import { glassButtonStyles } from '@/components/ui/glassButtonStyles';
import { useToast } from '@/hooks/useToast';
import { api } from '@/services/api';
import { dispatchActivityRefresh } from '@/utils/appEvents';
import { mediaCoverProxySrc, mediaCoverSrc, renderableArtworkUrl } from '@/utils/artwork';
import { formatTrackPositionPrefix, isMultiVolumeTrackList } from '@/utils/trackPosition';
import { type UnmappedFile } from './ManualImportTab';

const ArrowImport24 = bundleIcon(ArrowImport24Filled, ArrowImport24Regular);

const Search24 = bundleIcon(Search24Filled, Search24Regular);

const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mkv', 'mov', 'webm', 'ts']);

const useStyles = makeStyles({
    dialogSurface: {
        maxWidth: '1000px',
        width: '95vw',
        height: '85vh',
        display: 'flex',
        flexDirection: 'column',
        '@media (max-width: 639px)': {
            width: '100vw',
            maxWidth: '100vw',
            height: '100vh',
            borderRadius: tokens.borderRadiusNone,
        },
    },
    dialogBody: {
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        overflow: 'hidden',
    },
    dialogContent: {
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        overflowY: 'auto',
        gap: tokens.spacingVerticalL,
        paddingBottom: tokens.spacingVerticalL,
    },
    dialogActions: {
        borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        paddingTop: tokens.spacingVerticalM,
        '@media (max-width: 639px)': {
            display: 'grid',
            gridTemplateColumns: '1fr',
            gap: tokens.spacingVerticalS,
        },
    },
    searchContainer: {
        display: 'flex',
        gap: tokens.spacingHorizontalS,
        alignItems: 'center',
        '@media (max-width: 639px)': {
            flexDirection: 'column',
            alignItems: 'stretch',
        },
    },
    searchInput: {
        flex: 1,
    },
    searchButton: {
        ...glassButtonStyles,
        '@media (max-width: 639px)': {
            width: '100%',
            justifyContent: 'center',
        },
    },
    resultsGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(156px, 1fr))',
        gap: tokens.spacingHorizontalM,
        marginTop: tokens.spacingVerticalM,
        '@media (max-width: 639px)': {
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: tokens.spacingHorizontalS,
        },
    },
    mappingHeader: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground2} 78%, transparent)`,
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        padding: tokens.spacingHorizontalL,
        borderRadius: tokens.borderRadiusMedium,
        marginBottom: tokens.spacingVerticalM,
        gap: tokens.spacingHorizontalM,
        '@media (max-width: 639px)': {
            flexDirection: 'column',
            alignItems: 'stretch',
            padding: tokens.spacingHorizontalM,
        },
    },
    mappingHeaderInfo: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalM,
    },
    mappingHeaderText: {
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
    },
    mappingHeaderArt: {
        width: '48px',
        height: '48px',
        borderRadius: tokens.borderRadiusSmall,
        objectFit: 'cover',
    },
    tableContainer: {
        flex: 1,
        overflowY: 'auto',
        overflowX: 'auto',
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        borderRadius: tokens.borderRadiusMedium,
        backgroundColor: tokens.colorNeutralBackground1,
        boxShadow: tokens.shadow4,
    },
    mappingTable: {
        minWidth: '600px',
    },
    filename: {
        wordBreak: 'break-all',
        fontFamily: 'monospace',
        fontSize: tokens.fontSizeBase200,
    },
    emptyState: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: tokens.spacingVerticalXXXL,
        color: tokens.colorNeutralForeground3,
        textAlign: 'center',
        gap: tokens.spacingVerticalM,
    },
    mappingSelect: {
        width: '100%',
        minWidth: '220px',
    },
    localFilePanel: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalS,
        padding: tokens.spacingHorizontalL,
        borderRadius: tokens.borderRadiusMedium,
        backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 72%, transparent)`,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    },
    localFileMeta: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalXS,
    },
    secondaryText: {
        color: tokens.colorNeutralForeground3,
    },
});


interface Props {
    isOpen: boolean;
    onClose: () => void;
    initialFile: UnmappedFile | null;
    initialMatch?: any;
    allFiles: UnmappedFile[];
}

const getDirname = (inputPath: string) => {
    const lastSlash = Math.max(inputPath.lastIndexOf('/'), inputPath.lastIndexOf('\\'));
    return lastSlash > -1 ? inputPath.substring(0, lastSlash) : '';
};

const formatBytes = (bytes: number) => {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const formatDuration = (seconds?: number | null) => {
    if (!seconds || seconds <= 0) return null;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${minutes}:${String(remainder).padStart(2, '0')}`;
};

const isVideoCandidate = (file: UnmappedFile | null) => {
    if (!file) return false;
    return file.library_root.includes('video') || VIDEO_EXTENSIONS.has(file.extension.toLowerCase());
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const cleanSearchString = (str?: string | null) => {
    if (!str) return '';
    return str
        .replace(/[(|[{].*?[)|\]}]/g, ' ')
        .replace(/[_./\\-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
};

const buildInitialSearchQuery = (file: UnmappedFile, isVideoImport: boolean) => {
    if (!isVideoImport) {
        const cleanAlbum = cleanSearchString(file.detected_album);
        if (cleanAlbum) {
            return cleanAlbum;
        }
        const cleanArtist = cleanSearchString(file.detected_artist);
        return cleanArtist || cleanSearchString(file.filename);
    }

    const baseName = file.filename.replace(/\.[^/.]+$/, '');
    const strippedTitle = file.detected_artist
        ? baseName.replace(new RegExp(`^${escapeRegExp(file.detected_artist)}\\s*-\\s*`, 'i'), '').trim()
        : baseName;
    const title = file.detected_track || strippedTitle;
    return [cleanSearchString(file.detected_artist), cleanSearchString(title)].filter(Boolean).join(' ').trim();
};

const getResultId = (result: any) => String(result.id || '');
const getResultTitle = (result: any) => result.name || result.title || 'Unknown Release';

const getResultSubtitle = (result: any) =>
    result.subtitle || result.artist_name || result.artistName || result.artist?.name || result.artists?.[0]?.name || 'Unknown Artist';

const getResultImage = (result: any, preferVideoProxy = false) =>
    (preferVideoProxy ? mediaCoverProxySrc(result) : mediaCoverSrc(result))
    ?? renderableArtworkUrl(result.image_id)
    ?? null;

interface ManualImportLibrary {
    id: number;
    name: string;
    rootPath: string;
    qualityProfile: string;
}

const ManualImportModal: React.FC<Props> = ({ isOpen, onClose, initialFile, initialMatch, allFiles }) => {
    const styles = useStyles();
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const initializedFileIdRef = useRef<number | null>(null);

    const isVideoImport = useMemo(() => isVideoCandidate(initialFile), [initialFile]);

    const targetFiles = useMemo(() => {
        if (!initialFile) return [];

        if (isVideoImport) {
            return initialFile.ignored ? [] : [initialFile];
        }

        const targetDir = getDirname(initialFile.relative_path);
        return allFiles
            .filter(
                (file) =>
                    !file.ignored &&
                    file.library_root === initialFile.library_root &&
                    getDirname(file.relative_path) === targetDir
            )
            .sort((left, right) => left.filename.localeCompare(right.filename));
    }, [allFiles, initialFile, isVideoImport]);

    const [searchQuery, setSearchQuery] = useState('');
    const [isSearching, setIsSearching] = useState(false);
    const [searchResults, setSearchResults] = useState<any[]>([]);
    const [hasSearched, setHasSearched] = useState(false);
    const [selectedMatch, setSelectedMatch] = useState<any | null>(null);
    const [albumTracks, setAlbumTracks] = useState<any[]>([]);
    const [releaseVersions, setReleaseVersions] = useState<any[]>([]);
    const [selectedReleaseMbid, setSelectedReleaseMbid] = useState<string>('');
    const [selectedReleaseId, setSelectedReleaseId] = useState<number | null>(null);
    const [libraries, setLibraries] = useState<ManualImportLibrary[]>([]);
    const [selectedLibraryId, setSelectedLibraryId] = useState<number | null>(null);
    const [isLoadingTracks, setIsLoadingTracks] = useState(false);
    const [selectedFiles, setSelectedFiles] = useState<Record<number, boolean>>({});
    const [mappedTracks, setMappedTracks] = useState<Record<number, string>>({});
    const [decisionRejections, setDecisionRejections] = useState<string[]>([]);

    const handleSelectMatch = async (result: any, releaseMbidOverride?: string) => {
        setSelectedMatch(result);

        if (isVideoImport) {
            if (!initialFile) return;
            setMappedTracks({ [initialFile.id]: getResultId(result) });
            setDecisionRejections([]);
            return;
        }

        setIsLoadingTracks(true);
        setMappedTracks({});
        setAlbumTracks([]);
        setSelectedReleaseId(null);

        try {
            const albumId = getResultId(result);
            let versions = releaseVersions;

            if (!isVideoImport && albumId) {
                try {
                    const loadedVersions = await api.request(`/v1/album/${albumId}/versions`) as any[];
                    if (Array.isArray(loadedVersions)) {
                        versions = loadedVersions;
                        setReleaseVersions(loadedVersions);
                    }
                } catch {
                    // Ignore versions load failure
                }
            }

            // Never fall back to `selectedReleaseMbid`. Selecting a match is
            // either an explicit version switch (which passes the override) or a
            // *new* album, and the reset effect's setState has not applied yet
            // when it calls this in the same tick — so reading state here handed
            // the new album the previous one's release, and the mapper showed
            // Pt. 2's tracklist while the header said Pt. 1.
            const activeReleaseMbid = releaseMbidOverride
                || String(versions[0]?.mbid || versions[0]?.id || '');
            if (!activeReleaseMbid) {
                throw new Error('Choose a canonical MusicBrainz release before mapping files.');
            }
            setSelectedReleaseMbid(activeReleaseMbid);
            const canonicalRelease = await api.getCanonicalManualImportRelease(activeReleaseMbid) as any;
            setSelectedReleaseId(Number(canonicalRelease.id));
            const tracks = (Array.isArray(canonicalRelease.tracks) ? canonicalRelease.tracks : []).map((track: any) => ({
                ...track,
                providerId: track.mbid,
                trackNumber: track.position,
                rawTrackNumber: track.position,
                volumeNumber: track.mediumPosition,
                duration: track.durationMs == null ? 0 : Math.round(Number(track.durationMs) / 1000),
            }));
            setAlbumTracks(tracks);

            if (targetFiles.length === 0 || tracks.length === 0) {
                setMappedTracks({});
                return;
            }

            const response = await api.identifyUnmappedFiles(
                targetFiles.map((file) => file.id),
                activeReleaseMbid
            ) as any;

            const idByMbid = new Map<string, string>(
                tracks.map((track: any) => [String(track.mbid), String(track.id)] as [string, string]),
            );
            const canonicalMappings: Record<number, string> = {};
            for (const [fileId, trackMbid] of Object.entries(
                response?.success && response.mappedTracks ? response.mappedTracks : {},
            )) {
                const trackId = idByMbid.get(String(trackMbid));
                if (trackId) canonicalMappings[Number(fileId)] = trackId;
            }
            setMappedTracks(canonicalMappings);
            setDecisionRejections(Array.isArray(response?.rejections) ? response.rejections : []);
        } catch (error: any) {
            toast({ title: 'Failed to fetch or map tracks', description: error.message, variant: 'destructive' });
        } finally {
            setIsLoadingTracks(false);
        }
    };

    const handleSelectReleaseVersion = (releaseMbid: string) => {
        setSelectedReleaseMbid(releaseMbid);
        if (selectedMatch) {
            void handleSelectMatch(selectedMatch, releaseMbid);
        }
    };

    useEffect(() => {
        if (!isOpen || !initialFile) {
            initializedFileIdRef.current = null;
            return;
        }

        if (initializedFileIdRef.current === initialFile.id) {
            return;
        }

        initializedFileIdRef.current = initialFile.id;

        const nextQuery = buildInitialSearchQuery(initialFile, isVideoImport);
        const initialSelected: Record<number, boolean> = {};
        targetFiles.forEach((file) => {
            initialSelected[file.id] = true;
        });

        setSearchQuery(nextQuery);
        setSearchResults([]);
        setSelectedMatch(null);
        setAlbumTracks([]);
        setReleaseVersions([]);
        setSelectedReleaseMbid('');
        setSelectedReleaseId(null);
        setHasSearched(false);
        setMappedTracks({});
        setDecisionRejections([]);
        setSelectedFiles(initialSelected);

        if (initialMatch) {
            void handleSelectMatch(initialMatch);
            return;
        }

        if (!nextQuery) {
            return;
        }

        setIsSearching(true);
        const searchTypes = isVideoImport ? ['videos'] : ['albums'];
        const searchOptions = !isVideoImport && initialFile?.detected_artist
            ? { artist: cleanSearchString(initialFile.detected_artist) }
            : undefined;
                api.search(nextQuery, searchTypes, 10, undefined, searchOptions)
            .then((response: any) => {
                const nextResults = isVideoImport
                    ? response?.results?.videos || []
                    : response?.results?.albums || [];
                setSearchResults(nextResults);
                setHasSearched(true);
            })
            .catch(() => {
                setHasSearched(true);
            })
            .finally(() => setIsSearching(false));
    }, [initialFile, initialMatch, isOpen, isVideoImport, targetFiles]);

    useEffect(() => {
        if (!isOpen) return;
        api.getManualImportLibraries()
            .then((result: any) => {
                const nextLibraries = Array.isArray(result) ? result : [];
                setLibraries(nextLibraries);
                setSelectedLibraryId((current) => current ?? (Number(nextLibraries[0]?.id || 0) || null));
            })
            .catch((error: Error) => {
                toast({ title: 'Libraries unavailable', description: error.message, variant: 'destructive' });
            });
    }, [isOpen, toast]);

    const handleSearch = async (queryToSearch: string = searchQuery) => {
        if (!queryToSearch.trim()) return;

        setIsSearching(true);
        setHasSearched(true);

        try {
            const searchTypes = isVideoImport ? ['videos'] : ['artists', 'albums', 'tracks'];
            const searchOptions = !isVideoImport && initialFile?.detected_artist
                ? { artist: cleanSearchString(initialFile.detected_artist) }
                : undefined;
            const response = await api.search(queryToSearch, searchTypes, 20, undefined, searchOptions) as any;
            setSearchResults(isVideoImport ? response?.results?.videos || [] : response?.results?.albums || []);
        } catch (error: any) {
            toast({ title: 'Search failed', description: error.message, variant: 'destructive' });
        } finally {
            setIsSearching(false);
        }
    };

    const importMutation = useMutation({
        mutationFn: async (payload: {
            canonicalVideo?: {
                libraryId: number;
                mappings: Array<{ unmappedFileId: number; recordingId: number }>;
            };
            canonical?: {
                libraryId: number;
                editionId: number;
                mappings: Array<{ unmappedFileId: number; trackId: number }>;
            };
        }) => payload.canonical
            ? api.canonicalManualImport(payload.canonical)
            : api.canonicalManualVideoImport(payload.canonicalVideo!),
        onSuccess: (data: any) => {
            queryClient.invalidateQueries({ queryKey: ['unmapped-files'] });
            dispatchActivityRefresh();
            toast({ title: 'Import Queued', description: data?.message || 'Queued manual import for selected files.' });
            onClose();
        },
        onError: (error: any) => {
            toast({ title: 'Import Flow Failed', description: error.message, variant: 'destructive' });
        },
    });

    const handleImport = () => {
        const payloadItems = targetFiles
            .filter((file) => selectedFiles[file.id] && mappedTracks[file.id])
            .map((file) => ({
                id: file.id,
                canonicalId: mappedTracks[file.id],
            }));

        if (payloadItems.length === 0) {
            toast({
                title: 'No Files Chosen',
                description: isVideoImport
                    ? 'Select a matching canonical MusicBrainz video Recording for this file.'
                    : 'Select at least one file and assign a canonical track to it.',
                variant: 'destructive',
            });
            return;
        }

        if (isVideoImport) {
            if (!selectedLibraryId) {
                toast({
                    title: 'Choose Library',
                    description: 'Canonical video import requires an explicit destination library.',
                    variant: 'destructive',
                });
                return;
            }
            importMutation.mutate({
                canonicalVideo: {
                    libraryId: selectedLibraryId,
                    mappings: payloadItems.map((item) => ({
                        unmappedFileId: item.id,
                        recordingId: Number(item.canonicalId),
                    })),
                },
            });
            return;
        }
        if (!selectedLibraryId || !selectedReleaseId) {
            toast({
                title: 'Choose Library and Release',
                description: 'Canonical audio import requires an explicit destination library and release.',
                variant: 'destructive',
            });
            return;
        }
        importMutation.mutate({
            canonical: {
                libraryId: selectedLibraryId,
                editionId: selectedReleaseId,
                mappings: payloadItems.map((item) => ({
                    unmappedFileId: item.id,
                    trackId: Number(item.canonicalId),
                })),
            },
        });
    };

    const albumIsMultiVolume = useMemo(
        () => isMultiVolumeTrackList(albumTracks),
        [albumTracks],
    );
    const allSelected = targetFiles.length > 0 && targetFiles.every((file) => selectedFiles[file.id]);
    const someSelected = targetFiles.some((file) => selectedFiles[file.id]);
    const canImport = targetFiles.some((file) => selectedFiles[file.id] && mappedTracks[file.id]) && !importMutation.isPending;
    const localFile = targetFiles[0] || initialFile;

    return (
        <Dialog open={isOpen} onOpenChange={(_, data) => !data.open && onClose()}>
            <DialogSurface className={styles.dialogSurface}>
                <DialogBody className={styles.dialogBody}>
                    <DialogTitle>Manual Import</DialogTitle>
                    <DialogContent className={styles.dialogContent}>
                        {!selectedMatch && (
                            <>
                                <Text style={{ display: 'block' }}>
                                    {isVideoImport
                                        ? <>Match this local video to a canonical MusicBrainz Recording.</>
                                        : <>Found <strong>{targetFiles.length}</strong> files ready for manual import in <Badge appearance="outline">{initialFile ? getDirname(initialFile.relative_path) : ''}</Badge></>}
                                </Text>

                                <div className={styles.searchContainer}>
                                    <Input
                                        className={styles.searchInput}
                                        placeholder={isVideoImport ? 'Search for the correct canonical video...' : 'Search for the correct canonical release...'}
                                        value={searchQuery}
                                        onChange={(_, data) => setSearchQuery(data.value)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter') {
                                                event.preventDefault();
                                                void handleSearch();
                                            }
                                        }}
                                        size="large"
                                    />
                                    <Button
                                        className={styles.searchButton}
                                        size="large"
                                        appearance="primary"
                                        icon={<Search24 />}
                                        disabled={isSearching}
                                        onClick={() => void handleSearch()}
                                    >
                                        Search
                                    </Button>
                                </div>

                                {isVideoImport && localFile && (
                                    <div className={styles.localFilePanel}>
                                        <Text weight="semibold">{localFile.filename}</Text>
                                        <div className={styles.localFileMeta}>
                                            <Badge appearance="filled">{formatBytes(localFile.file_size ?? 0)}</Badge>
                                            {formatDuration(localFile.duration) ? <Badge appearance="outline">{formatDuration(localFile.duration)}</Badge> : null}
                                            {localFile.audio_quality ? <Badge appearance="outline">{localFile.audio_quality}</Badge> : null}
                                        </div>
                                        <Text className={styles.secondaryText}>
                                            {[localFile.detected_artist, localFile.detected_track || localFile.detected_album].filter(Boolean).join(' • ') || 'No embedded tags found'}
                                        </Text>
                                        {localFile.reason ? (
                                            <Text size={200} className={styles.secondaryText}>{localFile.reason}</Text>
                                        ) : null}
                                    </div>
                                )}

                                {isSearching ? (
                                    <div className={styles.emptyState}>
                                        <Spinner size="large" />
                                        <Text>Searching canonical catalog...</Text>
                                    </div>
                                ) : hasSearched && searchResults.length === 0 ? (
                                    <div className={styles.emptyState}>
                                        <Search24 style={{ fontSize: '48px', color: tokens.colorNeutralForeground4 }} />
                                        <Text size={400}>
                                            No {isVideoImport ? 'videos' : 'albums'} found matching "{searchQuery}"
                                        </Text>
                                    </div>
                                ) : (
                                    <div className={styles.resultsGrid}>
                                        {searchResults.map((result) => (
                                            <div key={getResultId(result)}>
                                                <MediaCard
                                                    mini
                                                    videoAspect={isVideoImport}
                                                    title={getResultTitle(result)}
                                                    subtitle={getResultSubtitle(result)}
                                                    imageUrl={getResultImage(result, isVideoImport)}
                                                    alt={getResultTitle(result)}
                                                    quality={result.quality}
                                                    explicit={result.explicit}
                                                    onClick={() => void handleSelectMatch(result)}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </>
                        )}

                        {selectedMatch && (
                            <>
                                <div className={styles.mappingHeader}>
                                    <div className={styles.mappingHeaderInfo}>
                                        <img
                                            src={getResultImage(selectedMatch, isVideoImport) || '/assets/images/default-album.png'}
                                            alt=""
                                            className={styles.mappingHeaderArt}
                                        />
                                        <div className={styles.mappingHeaderText}>
                                            <Text size={400} weight="semibold">{getResultTitle(selectedMatch)}</Text>
                                            <Text size={200} className={styles.secondaryText}>{getResultSubtitle(selectedMatch)}</Text>
                                        </div>
                                    </div>
                                    <Button
                                        appearance="subtle"
                                        onClick={() => {
                                            setSelectedMatch(null);
                                            setAlbumTracks([]);
                                            setMappedTracks({});
                                            setDecisionRejections([]);
                                        }}
                                    >
                                        Change Match
                                    </Button>
                                </div>
                                {decisionRejections.length > 0 ? (
                                    <div className={styles.localFilePanel}>
                                        <Text weight="semibold">Automatic import rejected</Text>
                                        <Text size={200} className={styles.secondaryText}>
                                            {decisionRejections.join(' ')}
                                        </Text>
                                    </div>
                                ) : null}

                                 <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: '8px', margin: '8px 0' }}>
                                     <Text weight="semibold" size={200}>Library:</Text>
                                     <Select
                                         value={selectedLibraryId == null ? '' : String(selectedLibraryId)}
                                         onChange={(_, data) => setSelectedLibraryId(Number(data.value))}
                                         style={{ minWidth: '180px' }}
                                     >
                                         {libraries.map((library) => (
                                             <option key={library.id} value={library.id}>
                                                 {library.name} · {library.qualityProfile}
                                             </option>
                                         ))}
                                     </Select>
                                     {!isVideoImport ? (
                                         <>
                                             <Text weight="semibold" size={200}>Release:</Text>
                                             <Select
                                                 value={selectedReleaseMbid}
                                                 onChange={(_, data) => handleSelectReleaseVersion(data.value)}
                                                 style={{ minWidth: '280px' }}
                                             >
                                                 {releaseVersions.map((v) => (
                                                     <option key={v.mbid || v.id} value={v.mbid || v.id}>
                                                         {v.title || 'Release'} {v.version_label ? `(${v.version_label})` : v.track_count ? `(${v.track_count} tracks)` : ''}
                                                     </option>
                                                 ))}
                                             </Select>
                                         </>
                                     ) : null}
                                 </div>

                                 {isVideoImport ? (
                                     localFile ? (
                                         <div className={styles.localFilePanel}>
                                             <Text weight="semibold">Local file</Text>
                                             <Text className={styles.filename}>{localFile.filename}</Text>
                                             <div className={styles.localFileMeta}>
                                                 <Badge appearance="filled">{formatBytes(localFile.file_size ?? 0)}</Badge>
                                                 {formatDuration(localFile.duration) ? <Badge appearance="outline">{formatDuration(localFile.duration)}</Badge> : null}
                                                 {selectedFiles[localFile.id] ? <Badge appearance="tint">Selected</Badge> : null}
                                             </div>
                                             <Text className={styles.secondaryText}>{localFile.file_path}</Text>
                                         </div>
                                     ) : null
                                 ) : isLoadingTracks ? (
                                     <div className={styles.emptyState}>
                                         <Spinner size="large" />
                                         <Text>Loading tracks for mapping...</Text>
                                     </div>
                                 ) : (
                                     <div className={styles.tableContainer}>
                                         <Table className={styles.mappingTable}>
                                             <TableHeader>
                                                 <TableRow>
                                                     <TableHeaderCell style={{ width: '40px' }}>
                                                         <Checkbox
                                                             checked={allSelected ? true : someSelected ? 'mixed' : false}
                                                             onChange={(_, data) => {
                                                                 const nextSelected: Record<number, boolean> = {};
                                                                 targetFiles.forEach((file) => {
                                                                     nextSelected[file.id] = !!data.checked;
                                                                 });
                                                                 setSelectedFiles(nextSelected);
                                                             }}
                                                         />
                                                     </TableHeaderCell>
                                                     <TableHeaderCell style={{ width: '50%' }}>Local File</TableHeaderCell>
                                                     <TableHeaderCell>Canonical Track Assignment</TableHeaderCell>
                                                 </TableRow>
                                             </TableHeader>
                                             <TableBody>
                                                 {targetFiles.map((file) => {
                                                     const isChecked = !!selectedFiles[file.id];
                                                     const mappedId = mappedTracks[file.id];

                                                     return (
                                                         <TableRow key={file.id} style={{ opacity: isChecked ? 1 : 0.6 }}>
                                                             <TableCell>
                                                                 <Checkbox
                                                                     checked={isChecked}
                                                                     onChange={(_, data) => setSelectedFiles({ ...selectedFiles, [file.id]: !!data.checked })}
                                                                 />
                                                             </TableCell>
                                                             <TableCell>
                                                                 <div style={{ display: 'flex', flexDirection: 'column' }}>
                                                                     <span className={styles.filename} title={file.filename}>{file.filename}</span>
                                                                     <Text size={100} className={styles.secondaryText}>
                                                                         {formatBytes(file.file_size ?? 0)}
                                                                     </Text>
                                                                 </div>
                                                             </TableCell>
                                                             <TableCell>
                                                                 <Select
                                                                     value={mappedId || ''}
                                                                     onChange={(_, data) => setMappedTracks({ ...mappedTracks, [file.id]: data.value })}
                                                                     className={styles.mappingSelect}
                                                                 >
                                                                     <option value="">-- Don&apos;t Map --</option>
                                                                     {albumTracks.map((track) => {
                                                                         const providerId = String(track.id || '');
                                                                         const volNum = track.volumeNumber ?? track.volume_number ?? track.medium_position ?? 1;
                                                                         // Raw per-disc number for display: the endpoint's `trackNumber` is the
                                                                         // encoded medium*100+position (e.g. 201) used for sorting, so disc 2
                                                                         // track 1 must read "2-1", not "2-201". Shared formatter with album-wide
                                                                         // multi-volume detection — the same definition the download queue uses.
                                                                         const rawNum = track.rawTrackNumber ?? track.position ?? track.track_number ?? track.trackNumber ?? '';
                                                                         const posPrefix = formatTrackPositionPrefix(rawNum, volNum, { multiVolume: albumIsMultiVolume });
                                                                         return (
                                                                             <option key={providerId} value={providerId}>
                                                                                 {posPrefix}{track.title}
                                                                             </option>
                                                                         );
                                                                     })}
                                                                 </Select>
                                                             </TableCell>
                                                         </TableRow>
                                                     );
                                                 })}
                                             </TableBody>
                                         </Table>
                                     </div>
                                 )}
                            </>
                        )}
                    </DialogContent>
                    <DialogActions className={styles.dialogActions}>
                        <Button appearance="secondary" onClick={onClose} disabled={importMutation.isPending}>Cancel</Button>
                        <Button
                            appearance="primary"
                            icon={importMutation.isPending ? <Spinner size="tiny" /> : <ArrowImport24 />}
                            disabled={!canImport || importMutation.isPending || !selectedMatch || !selectedLibraryId || (!isVideoImport && !selectedReleaseId)}
                            onClick={handleImport}
                        >
                            {importMutation.isPending ? 'Importing...' : isVideoImport ? 'Import Video' : 'Import Selected'}
                        </Button>
                    </DialogActions>
                </DialogBody>
            </DialogSurface>
        </Dialog>
    );
};

export default ManualImportModal;
