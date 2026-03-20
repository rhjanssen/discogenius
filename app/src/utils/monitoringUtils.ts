/**
 * Monitoring state utilities
 * Centralized logic for monitor lock checks and monitoring state queries
 */

export interface Monitorable {
  monitor_locked?: boolean;
  monitor_lock?: boolean;
  is_monitored?: boolean;
}

/**
 * Check if a media item has monitor lock enabled (intentionally excluded from monitoring)
 * Falls back from monitor_locked (new) to monitor_lock (legacy)
 */
export const isMonitorLocked = (item: Monitorable): boolean => {
  return !!(item.monitor_locked ?? item.monitor_lock);
};

/**
 * Check if a media item is being monitored (monitored + not locked)
 */
export const isMonitored = (item: Monitorable & { is_monitored?: boolean }): boolean => {
  return item.is_monitored === true && !isMonitorLocked(item);
};
