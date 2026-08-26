/**
 * Library page toolbar: tabs, sort, filters, selection, and view controls.
 * Extracted from Library.tsx (WP7 frontend lean).
 */
import {
  Button,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  MenuDivider,
  MenuItemRadio,
  MenuGroup,
  MenuGroupHeader,
  TabList,
  Tab,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  Grid24Regular,
  AppsListDetail24Regular,
  TextBulletListLtr24Regular,
  ArrowSortUp24Regular,
  ArrowSortDown24Regular,
  CheckmarkCircle24Filled,
  CheckmarkCircle24Regular,
  ArrowImport24Filled,
  ArrowImport24Regular,
  Grid24Filled,
  AppsListDetail24Filled,
  TextBulletListLtr24Filled,
  ArrowSortUp24Filled,
  ArrowSortDown24Filled,
  ChevronDownRegular,
  ChevronDownFilled,
  Person24Regular,
  Person24Filled,
  Album24Regular,
  Album24Filled,
  MusicNote224Regular,
  MusicNote224Filled,
  Video24Regular,
  Video24Filled,
  bundleIcon,
} from "@fluentui/react-icons";
import type { ReactElement } from "react";
import FilterMenu, { type ProviderFilterOption } from "@/components/FilterMenu";
import { glassButtonStyles } from "@/components/ui/glassButtonStyles";
import { useResponsiveTabsStyles } from "@/components/ui/useResponsiveTabsStyles";
import type { StatusFilters } from "@/utils/statusFilters";
import type { StreamingProviderStatus } from "@/services/api";

const Grid24 = bundleIcon(Grid24Filled, Grid24Regular);
const AppsListDetail24 = bundleIcon(AppsListDetail24Filled, AppsListDetail24Regular);
const TextBulletListLtr24 = bundleIcon(TextBulletListLtr24Filled, TextBulletListLtr24Regular);
const ArrowSortUp24 = bundleIcon(ArrowSortUp24Filled, ArrowSortUp24Regular);
const ArrowSortDown24 = bundleIcon(ArrowSortDown24Filled, ArrowSortDown24Regular);
const ArrowImport24 = bundleIcon(ArrowImport24Filled, ArrowImport24Regular);
const CheckmarkCircle24 = bundleIcon(CheckmarkCircle24Filled, CheckmarkCircle24Regular);
const ChevronDown = bundleIcon(ChevronDownFilled, ChevronDownRegular);
const Person24 = bundleIcon(Person24Filled, Person24Regular);
const Album24 = bundleIcon(Album24Filled, Album24Regular);
const MusicNote224 = bundleIcon(MusicNote224Filled, MusicNote224Regular);
const Video24 = bundleIcon(Video24Filled, Video24Regular);

export const LIBRARY_TABS = [
  { key: "artists", label: "Artists", icon: <Person24 /> },
  { key: "albums", label: "Albums", icon: <Album24 /> },
  { key: "tracks", label: "Tracks", icon: <MusicNote224 /> },
  { key: "videos", label: "Videos", icon: <Video24 /> },
] as const;

export type LibraryTabKey = (typeof LIBRARY_TABS)[number]["key"];
export type LibrarySortBy = "name" | "releaseDate" | "popularity" | "scannedAt";
export type LibrarySortDirection = "asc" | "desc";
export type LibraryViewMode = "grid" | "list";

const useStyles = makeStyles({
  toolbar: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXS,
    alignItems: "center",
    width: "100%",
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    "@media (min-width: 640px)": {
      gap: tokens.spacingHorizontalS,
      justifyContent: "space-between",
    },
    "@media (max-width: 639px)": {
      alignItems: "center",
      rowGap: tokens.spacingVerticalXS,
    },
  },
  desktopControlsRow: {
    display: "none",
    "@media (min-width: 640px)": {
      display: "flex",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: tokens.spacingHorizontalS,
      minWidth: 0,
      flex: "0 1 auto",
    },
  },
  mobileControlsRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    flex: "0 0 auto",
    "@media (min-width: 640px)": {
      display: "none",
    },
  },
  compactActions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    flexWrap: "nowrap",
    "@media (max-width: 639px)": {
      flex: "0 0 auto",
      marginLeft: "auto",
    },
  },
  menuButtonIconOnly: {
    ...glassButtonStyles,
    minHeight: "36px",
    "@media (max-width: 639px)": {
      minHeight: "40px",
      minWidth: "40px",
      paddingLeft: tokens.spacingHorizontalS,
      paddingRight: tokens.spacingHorizontalS,
    },
  },
  mobileHiddenLabel: {
    "@media (max-width: 639px)": {
      display: "none",
    },
  },
});

export type LibraryToolbarProps = {
  selectedTab: string;
  onSelectedTabChange: (tab: string) => void;
  stats?: {
    artists?: { monitored: number; total: number };
    albums?: { monitored: number; total: number };
    tracks?: { monitored: number; total: number };
    videos?: { monitored: number; total: number };
  } | null;
  importProvider?: StreamingProviderStatus | null;
  onOpenImport: () => void;
  isSelectionMode: boolean;
  onToggleSelectionMode: () => void;
  sortBy: LibrarySortBy;
  sortDirection: LibrarySortDirection;
  onSortByChange: (sortBy: LibrarySortBy) => void;
  onSortDirectionChange: (direction: LibrarySortDirection) => void;
  libraryFilter?: "all" | "stereo" | "spatial" | "video";
  onLibraryFilterChange?: (filter: "all" | "stereo" | "spatial" | "video") => void;
  albumProviderFilter?: string;
  onAlbumProviderFilterChange?: (provider: string | undefined) => void;
  providerFilterOptions?: ProviderFilterOption[];
  albumQualityTierFilter?: string;
  onAlbumQualityTierFilterChange?: (tier: string | undefined) => void;
  statusFilters: StatusFilters;
  onStatusFiltersChange: (filters: StatusFilters) => void;
  showDownloadFilter: boolean;
  showLockFilter: boolean;
  canToggleView: boolean;
  viewMode: LibraryViewMode;
  onViewModeChange: (mode: LibraryViewMode) => void;
};

function LibrarySortMenu({
  selectedTab,
  sortBy,
  sortDirection,
  onSortByChange,
  onSortDirectionChange,
  className,
  mobileHiddenLabelClassName,
}: Pick<
  LibraryToolbarProps,
  "selectedTab" | "sortBy" | "sortDirection" | "onSortByChange" | "onSortDirectionChange"
> & { className?: string; mobileHiddenLabelClassName?: string }) {
  const sortDirectionOptions: LibrarySortDirection[] = sortBy === "name" ? ["asc", "desc"] : ["desc", "asc"];
  const getSortDirectionLabel = (dir: LibrarySortDirection) => {
    if (sortBy === "name") return dir === "asc" ? "A → Z" : "Z → A";
    if (sortBy === "popularity") return dir === "asc" ? "Low → High" : "High → Low";
    return dir === "asc" ? "Oldest → Newest" : "Newest → Oldest";
  };

  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button
          appearance="subtle"
          icon={sortDirection === "asc" ? <ArrowSortUp24 /> : <ArrowSortDown24 />}
          className={className}
          aria-label="Sort library"
          title="Sort library"
        >
          <span className={mobileHiddenLabelClassName}>Sort</span>
        </Button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList
          checkedValues={{
            sortBy: [sortBy],
            sortDirection: [sortDirection],
          }}
          onCheckedValueChange={(_, data) => {
            if (data.name === "sortBy") {
              const nextSort = data.checkedItems[0] as LibrarySortBy;
              onSortByChange(nextSort);
              onSortDirectionChange(nextSort === "name" ? "asc" : "desc");
            } else if (data.name === "sortDirection") {
              onSortDirectionChange(data.checkedItems[0] as LibrarySortDirection);
            }
          }}
        >
          <MenuGroup>
            <MenuGroupHeader>Sort By</MenuGroupHeader>
            <MenuItemRadio name="sortBy" value="name">
              Alphabetical
            </MenuItemRadio>
            <MenuItemRadio name="sortBy" value="releaseDate">
              {selectedTab === "artists" ? "Date Added" : "Release Date"}
            </MenuItemRadio>
            <MenuItemRadio name="sortBy" value="popularity">
              Popularity
            </MenuItemRadio>
            <MenuItemRadio name="sortBy" value="scannedAt">
              Last Scanned
            </MenuItemRadio>
          </MenuGroup>
          <MenuDivider />
          <MenuGroup>
            <MenuGroupHeader>Direction</MenuGroupHeader>
            {sortDirectionOptions.map((dir) => (
              <MenuItemRadio key={dir} name="sortDirection" value={dir}>
                {getSortDirectionLabel(dir)}
              </MenuItemRadio>
            ))}
          </MenuGroup>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

function LibraryControlActions(props: LibraryToolbarProps & { className?: string; mobileHiddenLabelClassName?: string }) {
  const styles = useStyles();
  const {
    selectedTab,
    importProvider,
    onOpenImport,
    isSelectionMode,
    onToggleSelectionMode,
    sortBy,
    sortDirection,
    onSortByChange,
    onSortDirectionChange,
    libraryFilter,
    onLibraryFilterChange,
    albumProviderFilter,
    onAlbumProviderFilterChange,
    providerFilterOptions,
    albumQualityTierFilter,
    onAlbumQualityTierFilterChange,
    statusFilters,
    onStatusFiltersChange,
    showDownloadFilter,
    showLockFilter,
    canToggleView,
    viewMode,
    onViewModeChange,
    className,
    mobileHiddenLabelClassName,
  } = props;
  const showProviderFilters = selectedTab === "albums" || selectedTab === "tracks" || selectedTab === "videos";
  const showQualityTierFilter = selectedTab === "albums" || selectedTab === "tracks";

  return (
    <div className={styles.compactActions}>
      {importProvider ? (
        <Button
          appearance="subtle"
          icon={<ArrowImport24 />}
          onClick={onOpenImport}
          className={className}
          title="Import artists from a connected service"
          aria-label="Import artists"
        >
          <span className={mobileHiddenLabelClassName}>Import</span>
        </Button>
      ) : null}
      <Button
        appearance="subtle"
        icon={<CheckmarkCircle24 />}
        onClick={onToggleSelectionMode}
        className={className}
        title={isSelectionMode ? "Stop selecting" : `Select ${selectedTab}`}
        aria-label={isSelectionMode ? "Stop selecting" : `Select ${selectedTab}`}
        aria-pressed={isSelectionMode}
      >
        <span className={mobileHiddenLabelClassName}>{isSelectionMode ? "Done" : "Select"}</span>
      </Button>
      <LibrarySortMenu
        selectedTab={selectedTab}
        sortBy={sortBy}
        sortDirection={sortDirection}
        onSortByChange={onSortByChange}
        onSortDirectionChange={onSortDirectionChange}
        className={className}
        mobileHiddenLabelClassName={mobileHiddenLabelClassName}
      />
      <FilterMenu
        libraryFilter={libraryFilter}
        onLibraryFilterChange={onLibraryFilterChange}
        providerFilter={showProviderFilters ? albumProviderFilter : undefined}
        onProviderFilterChange={showProviderFilters ? onAlbumProviderFilterChange : undefined}
        providerOptions={showProviderFilters ? providerFilterOptions : undefined}
        qualityTierFilter={showQualityTierFilter ? albumQualityTierFilter : undefined}
        onQualityTierFilterChange={showQualityTierFilter ? onAlbumQualityTierFilterChange : undefined}
        statusFilters={statusFilters}
        onStatusFiltersChange={onStatusFiltersChange}
        showDownloadFilter={showDownloadFilter}
        showLockFilter={showLockFilter}
        className={className}
        hideLabelOnMobile
      />
      {canToggleView ? (() => {
        // Show the view the button switches TO (not the current one), so the
        // label/icon tell the user where they are going. The artist tab's
        // detailed row view is a "Table" (Lidarr's term) rather than a compact
        // "List", and uses the bullet-list glyph to distinguish it.
        const switchingToList = viewMode === "grid";
        const isArtists = selectedTab === "artists";
        const targetLabel = switchingToList ? (isArtists ? "Table" : "List") : "Grid";
        const targetIcon = switchingToList
          ? (isArtists ? <TextBulletListLtr24 /> : <AppsListDetail24 />)
          : <Grid24 />;
        return (
          <Button
            appearance="subtle"
            icon={targetIcon}
            onClick={() => onViewModeChange(switchingToList ? "list" : "grid")}
            className={className}
            title={`Switch to ${targetLabel.toLowerCase()} view`}
            aria-label={`Switch to ${targetLabel.toLowerCase()} view`}
          >
            <span className={mobileHiddenLabelClassName}>
              {targetLabel}
            </span>
          </Button>
        );
      })() : null}
    </div>
  );
}

export function LibraryToolbar(props: LibraryToolbarProps): ReactElement {
  const styles = useStyles();
  const responsiveTabsStyles = useResponsiveTabsStyles();
  const { selectedTab, onSelectedTabChange, stats } = props;

  return (
    <div className={styles.toolbar}>
      <div className={responsiveTabsStyles.tabSlot}>
        <div className={responsiveTabsStyles.mobileSelect}>
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button appearance="subtle" iconPosition="after" icon={<ChevronDown />} className={responsiveTabsStyles.menuButton}>
                {LIBRARY_TABS.find((tab) => tab.key === selectedTab)?.label ?? "Artists"}
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {LIBRARY_TABS.map((tab) => (
                  <MenuItem key={tab.key} icon={tab.icon} onClick={() => onSelectedTabChange(tab.key)}>
                    {tab.label}
                  </MenuItem>
                ))}
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
        <div className={responsiveTabsStyles.desktopTabs}>
          <TabList selectedValue={selectedTab} onTabSelect={(_, data) => onSelectedTabChange(data.value as string)}>
            {LIBRARY_TABS.map((tab) => {
              const statKey = tab.key as keyof Pick<NonNullable<typeof stats>, "artists" | "albums" | "tracks" | "videos">;
              const tabStats = stats?.[statKey];
              return (
                <Tab key={tab.key} value={tab.key} title={tabStats ? `${tabStats.monitored} monitored, ${tabStats.total} catalog` : undefined}>
                  {tab.label}
                </Tab>
              );
            })}
          </TabList>
        </div>
      </div>

      <div className={styles.mobileControlsRow}>
        <LibraryControlActions
          {...props}
          className={styles.menuButtonIconOnly}
          mobileHiddenLabelClassName={styles.mobileHiddenLabel}
        />
      </div>

      <div className={styles.desktopControlsRow}>
        <LibraryControlActions
          {...props}
          className={styles.menuButtonIconOnly}
          mobileHiddenLabelClassName={styles.mobileHiddenLabel}
        />
      </div>
    </div>
  );
}
