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
