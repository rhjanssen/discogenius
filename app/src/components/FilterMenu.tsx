import {
    Button,
    Menu,
    MenuTrigger,
    MenuPopover,
    MenuList,
    MenuItem,
    MenuItemCheckbox,
    MenuDivider,
    Text,
    tokens,
    MenuProps,
    makeStyles,
} from "@fluentui/react-components";
import {
    Filter24Regular,
    Checkmark24Regular,
    Circle24Regular,
    Grid24Regular,
    AppsListDetail24Regular,
    Eye24Regular,
    EyeOff24Regular,
    LockClosed24Regular,
    LockOpen24Regular,
    ArrowDownload24Regular,
    CloudArrowDown24Regular,
} from "@fluentui/react-icons";
import type { StatusFilters } from "@/utils/statusFilters";

interface FilterMenuProps {
    // Library type filter (single selection)
    libraryFilter?: 'all' | 'stereo' | 'atmos' | 'video';
    onLibraryFilterChange?: (filter: 'all' | 'stereo' | 'atmos' | 'video') => void;

    // Status filters
    statusFilters?: StatusFilters;
    onStatusFiltersChange?: (filters: StatusFilters) => void;

    // View mode
    viewMode?: 'grid' | 'list';
    onViewModeChange?: (mode: 'grid' | 'list') => void;

    // Feature flags
    showDownloadFilter?: boolean;    // Hide on artist page
    showLockFilter?: boolean;        // Show lock filter

    // Controlled open state (optional — for triggering from an external menu item)
    open?: boolean;
    onOpenChange?: (open: boolean) => void;

    // Styling
    className?: string;  // Optional className for the trigger button
    hideLabelOnMobile?: boolean;
}

const useStyles = makeStyles({
    mobileHiddenLabel: {
        "@media (max-width: 639px)": {
            display: "none",
        },
    },
});

const FilterMenu = ({
    libraryFilter,
    onLibraryFilterChange,
    statusFilters,
    onStatusFiltersChange,
    viewMode,
    onViewModeChange,
    showDownloadFilter = true,
    showLockFilter = true,
    open: controlledOpen,
    onOpenChange,
    className,
    hideLabelOnMobile = false,
}: FilterMenuProps) => {
    const styles = useStyles();
    const sectionLabelStyle = {
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        fontWeight: tokens.fontWeightSemibold,
        fontSize: tokens.fontSizeBase100,
        color: tokens.colorNeutralForeground3,
    } as const;

    const hasLibraryFilter = libraryFilter !== undefined && onLibraryFilterChange;
    const hasStatusFilters = statusFilters !== undefined && onStatusFiltersChange;
    const hasViewMode = viewMode !== undefined && onViewModeChange;

    // Track checked items for MenuItemCheckbox
    const checkedValues = statusFilters ? {
        monitoring: [
            ...(statusFilters.onlyMonitored ? ['monitored'] : []),
            ...(statusFilters.onlyUnmonitored ? ['unmonitored'] : []),
        ],
        lock: [
            ...(statusFilters.onlyLocked ? ['locked'] : []),
            ...(statusFilters.onlyUnlocked ? ['unlocked'] : []),
        ],
        download: [
            ...(statusFilters.onlyDownloaded ? ['downloaded'] : []),
            ...(statusFilters.onlyNotDownloaded ? ['notDownloaded'] : []),
        ],
    } : {};

    const handleCheckedChange: MenuProps['onCheckedValueChange'] = (_, data) => {
        if (!onStatusFiltersChange || !statusFilters) return;

        const name = data.name;
        const checked = data.checkedItems;

        const newFilters = { ...statusFilters };

        if (name === 'monitoring') {
            newFilters.onlyMonitored = checked.includes('monitored');
            newFilters.onlyUnmonitored = checked.includes('unmonitored');
        } else if (name === 'lock') {
            newFilters.onlyLocked = checked.includes('locked');
            newFilters.onlyUnlocked = checked.includes('unlocked');
        } else if (name === 'download') {
            newFilters.onlyDownloaded = checked.includes('downloaded');
            newFilters.onlyNotDownloaded = checked.includes('notDownloaded');
        }

        onStatusFiltersChange(newFilters);
    };

    // Count active filters for badge
    const activeFilterCount = (() => {
        let count = 0;
        if (libraryFilter && libraryFilter !== 'all') count++;
        if (statusFilters) {
            if (statusFilters.onlyMonitored) count++;
            if (statusFilters.onlyUnmonitored) count++;
            if (statusFilters.onlyLocked) count++;
            if (statusFilters.onlyUnlocked) count++;
            if (statusFilters.onlyDownloaded) count++;
            if (statusFilters.onlyNotDownloaded) count++;
        }
        return count;
    })();

    return (
        <Menu
            checkedValues={checkedValues}
            onCheckedValueChange={handleCheckedChange}
            {...(controlledOpen !== undefined ? { open: controlledOpen, onOpenChange: (_e: any, data: any) => onOpenChange?.(data.open) } : {})}
        >
            <MenuTrigger>
                <Button
                    icon={<Filter24Regular />}
                    appearance="subtle"
                    style={{ color: activeFilterCount > 0 ? tokens.colorBrandForeground1 : undefined }}
                    className={className}
                    aria-label={`Filters${activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}`}
                >
                    <span className={hideLabelOnMobile ? styles.mobileHiddenLabel : undefined}>
                        Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
                    </span>
                </Button>
            </MenuTrigger>
            <MenuPopover>
                <MenuList>
                    {/* Library Type Filter */}
                    {hasLibraryFilter && (
                        <>
                            <Text style={sectionLabelStyle}>
                                LIBRARY TYPE
                            </Text>
                            <MenuItem
                                onClick={() => onLibraryFilterChange?.('all')}
                                icon={libraryFilter === 'all' ? <Checkmark24Regular /> : <Circle24Regular style={{ opacity: 0.3 }} />}
                            >
                                All Types
                            </MenuItem>
                            <MenuItem
                                onClick={() => onLibraryFilterChange?.('stereo')}
                                icon={libraryFilter === 'stereo' ? <Checkmark24Regular /> : <Circle24Regular style={{ opacity: 0.3 }} />}
                            >
                                Stereo Only
                            </MenuItem>
                            <MenuItem
                                onClick={() => onLibraryFilterChange?.('atmos')}
                                icon={libraryFilter === 'atmos' ? <Checkmark24Regular /> : <Circle24Regular style={{ opacity: 0.3 }} />}
                            >
                                Atmos Only
                            </MenuItem>
                            <MenuItem
                                onClick={() => onLibraryFilterChange?.('video')}
                                icon={libraryFilter === 'video' ? <Checkmark24Regular /> : <Circle24Regular style={{ opacity: 0.3 }} />}
                            >
                                Videos Only
                            </MenuItem>
                            <MenuDivider />
                        </>
                    )}

                    {/* Monitoring Status */}
                    {hasStatusFilters && (
                        <>
                            <Text style={sectionLabelStyle}>
                                MONITORING
                            </Text>
                            <MenuItemCheckbox
                                name="monitoring"
                                value="monitored"
                                icon={<Eye24Regular />}
                            >
                                Monitored
                            </MenuItemCheckbox>
                            <MenuItemCheckbox
                                name="monitoring"
                                value="unmonitored"
                                icon={<EyeOff24Regular />}
                            >
                                Unmonitored
                            </MenuItemCheckbox>
                            <MenuDivider />
                        </>
                    )}

                    {/* Lock Status */}
                    {hasStatusFilters && showLockFilter && (
                        <>
                            <Text style={sectionLabelStyle}>
                                LOCK
                            </Text>
                            <MenuItemCheckbox
                                name="lock"
                                value="locked"
                                icon={<LockClosed24Regular />}
                            >
                                Locked
                            </MenuItemCheckbox>
                            <MenuItemCheckbox
                                name="lock"
                                value="unlocked"
                                icon={<LockOpen24Regular />}
                            >
                                Unlocked
                            </MenuItemCheckbox>
                            <MenuDivider />
                        </>
                    )}

                    {/* Download Status */}
                    {hasStatusFilters && showDownloadFilter && (
                        <>
                            <Text style={sectionLabelStyle}>
                                DOWNLOAD
                            </Text>
                            <MenuItemCheckbox
                                name="download"
                                value="downloaded"
                                icon={<ArrowDownload24Regular />}
                            >
                                Downloaded
                            </MenuItemCheckbox>
                            <MenuItemCheckbox
                                name="download"
                                value="notDownloaded"
                                icon={<CloudArrowDown24Regular />}
                            >
                                Not Downloaded
                            </MenuItemCheckbox>
                            {hasViewMode && <MenuDivider />}
                        </>
                    )}

                    {/* View Mode */}
                    {hasViewMode && (
                        <>
                            <Text style={sectionLabelStyle}>
                                VIEW
                            </Text>
                            <MenuItem
                                onClick={() => onViewModeChange?.('grid')}
                                icon={viewMode === 'grid' ? <Grid24Regular /> : <Circle24Regular style={{ opacity: 0.3 }} />}
                            >
                                Grid
                            </MenuItem>
                            <MenuItem
                                onClick={() => onViewModeChange?.('list')}
                                icon={viewMode === 'list' ? <AppsListDetail24Regular /> : <Circle24Regular style={{ opacity: 0.3 }} />}
                            >
                                List
                            </MenuItem>
                        </>
                    )}
                </MenuList>
            </MenuPopover>
        </Menu>
    );
};

export default FilterMenu;
