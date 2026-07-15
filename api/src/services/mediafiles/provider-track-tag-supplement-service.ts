import { db } from "../../database.js";
import { streamingProviderManager } from "../providers/index.js";
import type { ProviderTrack } from "../providers/streaming-provider.js";

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function providerTrackTagSupplements(track: ProviderTrack): {
  providerId: string;
  replayGain: number | null;
  peak: number | null;
  copyright: string | null;
} {
  const raw = track.raw && typeof track.raw === "object"
    ? track.raw as Record<string, unknown>
    : {};
  return {
    providerId: String(track.providerId),
    replayGain: finiteNumber(track.replayGain ?? raw.replay_gain ?? raw.replayGain),
    peak: finiteNumber(track.peak ?? raw.peak),
    copyright: text(track.copyright ?? raw.copyright),
  };
}

/**
 * The bulk catalog endpoint intentionally omits loudness fields. Refresh the
 * small, exact set being imported through the provider's full track endpoint
 * before AudioTagService writes the finished files.
 */
export class ProviderTrackTagSupplementService {
  static async refresh(options: {
    providerId?: string | null;
    albumProviderIds?: string[];
    trackProviderIds?: string[];
  }): Promise<number> {
    const provider = options.providerId
      ? streamingProviderManager.getStreamingProvider(options.providerId)
      : streamingProviderManager.getDefaultStreamingProvider();
    const tracks: ProviderTrack[] = [];

    const albumNeedsRefresh = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN replay_gain IS NULL OR peak IS NULL OR copyright IS NULL THEN 1 ELSE 0 END) AS missing
      FROM ProviderItems
      WHERE provider = ?
        AND entity_type = 'track'
        AND CAST(provider_album_id AS TEXT) = CAST(? AS TEXT)
    `);
    const trackNeedsRefresh = db.prepare(`
      SELECT replay_gain, peak, copyright
      FROM ProviderItems
      WHERE provider = ?
        AND entity_type = 'track'
        AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
      LIMIT 1
    `);

    for (const albumId of new Set(options.albumProviderIds || [])) {
      const status = albumNeedsRefresh.get(provider.id, albumId) as { total: number; missing: number | null };
      if (status.total > 0 && Number(status.missing || 0) === 0) continue;
      tracks.push(...await provider.getAlbumTracks(albumId));
    }
    for (const trackId of new Set(options.trackProviderIds || [])) {
      const status = trackNeedsRefresh.get(provider.id, trackId) as {
        replay_gain: number | null;
        peak: number | null;
        copyright: string | null;
      } | undefined;
      if (status?.replay_gain != null && status.peak != null && status.copyright != null) continue;
      tracks.push(await provider.getTrack(trackId));
    }

    const update = db.prepare(`
      UPDATE ProviderItems
      SET replay_gain = COALESCE(?, replay_gain),
          peak = COALESCE(?, peak),
          copyright = COALESCE(?, copyright),
          updated_at = CURRENT_TIMESTAMP
      WHERE provider = ?
        AND entity_type = 'track'
        AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
    `);

    let updated = 0;
    db.transaction(() => {
      for (const track of tracks) {
        const supplement = providerTrackTagSupplements(track);
        if (supplement.replayGain == null && supplement.peak == null && !supplement.copyright) continue;
        updated += update.run(
          supplement.replayGain,
          supplement.peak,
          supplement.copyright,
          provider.id,
          supplement.providerId,
        ).changes;
      }
    })();
    return updated;
  }
}
