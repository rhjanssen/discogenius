/** Progress belongs to one command and therefore one provider. Within that
 * command an ID can repeat across discs; update only one proven occurrence. */
export interface TrackProgressUpdate {
  currentProviderTrackId?: string | null;
  currentTrackNum?: number | null;
  currentVolumeNum?: number | null;
  currentTrack?: string;
  trackStatus?: string;
}

type TrackRow = {
  canonicalTrackMbid?: string;
  providerTrackId?: string;
  trackNum?: number;
  volumeNum?: number;
  title?: string;
  status: string;
};

/** Merge snapshots by a proven occurrence, never by array position. */
export function mergeTrackProgress<T extends TrackRow>(previous: T[] | undefined, incoming: T[] | undefined): T[] | undefined {
  if (!incoming) return previous;
  if (!previous?.length) return incoming;
  return incoming.map(track => {
    const candidates = previous.filter(old => {
      const sameOccurrence = (track.trackNum == null || old.trackNum == null || track.trackNum === old.trackNum)
        && (track.volumeNum == null || old.volumeNum == null || track.volumeNum === old.volumeNum);
      if (!sameOccurrence) return false;
      if (track.canonicalTrackMbid && old.canonicalTrackMbid) return track.canonicalTrackMbid === old.canonicalTrackMbid;
      return Boolean(track.providerTrackId) && track.providerTrackId === old.providerTrackId
        && (track.trackNum == null || old.trackNum == null || track.trackNum === old.trackNum)
        && (track.volumeNum == null || old.volumeNum == null || track.volumeNum === old.volumeNum);
    });
    if (candidates.length !== 1) return track;
    const old = candidates[0];
    if ((old.status === 'completed' || old.status === 'skipped') && (track.status === 'queued' || track.status === 'downloading')) {
      return { ...track, status: old.status };
    }
    if (old.status === 'downloading' && track.status === 'queued') return { ...track, status: old.status };
    return track;
  });
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function applyTrackProgress<T extends TrackRow>(tracks: T[], update: TrackProgressUpdate): T[] {
  if (!update.trackStatus) return tracks;
  const hasIdentity = !!update.currentProviderTrackId || update.currentTrackNum != null || update.currentVolumeNum != null;
  let candidates = tracks.filter(track =>
    (!update.currentProviderTrackId || track.providerTrackId === update.currentProviderTrackId)
    && (update.currentTrackNum == null || track.trackNum === update.currentTrackNum)
    && (update.currentVolumeNum == null || track.volumeNum === update.currentVolumeNum));
  if (!hasIdentity) {
    const reported = normalizeTitle(update.currentTrack || '');
    if (!reported) return tracks;
    const exact = candidates.filter(track => normalizeTitle(track.title || '') === reported);
    if (exact.length) candidates = exact;
    else {
      // Provider output may append a quality label. Never strip arbitrary title
      // prefixes or pick the first of two equally specific matches.
      candidates = candidates.filter(track => {
        const title = normalizeTitle(track.title || '');
        return title && reported.startsWith(`${title} `);
      });
      const longest = Math.max(0, ...candidates.map(track => normalizeTitle(track.title || '').length));
      candidates = candidates.filter(track => normalizeTitle(track.title || '').length === longest);
    }
  }
  if (candidates.length !== 1) return tracks;
  const target = candidates[0];
  if (target.status === update.trackStatus || (target.status === 'completed' && update.trackStatus !== 'completed')) return tracks;
  return tracks.map(track => track === target ? { ...track, status: update.trackStatus! } : track);
}
