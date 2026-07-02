import { db } from "../../database.js";
import { servarrMetadata, type LidarrArtist } from "./servarr-metadata.js";
import {
  ProviderArtistIdentityService,
  intersectDiscographyTitles,
  bestCanonicalArtistMatch,
} from "./provider-artist-identity-service.js";
import { ensureMonitoredArtist } from "../providers/followed-artists-import.js";
import { queueArtistMonitoringIntake } from "../music/artist-monitoring.js";
import { isMusicBrainzMbid } from "../music/refresh-artist-service.js";
import { streamingProviderManager } from "../providers/index.js";

/**
 * Manual remediation for provider artists automation could not match — the
 * human-in-the-loop half of the import pipeline, like Lidarr's manual mapping
 * of unmatched import-list items. Candidates are ranked with the SAME evidence
 * the automatic matcher uses (name/alias scoring + discography overlap), but
 * presented instead of auto-applied, so a person can settle what automation
 * correctly refused to guess.
 */

export interface ManualMatchCandidate {
  mbid: string;
  name: string;
  disambiguation: string | null;
  type: string | null;
  releaseCount: number;
  /** Album titles the provider artist and this candidate share — the evidence. */
  sharedAlbums: string[];
  /** True when the automatic matcher would have scored this candidate at all. */
  nameMatched: boolean;
}

export interface ManualMatchCandidatesResult {
  provider: string;
  providerId: string;
  artistName: string;
  /** Provider albums fetched for the overlap comparison (may be empty if the provider call failed). */
  providerAlbumTitles: string[];
  candidates: ManualMatchCandidate[];
}

type ProviderArtistRow = {
  provider: string;
  provider_id: string;
  title: string | null;
  artist_mbid: string | null;
  match_status: string | null;
  data: string | null;
};

function getProviderArtistRow(provider: string, providerId: string): ProviderArtistRow | null {
  const row = db.prepare(`
    SELECT provider, provider_id, title, artist_mbid, match_status, data
    FROM ProviderItems
    WHERE provider = ? AND entity_type = 'artist' AND provider_id = ?
    LIMIT 1
  `).get(provider, providerId) as ProviderArtistRow | undefined;
  return row ?? null;
}

function parseStoredArtistData(row: ProviderArtistRow): { picture: string | null; providerUrl: string | null; popularity: number | null } {
  try {
    const parsed = JSON.parse(row.data || "{}") as Record<string, unknown>;
    return {
      picture: typeof parsed.picture === "string" ? parsed.picture : null,
      providerUrl: typeof parsed.providerUrl === "string" ? parsed.providerUrl : null,
      popularity: typeof parsed.popularity === "number" ? parsed.popularity : null,
    };
  } catch {
    return { picture: null, providerUrl: null, popularity: null };
  }
}

async function fetchProviderAlbumTitles(provider: string, providerId: string): Promise<string[]> {
  try {
    const streamingProvider = streamingProviderManager.getStreamingProvider(provider);
    const albums = await streamingProvider.getArtistAlbums(providerId);
    return albums.map((album) => String(album.title || "")).filter(Boolean).slice(0, 50);
  } catch (error) {
    console.warn(`[ManualMatch] Could not fetch ${provider} albums for ${providerId}:`, error);
    return [];
  }
}

function rankCandidates(
  artistName: string,
  providerId: string,
  providerAlbumTitles: string[],
  candidates: LidarrArtist[],
): ManualMatchCandidate[] {
  const nameMatchedIds = new Set(
    candidates
      .filter((candidate) => bestCanonicalArtistMatch({ providerId, name: artistName }, [candidate]))
      .map((candidate) => candidate.id),
  );

  return candidates
    .map((candidate) => {
      const overlap = intersectDiscographyTitles(providerAlbumTitles, candidate);
      return {
        mbid: candidate.id,
        name: candidate.artistname,
        disambiguation: String(candidate.disambiguation || "").trim() || null,
        type: candidate.type || null,
        releaseCount: candidate.Albums?.length || 0,
        sharedAlbums: overlap.matched.slice(0, 8),
        nameMatched: nameMatchedIds.has(candidate.id),
      };
    })
    .sort((left, right) =>
      right.sharedAlbums.length - left.sharedAlbums.length
      || Number(right.nameMatched) - Number(left.nameMatched)
      || right.releaseCount - left.releaseCount,
    );
}

export async function listManualMatchCandidates(provider: string, providerId: string): Promise<ManualMatchCandidatesResult> {
  const row = getProviderArtistRow(provider, providerId);
  if (!row) {
    throw new Error(`Unknown provider artist: ${provider}/${providerId}`);
  }
  const artistName = String(row.title || "").trim() || providerId;

  const [providerAlbumTitles, candidates] = await Promise.all([
    fetchProviderAlbumTitles(provider, providerId),
    servarrMetadata.searchForNewArtist(artistName, 10),
  ]);

  return {
    provider,
    providerId,
    artistName,
    providerAlbumTitles,
    candidates: rankCandidates(artistName, providerId, providerAlbumTitles, candidates),
  };
}

export interface ManualMatchResult {
  localArtistId: string;
  artistName: string;
  mbid: string;
  monitored: true;
  intakeQueued: boolean;
}

export async function applyManualArtistMatch(provider: string, providerId: string, mbid: string): Promise<ManualMatchResult> {
  if (!isMusicBrainzMbid(mbid)) {
    throw new Error(`Not a valid MusicBrainz artist id: ${mbid}`);
  }
  const row = getProviderArtistRow(provider, providerId);
  if (!row) {
    throw new Error(`Unknown provider artist: ${provider}/${providerId}`);
  }

  const stored = parseStoredArtistData(row);
  const artistName = String(row.title || "").trim() || providerId;

  // Same sequence as the automatic import path so manually matched artists are
  // indistinguishable from automatically matched ones.
  const result = await ensureMonitoredArtist({
    provider_id: providerId,
    name: artistName,
    picture: stored.picture,
    provider_url: stored.providerUrl,
    popularity: stored.popularity,
    mbid,
    match_status: "verified",
    match_confidence: 1,
    match_method: "manual",
  });
  if (!result.localArtistId) {
    throw new Error(`Could not create the local artist for ${artistName} (${mbid})`);
  }

  ProviderArtistIdentityService.store(provider, {
    providerId,
    name: artistName,
    picture: stored.picture,
    providerUrl: stored.providerUrl,
    popularity: stored.popularity,
    mbid,
  }, {
    mbid,
    status: "verified",
    confidence: 1,
    method: "manual",
  }, result.localArtistId);

  let intakeQueued = false;
  try {
    intakeQueued = queueArtistMonitoringIntake({ artistId: result.localArtistId, artistName }) !== -1;
  } catch (error) {
    console.warn(`[ManualMatch] Could not queue intake for ${artistName}:`, error);
  }

  return {
    localArtistId: result.localArtistId,
    artistName,
    mbid,
    monitored: true,
    intakeQueued,
  };
}

/**
 * Hide a provider artist from the unmatched list without inventing an
 * identity — for entries that have no MusicBrainz artist to match (karaoke
 * channels, misspelled duplicates, playlist pseudo-artists).
 */
export function ignoreProviderArtist(provider: string, providerId: string): { ignored: boolean } {
  const result = db.prepare(`
    UPDATE ProviderItems
    SET match_status = 'ignored', match_method = 'manual-ignore', updated_at = CURRENT_TIMESTAMP
    WHERE provider = ? AND entity_type = 'artist' AND provider_id = ? AND artist_mbid IS NULL
  `).run(provider, providerId);
  if (result.changes === 0) {
    throw new Error(`Unknown or already matched provider artist: ${provider}/${providerId}`);
  }
  return { ignored: true };
}
