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
  disambiguation: string | null;
  status: string | null;
  date: string | null;
  country: string | null;
  format: string | null;
  mediumCount: number | null;
  trackCount: number | null;
  duration: number | null;
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

/** Library slots that can hold a selected release. */
export const SLOTS = ["stereo", "spatial", "video"] as const;
export type Slot = (typeof SLOTS)[number];

export interface SetSlotSelectionInput {
  releaseGroupMbid: string;
  slot: string;
  releaseMbid: string;
  provider?: string | null;
  providerAlbumId?: string | null;
}

interface ProviderReleaseOfferRow {
  provider: string;
  provider_id: string;
  quality: string | null;
  status: string | null;
  confidence: number | null;
  method: string | null;
  evidence: string | null;
  data: string | null;
}

/**
 * Switch which MB release fills a given slot for a release group (the write half
 * of the Lidarr-style release switcher). Selection-only: this does not change a
 * slot's monitored / monitored_lock state — monitoring stays orthogonal. When no
 * provider is supplied, the best (highest-confidence) matched provider offer for
 * the chosen release is used. Returns the refreshed availability.
 */
export function setSlotSelection(input: SetSlotSelectionInput): ReleaseGroupAvailability {
  if (!(SLOTS as readonly string[]).includes(input.slot)) {
    throw new Error(`unknown slot: ${input.slot}`);
  }

  const releaseInGroup = db.prepare(
    `SELECT 1 FROM AlbumReleases WHERE mbid = ? AND release_group_mbid = ?`,
  ).get(input.releaseMbid, input.releaseGroupMbid);
  if (!releaseInGroup) {
    throw new Error(`release ${input.releaseMbid} is not in release group ${input.releaseGroupMbid}`);
  }

  let provider = input.provider ?? null;
  let providerAlbumId = input.providerAlbumId ?? null;
  let offer: ProviderReleaseOfferRow | undefined;
  if (provider && providerAlbumId) {
    offer = db.prepare(`
      SELECT
        pm.provider,
        pm.provider_id,
        pi.quality,
        pm.status,
        pm.confidence,
        pm.method,
        pm.evidence,
        pi.data
      FROM ProviderMatches pm
      LEFT JOIN ProviderItems pi
        ON pi.provider = pm.provider
       AND pi.entity_type = 'album'
       AND CAST(pi.provider_id AS TEXT) = CAST(pm.provider_id AS TEXT)
      WHERE pm.entity_type = 'release'
        AND pm.target_mbid = ?
        AND pm.provider = ?
        AND CAST(pm.provider_id AS TEXT) = CAST(? AS TEXT)
        AND (pm.status IS NULL OR LOWER(pm.status) <> 'rejected')
      LIMIT 1
    `).get(input.releaseMbid, provider, providerAlbumId) as ProviderReleaseOfferRow | undefined;
    if (!offer) {
      throw new Error(`provider offer ${provider}:${providerAlbumId} does not match release ${input.releaseMbid}`);
    }
  } else {
    offer = db.prepare(`
      SELECT
        pm.provider,
        pm.provider_id,
        pi.quality,
        pm.status,
        pm.confidence,
        pm.method,
        pm.evidence,
        pi.data
      FROM ProviderMatches pm
      LEFT JOIN ProviderItems pi
        ON pi.provider = pm.provider
       AND pi.entity_type = 'album'
       AND CAST(pi.provider_id AS TEXT) = CAST(pm.provider_id AS TEXT)
      WHERE pm.entity_type = 'release'
        AND pm.target_mbid = ?
        AND (pm.status IS NULL OR LOWER(pm.status) <> 'rejected')
      ORDER BY (pm.confidence IS NULL), pm.confidence DESC, pm.updated_at DESC
      LIMIT 1
    `).get(input.releaseMbid) as ProviderReleaseOfferRow | undefined;
    provider = provider ?? offer?.provider ?? null;
    providerAlbumId = providerAlbumId ?? offer?.provider_id ?? null;
  }

  const result = db.prepare(`
    UPDATE ReleaseGroupSlots
    SET selected_release_mbid = ?,
        selected_provider = ?,
        selected_provider_id = ?,
        quality = ?,
        match_status = ?,
        match_confidence = ?,
        match_method = ?,
        match_evidence = ?,
        provider_data = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE release_group_mbid = ? AND slot = ?
  `).run(
    input.releaseMbid,
    provider,
    providerAlbumId,
    offer?.quality ?? null,
    offer?.status ?? null,
    offer?.confidence ?? null,
    offer?.method ?? null,
    offer?.evidence ?? null,
    offer?.data ?? null,
    input.releaseGroupMbid,
    input.slot,
  );

  if (result.changes === 0) {
    const artist = db.prepare(`SELECT artist_mbid FROM Albums WHERE mbid = ?`)
      .get(input.releaseGroupMbid) as { artist_mbid?: string } | undefined;
    if (!artist?.artist_mbid) {
      throw new Error(`unknown release group ${input.releaseGroupMbid}`);
    }
    db.prepare(`
      INSERT INTO ReleaseGroupSlots (
        artist_mbid, release_group_mbid, slot, monitored,
        selected_release_mbid, selected_provider, selected_provider_id,
        quality, match_status, match_confidence, match_method, match_evidence, provider_data
      ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artist.artist_mbid,
      input.releaseGroupMbid,
      input.slot,
      input.releaseMbid,
      provider,
      providerAlbumId,
      offer?.quality ?? null,
      offer?.status ?? null,
      offer?.confidence ?? null,
      offer?.method ?? null,
      offer?.evidence ?? null,
      offer?.data ?? null,
    );
  }

  return getReleaseGroupAvailability(input.releaseGroupMbid);
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
      ar.disambiguation   AS disambiguation,
      ar.status           AS release_status,
      ar.date             AS date,
      ar.country          AS country,
      ar.media_count      AS media_count,
      ar.track_count      AS track_count,
      (
        SELECT GROUP_CONCAT(format_label, ', ')
        FROM (
          SELECT
            CASE
              WHEN COUNT(*) > 1 THEN CAST(COUNT(*) AS TEXT) || 'x' || COALESCE(NULLIF(TRIM(format), ''), 'Unknown')
              ELSE COALESCE(NULLIF(TRIM(format), ''), 'Unknown')
            END AS format_label,
            MIN(position) AS first_position
          FROM AlbumReleaseMedia
          WHERE release_mbid = ar.mbid
            AND position > 0
          GROUP BY COALESCE(NULLIF(TRIM(format), ''), 'Unknown')
          ORDER BY first_position
        )
      ) AS release_format,
      (
        SELECT CAST(ROUND(SUM(COALESCE(length_ms, 0)) / 1000.0) AS INTEGER)
        FROM Tracks
        WHERE release_mbid = ar.mbid
      ) AS duration_seconds,
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
    disambiguation: string | null;
    release_status: string | null;
    date: string | null;
    country: string | null;
    release_format: string | null;
    media_count: number | null;
    track_count: number | null;
    duration_seconds: number | null;
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
      rel = {
        releaseMbid: r.release_mbid,
        title: r.title,
        disambiguation: r.disambiguation,
        status: r.release_status,
        date: r.date,
        country: r.country,
        format: r.release_format,
        mediumCount: r.media_count,
        trackCount: r.track_count,
        duration: r.duration_seconds,
        availability: [],
      };
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
