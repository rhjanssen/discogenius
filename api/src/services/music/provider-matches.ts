import { db } from "../../database.js";

/**
 * Additive provider -> MusicBrainz match graph (the `ProviderMatches` table).
 *
 * This persists candidate matches from a provider entity (today: a provider album)
 * to a canonical MusicBrainz entity (today: an MB release). Multiple candidate rows
 * per provider source are allowed, which is what lets the release-availability
 * switcher show every MB release a provider can supply. It lives alongside the
 * existing `ProviderItems` offer cache and does not replace it.
 */

export interface ProviderReleaseMatchInput {
  provider: string;
  /** Provider album id (the match source). */
  providerId: string;
  /** Owning provider album id; for a release match this equals providerId. */
  providerAlbumId?: string | null;
  /** Target MusicBrainz release MBID. */
  releaseMbid: string;
  status?: string | null;
  confidence?: number | null;
  method?: string | null;
  /** Pre-serialized JSON evidence. */
  evidence?: string | null;
}

export interface ReleaseAvailabilityProvider {
  provider: string;
  providerAlbumId: string | null;
  quality: string | null;
  librarySlot: string | null;
  status: string | null;
  confidence: number | null;
}

export interface ReleaseAvailability {
  releaseMbid: string;
  title: string | null;
  date: string | null;
  country: string | null;
  availability: ReleaseAvailabilityProvider[];
}

export interface ReleaseGroupAvailability {
  releaseGroupMbid: string;
  /** slot name -> selected release MBID (from ReleaseGroupSlots). */
  selectedReleaseBySlot: Record<string, string | null>;
  releases: ReleaseAvailability[];
}

/** Additively upsert a provider-album -> MB-release match candidate. */
export function upsertProviderReleaseMatch(input: ProviderReleaseMatchInput): void {
  db.prepare(`
    INSERT INTO ProviderMatches (
      provider, entity_type, provider_id, provider_album_id,
      target_mbid, target_kind, status, confidence, method, evidence, updated_at
    ) VALUES (?, 'release', ?, ?, ?, 'release', ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(provider, entity_type, provider_id, target_mbid) DO UPDATE SET
      provider_album_id = excluded.provider_album_id,
      status = excluded.status,
      confidence = excluded.confidence,
      method = excluded.method,
      evidence = excluded.evidence,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    input.provider,
    String(input.providerId),
    input.providerAlbumId != null ? String(input.providerAlbumId) : String(input.providerId),
    input.releaseMbid,
    input.status ?? null,
    input.confidence ?? null,
    input.method ?? null,
    input.evidence ?? null,
  );
}

/**
 * Read: per-release streaming availability for a MusicBrainz release group.
 * Lists every MB release in the group, with the providers that have a matched
 * provider album for it, plus which release is currently selected per slot.
 */
export function getReleaseGroupAvailability(releaseGroupMbid: string): ReleaseGroupAvailability {
  const rows = db.prepare(`
    SELECT
      ar.mbid             AS release_mbid,
      ar.title            AS title,
      ar.date             AS date,
      ar.country          AS country,
      pm.provider         AS provider,
      pm.provider_album_id AS provider_album_id,
      pm.status           AS status,
      pm.confidence       AS confidence,
      pi.quality          AS quality,
      pi.library_slot     AS library_slot
    FROM AlbumReleases ar
    LEFT JOIN ProviderMatches pm
      ON pm.entity_type = 'release' AND pm.target_mbid = ar.mbid
    LEFT JOIN ProviderItems pi
      ON pi.provider = pm.provider
     AND pi.entity_type = 'album'
     AND CAST(pi.provider_id AS TEXT) = CAST(pm.provider_id AS TEXT)
    WHERE ar.release_group_mbid = ?
    ORDER BY (ar.date IS NULL), ar.date, ar.mbid, pm.confidence DESC
  `).all(releaseGroupMbid) as Array<{
    release_mbid: string;
    title: string | null;
    date: string | null;
    country: string | null;
    provider: string | null;
    provider_album_id: string | null;
    status: string | null;
    confidence: number | null;
    quality: string | null;
    library_slot: string | null;
  }>;

  const byRelease = new Map<string, ReleaseAvailability>();
  for (const r of rows) {
    let rel = byRelease.get(r.release_mbid);
    if (!rel) {
      rel = { releaseMbid: r.release_mbid, title: r.title, date: r.date, country: r.country, availability: [] };
      byRelease.set(r.release_mbid, rel);
    }
    if (r.provider) {
      rel.availability.push({
        provider: r.provider,
        providerAlbumId: r.provider_album_id,
        quality: r.quality,
        librarySlot: r.library_slot,
        status: r.status,
        confidence: r.confidence,
      });
    }
  }

  const slotRows = db.prepare(`
    SELECT slot, selected_release_mbid FROM ReleaseGroupSlots WHERE release_group_mbid = ?
  `).all(releaseGroupMbid) as Array<{ slot: string; selected_release_mbid: string | null }>;
  const selectedReleaseBySlot: Record<string, string | null> = {};
  for (const s of slotRows) selectedReleaseBySlot[s.slot] = s.selected_release_mbid ?? null;

  return {
    releaseGroupMbid,
    selectedReleaseBySlot,
    releases: Array.from(byRelease.values()),
  };
}
