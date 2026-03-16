export const LIBRARY_UPDATED_EVENT = 'library-updated';
export const MONITOR_STATE_CHANGED_EVENT = 'discogenius:monitor-state-changed';
export const ACTIVITY_REFRESH_EVENT = 'discogenius:activity-refresh';
export const OPEN_ACTIVITY_QUEUE_EVENT = 'discogenius:open-activity-queue';
export const OPEN_SEARCH_EVENT = 'discogenius:open-search';

export type MonitorItemType = 'artist' | 'album' | 'track' | 'video';

export interface MonitorStateChangedDetail {
  type: MonitorItemType;
  tidalId: string;
  monitored: boolean;
}

const optimisticMonitorState = new Map<string, boolean>();

function getMonitorStateKey(type: MonitorItemType, tidalId: string) {
  return `${type}:${tidalId}`;
}

export function dispatchLibraryUpdated() {
  window.dispatchEvent(new Event(LIBRARY_UPDATED_EVENT));
}

export function dispatchActivityRefresh() {
  window.dispatchEvent(new Event(ACTIVITY_REFRESH_EVENT));
}

export function dispatchOpenActivityQueue() {
  window.dispatchEvent(new Event(OPEN_ACTIVITY_QUEUE_EVENT));
}

export function dispatchOpenSearch() {
  window.dispatchEvent(new Event(OPEN_SEARCH_EVENT));
}

export function dispatchMonitorStateChanged(detail: MonitorStateChangedDetail) {
  window.dispatchEvent(
    new CustomEvent<MonitorStateChangedDetail>(MONITOR_STATE_CHANGED_EVENT, { detail }),
  );
}

export function setOptimisticMonitorState(detail: MonitorStateChangedDetail) {
  optimisticMonitorState.set(getMonitorStateKey(detail.type, detail.tidalId), detail.monitored);
}

export function getOptimisticMonitorState(type: MonitorItemType, tidalId: string) {
  return optimisticMonitorState.get(getMonitorStateKey(type, tidalId));
}

export function clearOptimisticMonitorState(type: MonitorItemType, tidalId: string) {
  optimisticMonitorState.delete(getMonitorStateKey(type, tidalId));
}
