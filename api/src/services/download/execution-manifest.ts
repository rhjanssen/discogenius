import type Database from 'better-sqlite3';
import { resolveEnabledAudioLibraryTarget } from '../music/acquisition-download-command.js';

/** Validate the acquisition boundary before a downloader or organizer writes files. */
export function validateExecutionManifest(db: Database.Database, request: {
    provider?: string | null;
    libraryId?: number | null;
    slot?: string | null;
    trackOffers?: readonly { provider?: string; providerTrackId: string; providerTrackItemId?: number | null }[];
}) {
    const provider = String(request.provider || '').trim();
    if (!provider) throw new Error('Acquisition requires an explicit provider');
    for (const offer of request.trackOffers || []) {
        if (offer.provider !== provider) throw new Error('Acquisition track offers must all use the command provider');
        const item = db.prepare("SELECT id FROM ProviderItems WHERE provider = ? AND entity_type = 'track' AND provider_id = ?")
            .get(provider, offer.providerTrackId) as { id: number } | undefined;
        if (!item || (offer.providerTrackItemId != null && item.id !== offer.providerTrackItemId)) {
            throw new Error(`Invalid provider track identity: ${provider}:${offer.providerTrackId}`);
        }
    }
    if (request.libraryId == null) return null;
    const target = resolveEnabledAudioLibraryTarget(db, request.libraryId);
    if (!target) throw new Error(`Invalid audio library ${request.libraryId}`);
    if (request.slot && request.slot !== target.slot) throw new Error('Requested slot does not match the destination library');
    return target;
}

/** A repeated title cannot override a conflicting exact ID or occurrence. */
export function applyImportTrackProgress<T extends { providerTrackId?: string; trackNum?: number; volumeNum?: number; title?: string; status: string }>(
    tracks: T[], state: { currentProviderTrackId?: string | null; currentTrackNum?: number | null; currentVolumeNum?: number | null; currentTrack?: string; trackStatus?: string },
): T[] {
    const candidates = tracks.filter(track => {
        if (state.currentProviderTrackId) {
            if (track.providerTrackId !== state.currentProviderTrackId) return false;
        } else if (state.currentTrackNum == null) {
            return !!state.currentTrack && track.title?.trim().toLowerCase() === state.currentTrack.trim().toLowerCase();
        }
        if (state.currentTrackNum != null && track.trackNum !== state.currentTrackNum) return false;
        if (state.currentVolumeNum != null && track.volumeNum !== state.currentVolumeNum) return false;
        return true;
    });
    if (candidates.length !== 1) return tracks;
    return tracks.map(track => track === candidates[0] ? { ...track, status: state.trackStatus || 'downloading' } : track);
}
