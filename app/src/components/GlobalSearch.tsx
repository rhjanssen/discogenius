import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
    SearchBox,
    Button,
    Spinner,
    Avatar,
    Text,
    makeStyles,
    tokens,
    Card,
    TabList,
    Tab,
    Body1,
    Caption1,
    Subtitle2,
    mergeClasses,
} from "@fluentui/react-components";
import {
    Eye24Regular,
    EyeOff24Regular,
    ArrowDownload24Regular,
} from "@fluentui/react-icons";
import { useSearch, SearchResultItem } from "@/hooks/useSearch";
import { getTidalImage } from "@/utils/tidalImages";
import { tidalUrl } from "@/utils/tidalUrl";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";

const searchBoxRadius = tokens.borderRadiusCircular;
const searchUnderlineHeight = "4px";
const searchUnderlineOverlayHeight = "16px";

const useStyles = makeStyles({
    container: {
        position: "relative",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        overflow: "visible",
    },
    searchBox: {
        width: "100%",
        borderRadius: searchBoxRadius,
        overflow: "hidden",
        isolation: "isolate",
        borderTopColor: "transparent !important",
        borderRightColor: "transparent !important",
        borderBottomColor: "transparent !important",
        borderLeftColor: "transparent !important",
        boxShadow: "none",
        "&:hover": {
            borderTopColor: "transparent !important",
            borderRightColor: "transparent !important",
            borderBottomColor: "transparent !important",
            borderLeftColor: "transparent !important",
            boxShadow: "none",
        },
        "&:active": {
            borderTopColor: "transparent !important",
            borderRightColor: "transparent !important",
            borderBottomColor: "transparent !important",
            borderLeftColor: "transparent !important",
            boxShadow: "none",
        },
        "&&:focus-within": {
            borderBottomColor: "transparent !important",
            borderTopColor: "transparent !important",
            borderRightColor: "transparent !important",
            borderLeftColor: "transparent !important",
            borderBottomStyle: "solid",
            boxShadow: "none",
        },
        "&&:focus-within:active": {
            borderBottomColor: "transparent !important",
            borderTopColor: "transparent !important",
            borderRightColor: "transparent !important",
            borderLeftColor: "transparent !important",
            borderBottomStyle: "solid",
            boxShadow: "none",
        },
        "&::after": {
            left: "-2px",
            right: "-2px",
            bottom: "-2px",
            height: searchUnderlineOverlayHeight,
            backgroundImage: "var(--dg-search-underline-gradient)",
            backgroundPosition: "left bottom",
            backgroundRepeat: "no-repeat",
            backgroundSize: "calc(100% + 4px) 4px",
            clipPath: `inset(calc(100% - ${searchUnderlineHeight}) 0 0 0 round 0 0 ${searchBoxRadius} ${searchBoxRadius})`,
            borderBottom: "none",
            borderBottomLeftRadius: searchBoxRadius,
            borderBottomRightRadius: searchBoxRadius,
            zIndex: 2,
            pointerEvents: "none",
        },
        "&:focus-within::after": {
            backgroundImage: "var(--dg-search-underline-gradient)",
            transform: "scaleX(1)",
        },
        "&:focus-within:active::after": {
            backgroundImage: "var(--dg-search-underline-gradient)",
            transform: "scaleX(1)",
        },
    },
    searchBoxOpen: {
        borderBottomColor: "transparent !important",
        "&&": {
            borderBottomColor: "transparent !important",
            borderBottomStyle: "solid",
        },
        "&::after": {
            backgroundImage: "var(--dg-search-underline-gradient)",
            transform: "scaleX(1)",
        },
    },
    resultsContainer: {
        position: "absolute",
        top: `calc(100% + ${tokens.spacingVerticalXXS})`,
        left: 0,
        right: 0,
        width: "100%",
        maxHeight: "calc(100vh - 120px)",
        backgroundColor: tokens.colorNeutralBackground2,
        boxShadow: tokens.shadow16,
        borderRadius: tokens.borderRadiusLarge,
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        "@media (max-width: 639px)": {
            maxHeight: "calc(100dvh - 120px)",
        },
    },
    tabContainer: {
        padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalNone}`,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        flexShrink: 0,
        overflowX: "auto",
        overflowY: "hidden",
        WebkitOverflowScrolling: "touch",
        scrollbarWidth: "none",
        "&::-webkit-scrollbar": { display: "none" },
        "@media (min-width: 640px)": {
            padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
            overflowX: "visible",
        },
    },
    tabList: {
        display: "flex",
        flexWrap: "nowrap",
        whiteSpace: "nowrap",
        paddingLeft: tokens.spacingHorizontalS,
        paddingRight: tokens.spacingHorizontalS,
    },
    scrollableContent: {
        flex: 1,
        overflowY: "auto",
        padding: tokens.spacingVerticalS,
        "@media (min-width: 640px)": {
            padding: tokens.spacingVerticalM,
        },
    },
    noResults: {
        padding: tokens.spacingVerticalL,
        textAlign: "center",
        color: tokens.colorNeutralForeground2,
    },
    // Grids
    artistGrid: {
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: tokens.spacingHorizontalS,
        alignItems: "stretch",
        "@media (min-width: 480px)": {
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        },
        "@media (min-width: 640px)": {
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: tokens.spacingHorizontalM,
        },
    },
    albumGrid: {
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: tokens.spacingHorizontalS,
        alignItems: "stretch",
        "@media (min-width: 480px)": {
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        },
        "@media (min-width: 640px)": {
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: tokens.spacingHorizontalM,
        },
    },
    // Cards
    artistCard: {
        alignItems: "center",
        textAlign: "center",
        padding: tokens.spacingVerticalS,
        cursor: "pointer",
        position: "relative",
        width: "100%",
        justifyContent: "space-between",
        "&:hover": { backgroundColor: tokens.colorNeutralBackground1Hover },
    },
    artistCardActions: {
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: tokens.spacingHorizontalXS,
        marginTop: tokens.spacingVerticalXS,
    },
    albumCard: {
        position: "relative",
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        minHeight: "228px",
        paddingTop: tokens.spacingVerticalNone,
        paddingBottom: tokens.spacingVerticalNone,
        paddingLeft: tokens.spacingHorizontalNone,
        paddingRight: tokens.spacingHorizontalNone,
        overflow: "hidden",
        cursor: "pointer",
        backgroundColor: "color-mix(in srgb, rgba(255,255,255,0.08) 68%, transparent)",
        borderRadius: tokens.borderRadiusLarge,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
        boxShadow: tokens.shadow4,
        transitionDuration: tokens.durationFast,
        transitionTimingFunction: tokens.curveEasyEase,
        transitionProperty: "transform, box-shadow, border-color, background-color",
        "&:hover": {
            transform: "translateY(-2px)",
            boxShadow: tokens.shadow16,
            borderTopColor: tokens.colorNeutralStroke1Hover,
            borderRightColor: tokens.colorNeutralStroke1Hover,
            borderBottomColor: tokens.colorNeutralStroke1Hover,
            borderLeftColor: tokens.colorNeutralStroke1Hover,
            backgroundColor: "color-mix(in srgb, rgba(255,255,255,0.12) 72%, transparent)",
        },
    },
    albumCardPreview: {
        position: "absolute",
        inset: 0,
        backgroundColor: tokens.colorNeutralBackground3,
    },
    albumCardImage: {
        width: "100%",
        height: "100%",
        objectFit: "cover",
        display: "block",
        transform: "scale(1.01)",
    },
    albumCardScrim: {
        position: "absolute",
        inset: 0,
        backgroundImage: "linear-gradient(180deg, rgba(5, 7, 11, 0.08) 0%, rgba(5, 7, 11, 0.26) 46%, rgba(5, 7, 11, 0.94) 100%)",
    },
    albumCardContent: {
        position: "relative",
        zIndex: 1,
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        justifyContent: "flex-end",
        minHeight: "88px",
        padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM} ${tokens.spacingVerticalM}`,
    },
    albumCardTitle: {
        fontWeight: tokens.fontWeightSemibold,
        color: tokens.colorNeutralForeground1,
        lineHeight: tokens.lineHeightBase200,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "normal",
        display: "-webkit-box",
        WebkitBoxOrient: "vertical",
        WebkitLineClamp: 2,
    },
    albumCardSubtitle: {
        color: tokens.colorNeutralForeground2,
        fontSize: tokens.fontSizeBase200,
        lineHeight: tokens.lineHeightBase200,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },
    // List Items
    listContainer: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXS,
    },
    detailedRow: {
        display: "grid",
        gridTemplateColumns: "40px 1fr auto", // Compact on mobile: Img | Info | Actions
        gap: tokens.spacingHorizontalS,
        alignItems: "center",
        padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
        borderRadius: tokens.borderRadiusMedium,
        cursor: "pointer",
        "&:hover": { backgroundColor: tokens.colorNeutralBackground1Hover },
        "@media (min-width: 640px)": {
            gridTemplateColumns: "48px 2fr 1.5fr 1fr auto",
            gap: tokens.spacingHorizontalM,
            padding: tokens.spacingVerticalS,
        },
    },
    detailedRowVideo: {
        gridTemplateColumns: "60px 1fr auto",
        "@media (min-width: 640px)": {
            gridTemplateColumns: "120px 2fr 1.5fr auto",
        },
    },
    rowImageSquare: {
        width: "40px",
        height: "40px",
        borderRadius: tokens.borderRadiusSmall,
        objectFit: "cover",
        "@media (min-width: 640px)": {
            width: "48px",
            height: "48px",
        },
    },
    rowImageVideo: {
        width: "60px",
        aspectRatio: "16/9",
        borderRadius: tokens.borderRadiusSmall,
        objectFit: "cover",
        "@media (min-width: 640px)": {
            width: "120px",
            borderRadius: tokens.borderRadiusMedium,
        },
    },
    mobileHidden: {
        display: "none",
        "@media (min-width: 640px)": {
            display: "flex",
        },
    },
    desktopHidden: {
        display: "block",
        "@media (min-width: 640px)": {
            display: "none",
        },
    },
    itemInfo: {
        overflow: "hidden",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
    },
    monitorIcon: {
        width: "16px",
        height: "16px",
        color: tokens.colorNeutralForeground2,
    },
    rowTitleText: {
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        fontWeight: tokens.fontWeightSemibold,
        fontSize: tokens.fontSizeBase200,
    },
    rowSubText: {
        color: tokens.colorNeutralForeground2,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
    },
    rowActionsContainer: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXS,
        justifySelf: "end",
    },
    rowExtraInfo: {
        color: tokens.colorNeutralForeground2,
    },
    sectionTitle: {
        marginBottom: tokens.spacingVerticalS,
    },
    sectionSpacer: {
        marginTop: tokens.spacingVerticalL,
    },
    helperText: {
        padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        color: tokens.colorNeutralForeground2,
    },
});

type TabType = 'top' | 'artists' | 'albums' | 'tracks' | 'videos';

interface GlobalSearchProps {
    autoFocus?: boolean;
}

const GlobalSearch = ({ autoFocus }: GlobalSearchProps = {}) => {
    const styles = useStyles();
    const [searchQuery, setSearchQuery] = useState("");
    const [isOpen, setIsOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<TabType>('top');
    const { searchResults, isSearching, search, addItem, removeItem } = useSearch();
    const [processingItems, setProcessingItems] = useState<Set<string>>(new Set());
    const [downloadingItems, setDownloadingItems] = useState<Set<string>>(new Set());
    const searchRef = useRef<HTMLDivElement>(null);
    const navigate = useNavigate();
    const { toast } = useToast();
    const searchActivityLabel = "Searching TIDAL...";

    useEffect(() => {
        const debounceTimer = setTimeout(() => {
            if (searchQuery.length >= 2) {
                search(searchQuery);
                setIsOpen(true);
            } else {
                setIsOpen(false);
            }
        }, 300);
        return () => clearTimeout(debounceTimer);
    }, [searchQuery, search]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const handleItemClick = (item: SearchResultItem) => {
        if (item.type === 'artist') navigate(`/artist/${item.tidalId}`);
        else if (item.type === 'album') navigate(`/album/${item.tidalId}`);
        else if (item.type === 'video') navigate(`/video/${item.tidalId}`);
        setIsOpen(false);
    };

    const handleToggleItem = async (item: SearchResultItem, e: React.MouseEvent) => {
        e.stopPropagation();
        setProcessingItems(prev => new Set(prev).add(item.tidalId));
        try {
            // This button toggles *monitoring*, not library inclusion.
            // If the item isn't in the library yet, monitoring it will add it.
            if (item.monitored) await removeItem(item);
            else await addItem(item);
        } finally {
            setProcessingItems(prev => {
                const next = new Set(prev);
                next.delete(item.tidalId);
                return next;
            });
        }
    };

    const handleDownloadItem = async (item: SearchResultItem, e: React.MouseEvent) => {
        e.stopPropagation();

        setDownloadingItems(prev => new Set(prev).add(item.tidalId));
        try {
            const typeMap: Record<string, string> = {
                track: 'track',
                album: 'album',
                video: 'video',
                artist: 'artist',
            };
            const urlType = typeMap[item.type] || 'track';
            const url = tidalUrl(urlType as any, item.tidalId);
            await api.addToQueue(url, item.type, item.tidalId);
            toast({
                title: "Added to queue",
                description: `${item.name} will be downloaded shortly`,
            });
        } catch (error) {
            console.error("Error adding to queue:", error);
            toast({
                title: "Failed to add to queue",
                description: "Please try again",
                variant: "destructive",
            });
        } finally {
            setDownloadingItems(prev => {
                const next = new Set(prev);
                next.delete(item.tidalId);
                return next;
            });
        }
    };

    // --- Render Helpers ---

    const renderEmpty = () => (
        <div className={styles.noResults}>
            {`No results found for "${searchQuery}". Try a different search term, TIDAL URL, or album/artist ID.`}
        </div>
    );

    const renderGridItem = (item: SearchResultItem, type: 'artist' | 'album') => {
        const isProcessing = processingItems.has(item.tidalId);

        if (type === "album") {
            const subtitle = item.subtitle?.split('·').slice(1).join(' · ').trim() || item.subtitle;
            return (
                <Card
                    key={item.tidalId}
                    className={styles.albumCard}
                    onClick={() => handleItemClick(item)}
                >
                    <div className={styles.albumCardPreview}>
                        <img
                            src={getTidalImage(item.imageId, 'album', 'medium')}
                            alt={item.name}
                            className={styles.albumCardImage}
                            loading="lazy"
                        />
                        <div className={styles.albumCardScrim} />
                    </div>
                    <div className={styles.albumCardContent}>
                        <Text className={styles.albumCardTitle}>{item.name}</Text>
                        <Text className={styles.albumCardSubtitle}>{subtitle}</Text>
                    </div>
                </Card>
            );
        }

        return (
            <Card
                key={item.tidalId}
                className={styles.artistCard}
                onClick={() => handleItemClick(item)}
            >
                <Avatar
                    image={{ src: getTidalImage(item.imageId, 'artist', 'small') }}
                    name={item.name}
                    size={96}
                    shape="circular"
                />

                <div className={styles.artistCardActions}>
                    <div className={styles.itemInfo}>
                        <Text weight="semibold" wrap={false} align="center" size={200}>
                            {item.name}
                        </Text>
                    </div>
                    <Button
                        appearance="subtle"
                        size="small"
                        icon={isProcessing ? <Spinner size="tiny" /> : (item.monitored ? <EyeOff24Regular className={styles.monitorIcon} /> : <Eye24Regular className={styles.monitorIcon} />)}
                        onClick={(e) => handleToggleItem(item, e)}
                        disabled={isProcessing}
                        title={item.monitored ? "Unmonitor" : "Monitor"}
                    />
                </div>
            </Card>
        );
    };

    const renderDetailedRow = (item: SearchResultItem) => {
        const isProcessing = processingItems.has(item.tidalId);
        const isDownloading = downloadingItems.has(item.tidalId);
        const isVideo = item.type === 'video';
        const canDownload = item.type === 'track' || item.type === 'album' || item.type === 'video';
        const downloadDisabled = isDownloading;

        // Parse subtitle for parts: "Type · Artist · Info" -> ["Type", "Artist", "Info"]
        const parts = item.subtitle?.split('·').map(s => s.trim()) || [];
        const artistName = parts[1] || "";
        const extraInfo = parts[2] || ""; // Duration or Year

        return (
            <div
                key={item.tidalId}
                className={mergeClasses(styles.detailedRow, isVideo ? styles.detailedRowVideo : undefined)}
                onClick={() => handleItemClick(item)}
            >
                {/* Image */}
                <img
                    src={getTidalImage(
                        item.imageId,
                        item.type === 'track' ? 'album' : item.type as 'artist' | 'album' | 'video',
                        'tiny'
                    ) || undefined}
                    alt={item.name}
                    className={isVideo ? styles.rowImageVideo : styles.rowImageSquare}
                />

                {/* Title + Artist (mobile shows both stacked) */}
                <div className={styles.itemInfo}>
                    <Body1 className={styles.rowTitleText}>
                        {item.name}
                    </Body1>
                    <Caption1 className={mergeClasses(styles.desktopHidden, styles.rowSubText)}>
                        {artistName}
                    </Caption1>
                </div>

                {/* Artist - hidden on mobile, shown on desktop */}
                <div className={mergeClasses(styles.itemInfo, styles.mobileHidden)}>
                    <Caption1 className={styles.rowSubText}>
                        {artistName}
                    </Caption1>
                </div>

                {/* Album (Tracks only) - hidden on mobile */}
                {!isVideo && (
                    <div className={mergeClasses(styles.itemInfo, styles.mobileHidden)}>
                        <Caption1 className={styles.rowSubText}>
                            {/* Album placeholder if data available later */}
                        </Caption1>
                    </div>
                )}

                {/* Duration/Year & Actions */}
                <div className={styles.rowActionsContainer}>
                    <Caption1 className={styles.rowExtraInfo}>{extraInfo}</Caption1>
                    {canDownload && (
                        <Button
                            appearance="subtle"
                            icon={isDownloading ? <Spinner size="tiny" /> : <ArrowDownload24Regular />}
                            onClick={(e) => handleDownloadItem(item, e)}
                            disabled={downloadDisabled}
                            title="Download"
                        />
                    )}
                    <Button
                        appearance="subtle"
                        icon={isProcessing ? <Spinner size="tiny" /> : (item.monitored ? <EyeOff24Regular className={styles.monitorIcon} /> : <Eye24Regular className={styles.monitorIcon} />)}
                        onClick={(e) => handleToggleItem(item, e)}
                        disabled={isProcessing}
                        title={item.monitored ? "Unmonitor" : "Monitor"}
                    />
                </div>
            </div>
        );
    };

    const renderContent = () => {
        const hasResults = searchResults.artists.length > 0 || searchResults.albums.length > 0 || searchResults.tracks.length > 0 || searchResults.videos.length > 0;

        // When searching, keep showing the last results and just show a spinner indicator.
        // This makes the UI feel responsive even if remote (TIDAL) search is slow.
        if (!hasResults && isSearching) {
            return (
                <div className={styles.noResults}>
                    <Spinner size="small" label={searchActivityLabel} />
                </div>
            );
        }

        if (!hasResults) return renderEmpty();

        // Top Results Logic: Pick 1 best match
        let topItem: SearchResultItem | undefined;
        if (activeTab === 'top') {
            topItem = searchResults.artists[0] || searchResults.albums[0] || searchResults.tracks[0] || searchResults.videos[0];
        }

        return (
            <div className={styles.scrollableContent}>
                {isSearching && (
                    <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: tokens.spacingVerticalS }}>
                        <Spinner size="small" label={searchActivityLabel} />
                    </div>
                )}

                {activeTab === 'top' && topItem && (
                    <div className={styles.listContainer}>
                        <Subtitle2 className={styles.sectionTitle}>Top result</Subtitle2>
                        {renderDetailedRow(topItem)}
                        <div className={styles.sectionSpacer} />

                        {searchResults.tracks.length > 0 && (
                            <>
                                <Subtitle2 className={styles.sectionTitle}>Tracks</Subtitle2>
                                {searchResults.tracks.slice(0, 3).map(renderDetailedRow)}
                            </>
                        )}
                    </div>
                )}

                {activeTab === 'artists' && (
                    searchResults.artists.length > 0 ? (
                        <div className={styles.artistGrid}>
                            {searchResults.artists.map(item => renderGridItem(item, 'artist'))}
                        </div>
                    ) : (
                        <div className={styles.noResults}>No artists found</div>
                    )
                )}

                {activeTab === 'albums' && (
                    searchResults.albums.length > 0 ? (
                        <div className={styles.albumGrid}>
                            {searchResults.albums.map(item => renderGridItem(item, 'album'))}
                        </div>
                    ) : (
                        <div className={styles.noResults}>No albums found</div>
                    )
                )}

                {activeTab === 'tracks' && (
                    searchResults.tracks.length > 0 ? (
                        <div className={styles.listContainer}>
                            {searchResults.tracks.map(renderDetailedRow)}
                        </div>
                    ) : (
                        <div className={styles.noResults}>No tracks found</div>
                    )
                )}

                {activeTab === 'videos' && (
                    searchResults.videos.length > 0 ? (
                        <div className={styles.listContainer}>
                            {searchResults.videos.map(renderDetailedRow)}
                        </div>
                    ) : (
                        <div className={styles.noResults}>No videos found</div>
                    )
                )}
            </div>
        );
    };

    return (
        <div ref={searchRef} className={styles.container}>
            <SearchBox
                autoFocus={autoFocus}
                placeholder="Search by name, TIDAL ID, or URL..."
                aria-label="Search artists, albums, tracks, or videos"
                value={searchQuery}
                onChange={(_e, data) => setSearchQuery(data.value)}
                onFocus={() => {
                    if (searchQuery) setIsOpen(true);
                }}
                className={mergeClasses(styles.searchBox, isOpen ? styles.searchBoxOpen : undefined)}
            />

            {isOpen && (
                <Card className={styles.resultsContainer} role="dialog" aria-label="Search results">
                    <div className={styles.tabContainer}>
                        <TabList
                            selectedValue={activeTab}
                            onTabSelect={(_, data) => setActiveTab(data.value as TabType)}
                            appearance="subtle"
                            className={styles.tabList}
                        >
                            <Tab value="top">Top</Tab>
                            <Tab value="artists">Artists</Tab>
                            <Tab value="albums">Albums</Tab>
                            <Tab value="tracks">Tracks</Tab>
                            <Tab value="videos">Videos</Tab>
                        </TabList>
                    </div>
                    {renderContent()}
                </Card>
            )}
        </div>
    );
};

export default GlobalSearch;

