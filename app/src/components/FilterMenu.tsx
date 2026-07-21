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

const Filter24 = bundleIcon(Filter24Filled, Filter24Regular);
const Checkmark24 = bundleIcon(Checkmark24Filled, Checkmark24Regular);
const Circle24 = bundleIcon(Circle24Filled, Circle24Regular);
const Grid24 = bundleIcon(Grid24Filled, Grid24Regular);
const AppsListDetail24 = bundleIcon(AppsListDetail24Filled, AppsListDetail24Regular);
const Eye24 = bundleIcon(Eye24Filled, Eye24Regular);
const EyeOff24 = bundleIcon(EyeOff24Filled, EyeOff24Regular);
const LockClosed24 = bundleIcon(LockClosed24Filled, LockClosed24Regular);
const LockOpen24 = bundleIcon(LockOpen24Filled, LockOpen24Regular);
const ArrowDownload24 = bundleIcon(ArrowDownload24Filled, ArrowDownload24Regular);
const CloudArrowDown24 = bundleIcon(CloudArrowDown24Filled, CloudArrowDown24Regular);

export interface ProviderFilterOption {
    id: string;
    name: string;
}

interface FilterMenuProps {
    // Library type filter (single selection)
    libraryFilter?: 'all' | 'stereo' | 'spatial' | 'video';
    onLibraryFilterChange?: (filter: 'all' | 'stereo' | 'spatial' | 'video') => void;

    // Provider filter (single selection; undefined = all providers)
    providerFilter?: string;
    onProviderFilterChange?: (provider: string | undefined) => void;
    providerOptions?: ProviderFilterOption[];

    // Quality-tier filter (single selection; undefined = all qualities)
    qualityTierFilter?: string;
    onQualityTierFilterChange?: (tier: string | undefined) => void;

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

const QUALITY_TIER_OPTIONS = ['MAX', 'HIGH', 'NORMAL', 'LOW'] as const;

const FilterMenu = ({
    libraryFilter,
    onLibraryFilterChange,
    providerFilter,
    onProviderFilterChange,
    providerOptions,
    qualityTierFilter,
    onQualityTierFilterChange,
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
    const hasProviderFilter = Boolean(onProviderFilterChange && (providerOptions?.length ?? 0) > 0);
    const hasQualityFilter = Boolean(onQualityTierFilterChange);
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
        if (providerFilter) count++;
        if (qualityTierFilter) count++;
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
                    icon={<Filter24 />}
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
                                icon={libraryFilter === 'all' ? <Checkmark24 /> : <Circle24 style={{ opacity: 0.3 }} />}
                            >
                                All Types
                            </MenuItem>
                            <MenuItem
                                onClick={() => onLibraryFilterChange?.('stereo')}
                                icon={libraryFilter === 'stereo' ? <Checkmark24 /> : <Circle24 style={{ opacity: 0.3 }} />}
                            >
                                Stereo Only
                            </MenuItem>
                            <MenuItem
                                onClick={() => onLibraryFilterChange?.('spatial')}
                                icon={libraryFilter === 'spatial' ? <Checkmark24 /> : <Circle24 style={{ opacity: 0.3 }} />}
                            >
                                Spatial Only
                            </MenuItem>
                            <MenuItem
                                onClick={() => onLibraryFilterChange?.('video')}
                                icon={libraryFilter === 'video' ? <Checkmark24 /> : <Circle24 style={{ opacity: 0.3 }} />}
                            >
                                Videos Only
                            </MenuItem>
                            <MenuDivider />
                        </>
                    )}

                    {/* Provider Filter */}
                    {hasProviderFilter && (
                        <>
                            <Text style={sectionLabelStyle}>
                                PROVIDER
                            </Text>
                            <MenuItem
                                onClick={() => onProviderFilterChange?.(undefined)}
                                icon={!providerFilter ? <Checkmark24 /> : <Circle24 style={{ opacity: 0.3 }} />}
                            >
                                All Providers
                            </MenuItem>
                            {providerOptions?.map((option) => (
                                <MenuItem
                                    key={option.id}
                                    onClick={() => onProviderFilterChange?.(option.id)}
                                    icon={providerFilter === option.id ? <Checkmark24 /> : <Circle24 style={{ opacity: 0.3 }} />}
                                >
                                    {option.name}
                                </MenuItem>
                            ))}
                            <MenuDivider />
                        </>
                    )}

                    {/* Quality Filter */}
                    {hasQualityFilter && (
                        <>
                            <Text style={sectionLabelStyle}>
                                QUALITY
                            </Text>
                            <MenuItem
                                onClick={() => onQualityTierFilterChange?.(undefined)}
                                icon={!qualityTierFilter ? <Checkmark24 /> : <Circle24 style={{ opacity: 0.3 }} />}
                            >
                                All Qualities
                            </MenuItem>
                            {QUALITY_TIER_OPTIONS.map((tier) => (
                                <MenuItem
                                    key={tier}
                                    onClick={() => onQualityTierFilterChange?.(tier)}
                                    icon={qualityTierFilter === tier ? <Checkmark24 /> : <Circle24 style={{ opacity: 0.3 }} />}
                                >
                                    {tier}
                                </MenuItem>
                            ))}
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
                                icon={<Eye24 />}
                            >
                                Monitored
                            </MenuItemCheckbox>
                            <MenuItemCheckbox
                                name="monitoring"
                                value="unmonitored"
                                icon={<EyeOff24 />}
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
                                icon={<LockClosed24 />}
                            >
                                Locked
                            </MenuItemCheckbox>
                            <MenuItemCheckbox
                                name="lock"
                                value="unlocked"
                                icon={<LockOpen24 />}
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
                                icon={<ArrowDownload24 />}
                            >
                                Downloaded
                            </MenuItemCheckbox>
                            <MenuItemCheckbox
                                name="download"
                                value="notDownloaded"
                                icon={<CloudArrowDown24 />}
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
                                icon={viewMode === 'grid' ? <Grid24 /> : <Circle24 style={{ opacity: 0.3 }} />}
                            >
                                Grid
                            </MenuItem>
                            <MenuItem
                                onClick={() => onViewModeChange?.('list')}
                                icon={viewMode === 'list' ? <AppsListDetail24 /> : <Circle24 style={{ opacity: 0.3 }} />}
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
