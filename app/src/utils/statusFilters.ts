export interface StatusFilters {
  // Monitoring status
  onlyMonitored: boolean;
  onlyUnmonitored: boolean;
  // Lock status
  onlyLocked: boolean;
  onlyUnlocked: boolean;
  // Download status
  onlyDownloaded: boolean;
  onlyNotDownloaded: boolean;
  // Redundancy status (primary vs redundant)
  onlyPrimary: boolean;
  onlyRedundant: boolean;
}

// Default: no active filters = show everything except hidden
export const defaultStatusFilters: StatusFilters = {
  onlyMonitored: false,
  onlyUnmonitored: false,
  onlyLocked: false,
  onlyUnlocked: false,
  onlyDownloaded: false,
  onlyNotDownloaded: false,
  onlyPrimary: false,
  onlyRedundant: false,
};
