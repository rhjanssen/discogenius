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
import { ArrowImport24Regular, Search24Regular } from '@fluentui/react-icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import MediaCard from '@/components/cards/MediaCard';
import { useToast } from '@/hooks/useToast';
import { api } from '@/services/api';

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
        borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
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
        border: `1px solid ${tokens.colorNeutralStroke2}`,
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
        padding: '40px',
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

interface UnmappedFile {
    id: number;
    file_path: string;
    relative_path: string;
    library_root: string;
    filename: string;
    extension: string;
    file_size: number;
    duration?: number | null;
    detected_artist?: string | null;
    detected_album?: string | null;
    detected_track?: string | null;
    audio_quality?: string | null;
    reason?: string | null;
    ignored: boolean;
}

interface Props {
    isOpen: boolean;
    onClose: () => void;
    initialFile: UnmappedFile | null;
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

const buildResourceImage = (imageId?: string | null, dimensions = '160x160') => {
    if (!imageId) return null;
    return `https://resources.tidal.com/images/${imageId.replace(/-/g, '/')}/${dimensions}.jpg`;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildInitialSearchQuery = (file: UnmappedFile, isVideoImport: boolean) => {
    if (!isVideoImport) {
        return [file.detected_artist, file.detected_album].filter(Boolean).join(' ').trim();
    }

    const baseName = file.filename.replace(/\.[^/.]+$/, '');
    const strippedTitle = file.detected_artist
        ? baseName.replace(new RegExp(`^${escapeRegExp(file.detected_artist)}\\s*-\\s*`, 'i'), '').trim()
        : baseName;
    const title = file.detected_track || strippedTitle;
    return [file.detected_artist, title].filter(Boolean).join(' ').trim();
};

const getResultId = (result: any) => String(result.id || '');

const getResultTitle = (result: any) => result.name || result.title || 'Unknown Release';

const getResultSubtitle = (result: any) =>
    result.subtitle || result.artist_name || result.artist?.name || result.artists?.[0]?.name || 'Unknown Artist';

const getResultImage = (result: any, isVideoImport: boolean) => {
    if (isVideoImport) {
        return buildResourceImage(result.image_id || result.imageId || result.cover_id || result.cover, '320x180');
    }

    return buildResourceImage(result.imageId || result.cover_id || result.cover, '160x160');
};

const ManualImportModal: React.FC<Props> = ({ isOpen, onClose, initialFile, allFiles }) => {
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
    const [isLoadingTracks, setIsLoadingTracks] = useState(false);
    const [selectedFiles, setSelectedFiles] = useState<Record<number, boolean>>({});
    const [mappedTracks, setMappedTracks] = useState<Record<number, string>>({});
    const [decisionRejections, setDecisionRejections] = useState<string[]>([]);

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
        setHasSearched(false);
        setMappedTracks({});
        setDecisionRejections([]);
        setSelectedFiles(initialSelected);

        if (!nextQuery) {
            return;
        }

        setIsSearching(true);
        const searchTypes = isVideoImport ? ['videos'] : ['albums'];
        api.search(nextQuery, searchTypes, 10)
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
    }, [initialFile, isOpen, isVideoImport, targetFiles]);

    const handleSearch = async (queryToSearch: string = searchQuery) => {
        if (!queryToSearch.trim()) return;

        setIsSearching(true);
        setHasSearched(true);

        try {
            const searchTypes = isVideoImport ? ['videos'] : ['artists', 'albums', 'tracks'];
            const response = await api.search(queryToSearch, searchTypes, 20) as any;
            setSearchResults(isVideoImport ? response?.results?.videos || [] : response?.results?.albums || []);
        } catch (error: any) {
            toast({ title: 'Search failed', description: error.message, variant: 'destructive' });
        } finally {
            setIsSearching(false);
        }
    };

    const handleSelectMatch = async (result: any) => {
        setSelectedMatch(result);

        if (isVideoImport) {
            if (!initialFile) return;
            setMappedTracks({ [initialFile.id]: getResultId(result) });
            setDecisionRejections([]);
            return;
        }

        setIsLoadingTracks(true);

        try {
            const tracks = await api.getTidalAlbumTracks(getResultId(result)) as any[];
            setAlbumTracks(tracks);

            if (targetFiles.length === 0 || tracks.length === 0) {
                setMappedTracks({});
                return;
            }

            const response = await api.identifyUnmappedFiles(
                targetFiles.map((file) => file.id),
                getResultId(result)
            ) as any;

            setMappedTracks(response?.success && response.mappedTracks ? response.mappedTracks : {});
            setDecisionRejections(Array.isArray(response?.rejections) ? response.rejections : []);
        } catch (error: any) {
            toast({ title: 'Failed to fetch or map tracks', description: error.message, variant: 'destructive' });
        } finally {
            setIsLoadingTracks(false);
        }
    };

    const importMutation = useMutation({
        mutationFn: async (payload: { items: Array<{ id: number; tidalId: string }> }) => api.bulkMapUnmappedFiles(payload.items),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['unmapped-files'] });
            toast({ title: 'Success', description: 'Successfully mapped selected files.' });
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
                tidalId: mappedTracks[file.id],
            }));

        if (payloadItems.length === 0) {
            toast({
                title: 'No Files Chosen',
                description: isVideoImport
                    ? 'Select a matching TIDAL video for this file.'
                    : 'Select at least one file and assign a TIDAL track to it.',
                variant: 'destructive',
            });
            return;
        }

        importMutation.mutate({ items: payloadItems });
    };

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
                                        ? <>Match this local video to a TIDAL video release.</>
                                        : <>Found <strong>{targetFiles.length}</strong> files ready for manual import in <Badge appearance="outline">{initialFile ? getDirname(initialFile.relative_path) : ''}</Badge></>}
                                </Text>

                                <div className={styles.searchContainer}>
                                    <Input
                                        className={styles.searchInput}
                                        placeholder={isVideoImport ? 'Search TIDAL for the correct video...' : 'Search TIDAL for the correct release...'}
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
                                        icon={<Search24Regular />}
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
                                            <Badge appearance="filled">{formatBytes(localFile.file_size)}</Badge>
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
                                        <Text>Searching TIDAL...</Text>
                                    </div>
                                ) : hasSearched && searchResults.length === 0 ? (
                                    <div className={styles.emptyState}>
                                        <Search24Regular style={{ fontSize: '48px', color: tokens.colorNeutralForeground4 }} />
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

                                {isVideoImport ? (
                                    localFile ? (
                                        <div className={styles.localFilePanel}>
                                            <Text weight="semibold">Local file</Text>
                                            <Text className={styles.filename}>{localFile.filename}</Text>
                                            <div className={styles.localFileMeta}>
                                                <Badge appearance="filled">{formatBytes(localFile.file_size)}</Badge>
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
                                                    <TableHeaderCell>TIDAL Track Assignment</TableHeaderCell>
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
                                                                        {formatBytes(file.file_size)}
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
                                                                        const tidalId = String(track.id);
                                                                        return (
                                                                            <option key={tidalId} value={tidalId}>
                                                                                {track.trackNumber || track.track_number}. {track.title} {track.version ? `(${track.version})` : ''}
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
                            icon={importMutation.isPending ? <Spinner size="tiny" /> : <ArrowImport24Regular />}
                            disabled={!canImport || importMutation.isPending || !selectedMatch}
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
