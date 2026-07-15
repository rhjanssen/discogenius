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
    mergeClasses,
} from "@fluentui/react-components";
import {
  Filter24Regular as Filter24RegularBase,
  Checkmark24Regular as Checkmark24RegularBase,
  Circle24Regular as Circle24RegularBase,
  Grid24Regular as Grid24RegularBase,
  AppsListDetail24Regular as AppsListDetail24RegularBase,
  Eye24Regular as Eye24RegularBase,
  EyeOff24Regular as EyeOff24RegularBase,
  LockClosed24Regular as LockClosed24RegularBase,
  LockOpen24Regular as LockOpen24RegularBase,
  ArrowDownload24Regular as ArrowDownload24RegularBase,
  CloudArrowDown24Regular as CloudArrowDown24RegularBase,
  Filter24Filled,
  Checkmark24Filled,
  Circle24Filled,
  Grid24Filled,
  AppsListDetail24Filled,
  Eye24Filled,
  EyeOff24Filled,
  LockClosed24Filled,
  LockOpen24Filled,
  ArrowDownload24Filled,
  CloudArrowDown24Filled,
  bundleIcon
} from "@fluentui/react-icons";
import type { StatusFilters } from "@/utils/statusFilters";
import { glassButtonStyles } from "@/components/ui/glassButtonStyles";

const Filter24Regular = bundleIcon(Filter24Filled, Filter24RegularBase);
const Checkmark24Regular = bundleIcon(Checkmark24Filled, Checkmark24RegularBase);
const Circle24Regular = bundleIcon(Circle24Filled, Circle24RegularBase);
const Grid24Regular = bundleIcon(Grid24Filled, Grid24RegularBase);
const AppsListDetail24Regular = bundleIcon(AppsListDetail24Filled, AppsListDetail24RegularBase);
const Eye24Regular = bundleIcon(Eye24Filled, Eye24RegularBase);
const EyeOff24Regular = bundleIcon(EyeOff24Filled, EyeOff24RegularBase);
const LockClosed24Regular = bundleIcon(LockClosed24Filled, LockClosed24RegularBase);
const LockOpen24Regular = bundleIcon(LockOpen24Filled, LockOpen24RegularBase);
const ArrowDownload24Regular = bundleIcon(ArrowDownload24Filled, ArrowDownload24RegularBase);
const CloudArrowDown24Regular = bundleIcon(CloudArrowDown24Filled, CloudArrowDown24RegularBase);

interface FilterMenuProps {
    // Library type filter (single selection)
    libraryFilter?: 'all' | 'stereo' | 'spatial' | 'video';
    onLibraryFilterChange?: (filter: 'all' | 'stereo' | 'spatial' | 'video') => void;

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
    triggerButton: {
        ...glassButtonStyles,
    },
    activeTriggerButton: {
        color: tokens.colorBrandForeground1,
    },
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
    const checkedValues: Record<string, string[]> | undefined = statusFilters ? {
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
    } : undefined;

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
            if (showLockFilter) {
                if (statusFilters.onlyLocked) count++;
                if (statusFilters.onlyUnlocked) count++;
            }
            if (showDownloadFilter) {
                if (statusFilters.onlyDownloaded) count++;
                if (statusFilters.onlyNotDownloaded) count++;
            }
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
                    className={mergeClasses(
                        styles.triggerButton,
                        activeFilterCount > 0 ? styles.activeTriggerButton : undefined,
                        className
                    )}
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
                                onClick={() => onLibraryFilterChange?.('spatial')}
                                icon={libraryFilter === 'spatial' ? <Checkmark24Regular /> : <Circle24Regular style={{ opacity: 0.3 }} />}
                            >
                                Spatial Only
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
