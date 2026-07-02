import { db } from "../../database.js";
import { servarrMetadata, type LidarrArtist } from "./servarr-metadata.js";
import type { ProviderArtist } from "../providers/streaming-provider.js";
import { providerResourceKey } from "./provider-url-identity.js";

export type ProviderArtistIdentityInput = {
  provider?: string | null;
  providerId: string;
  name: string;
  picture?: string | null;
  providerUrl?: string | null;
  providerUrls?: string[] | null;
  popularity?: number | null;
  mbid?: string | null;
  raw?: unknown;
};

export type ProviderArtistIdentityResolution = {
  mbid: string | null;
  status: "verified" | "probable" | "ambiguous" | "provider_only";
  confidence: number;
  method: string;
  reason?: string;
};

export function normalizeProviderArtist(artist: ProviderArtist): ProviderArtistIdentityInput {
  const raw = artist.raw && typeof artist.raw === "object" ? artist.raw as Record<string, unknown> : null;
  return {
    providerId: artist.providerId,
    name: artist.name,
    picture: artist.picture || null,
    providerUrl: artist.url || null,
    popularity: artist.popularity ?? null,
    mbid: typeof raw?.mbid === "string" ? raw.mbid : null,
    raw: artist.raw,
  };
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function collectCandidateSearchNames(candidate: LidarrArtist): Array<{ value: string; source: "name" | "sort-name" | "alias" }> {
  const rawAliases = [
    ...((candidate.artistaliases || []) as string[]),
    ...((candidate.artistAliases || []) as string[]),
  ];
  const seen = new Set<string>();
  const names: Array<{ value: string; source: "name" | "sort-name" | "alias" }> = [
    { value: candidate.artistname || "", source: "name" },
    { value: candidate.sortname || "", source: "sort-name" },
    ...rawAliases.map((value) => ({ value, source: "alias" as const })),
  ];

  return names
    .map((entry) => ({ ...entry, value: normalizeSearchText(entry.value) }))
    .filter((entry) => {
      if (!entry.value || seen.has(entry.value)) {
        return false;
      }
      seen.add(entry.value);
      return true;
    });
}

function scoreCandidateSearchName(normalizedProviderName: string, candidateName: string, source: "name" | "sort-name" | "alias"): number {
  if (candidateName === normalizedProviderName) {
    return source === "alias" ? 9_500 : 10_000;
  }
  if (candidateName.startsWith(`${normalizedProviderName} `)) {
    return source === "alias" ? 7_500 : 5_000;
  }
  return 0;
}

function scoreCanonicalArtistCandidate(normalizedProviderName: string, candidate: LidarrArtist): {
  score: number;
  method: "musicbrainz-artist-name-exact" | "musicbrainz-artist-alias-exact" | "musicbrainz-artist-alias-prefix" | "musicbrainz-artist-name-prefix" | null;
} {
  let best = { score: 0, method: null as ReturnType<typeof scoreCanonicalArtistCandidate>["method"] };
  for (const name of collectCandidateSearchNames(candidate)) {
    const score = scoreCandidateSearchName(normalizedProviderName, name.value, name.source);
    if (score <= best.score) {
      continue;
    }
    const isExact = name.value === normalizedProviderName;
    best = {
      score,
      method: isExact
        ? (name.source === "alias" ? "musicbrainz-artist-alias-exact" : "musicbrainz-artist-name-exact")
        : (name.source === "alias" ? "musicbrainz-artist-alias-prefix" : "musicbrainz-artist-name-prefix"),
    };
  }

  return best;
}

function candidateLinkValues(candidate: LidarrArtist): string[] {
  const links = Array.isArray(candidate.links) ? candidate.links : [];
  return links
    .flatMap((link) => {
      if (typeof link === "string") return [link];
      if (!link || typeof link !== "object") return [];
      return Object.values(link as Record<string, unknown>)
        .filter((value): value is string => typeof value === "string");
    })
    .filter(Boolean);
}

function providerArtistResourceKeys(provider: string | null | undefined, providerArtist: ProviderArtistIdentityInput): Set<string> {
  const keys = new Set<string>();
  const providerName = provider || providerArtist.provider || null;
  for (const value of [providerArtist.providerId, providerArtist.providerUrl, ...(providerArtist.providerUrls || [])]) {
    const key = providerResourceKey(value, { provider: providerName, type: "artist" });
    if (key) {
      keys.add(key);
    }
  }
  return keys;
}

export function bestCanonicalArtistMatch(providerArtist: ProviderArtistIdentityInput, candidates: LidarrArtist[], provider?: string | null): {
  artist: LidarrArtist;
  status: "verified" | "probable";
  confidence: number;
  method: string;
} | null {
  const normalizedName = normalizeSearchText(providerArtist.name);
  const providerKeys = providerArtistResourceKeys(provider, providerArtist);
  const scoredMatches = candidates
    .map((candidate) => {
      const base = scoreCanonicalArtistCandidate(normalizedName, candidate);
      const albumCount = candidate.Albums?.length || 0;
      const candidateKeys = candidateLinkValues(candidate)
        .map((url) => providerResourceKey(url))
        .filter(Boolean);
      const linkMatched = providerKeys.size > 0 && candidateKeys.some((key) => providerKeys.has(key));
      return {
        artist: candidate,
        score: (linkMatched ? 20_000 : base.score) + Math.min(albumCount, 500),
        baseScore: linkMatched ? 20_000 : base.score,
        albumCount,
        method: linkMatched ? "musicbrainz-artist-url" as const : base.method,
      };
    })
    .filter((candidate) => candidate.baseScore > 0 && candidate.method)
    .sort((left, right) => right.score - left.score);

  if (scoredMatches.length === 0) {
    return null;
  }

  if (scoredMatches.length === 1) {
    return {
      artist: scoredMatches[0].artist,
      status: scoredMatches[0].baseScore >= 9_500 ? "verified" : "probable",
      confidence: scoredMatches[0].baseScore >= 9_500 ? 1 : 0.82,
      method: scoredMatches[0].method!,
    };
  }

  const [best, second] = scoredMatches;
  if (best.baseScore >= 9_500 && best.baseScore > second.baseScore) {
    return {
      artist: best.artist,
      status: "verified",
      confidence: 1,
      method: best.method!,
    };
  }

  if (
    best.baseScore >= 7_500
    && best.score >= second.score + 250
    && best.albumCount >= second.albumCount + 25
  ) {
    return {
      artist: best.artist,
      status: "probable",
      confidence: 0.84,
      method: best.method!,
    };
  }

  const bestHasDisambiguation = String(best.artist.disambiguation || "").trim().length > 0;
  const secondHasDisambiguation = String(second.artist.disambiguation || "").trim().length > 0;
  if (
    best.baseScore >= 10_000
    && best.albumCount >= second.albumCount + 5
    && (!bestHasDisambiguation || secondHasDisambiguation)
  ) {
    return {
      artist: best.artist,
      status: "probable",
      confidence: 0.78,
      method: "musicbrainz-artist-name-discography-weight",
    };
  }

  return null;
}

/**
 * Album titles normalized for cross-catalog comparison: provider titles carry
 * edition noise MusicBrainz release-group titles don't ("Deluxe Edition",
 * "(Remastered)", "[Explicit]"), so strip bracketed segments before the usual
 * search normalization.
 */
function normalizeAlbumTitleForOverlap(title: string): string {
  return normalizeSearchText(
    String(title || "")
      .replace(/\((?:[^)]*)\)/g, " ")
      .replace(/\[(?:[^\]]*)\]/g, " "),
  );
}

/**
 * How many of the provider artist's album titles appear in a MusicBrainz
 * candidate's release-group list. Name evidence can't separate same-named
 * artists (Eden, Japan, Ellis Hall …), but two different artists essentially
 * never share several album titles — so overlap is strong disambiguation
 * evidence. The MB side is free: Servarr artist-search results already embed
 * each candidate's release groups.
 */
export function scoreDiscographyOverlap(providerAlbumTitles: string[], candidate: LidarrArtist): { matched: number; sampled: number } {
  const providerTitles = new Set(
    providerAlbumTitles
      .map(normalizeAlbumTitleForOverlap)
      .filter((title) => title.length > 2),
  );
  if (providerTitles.size === 0) {
    return { matched: 0, sampled: 0 };
  }

  const candidateTitles = new Set(
    (candidate.Albums || [])
      .map((album) => normalizeAlbumTitleForOverlap(album.Title || ""))
      .filter((title) => title.length > 2),
  );

  let matched = 0;
  for (const title of providerTitles) {
    if (candidateTitles.has(title)) {
      matched += 1;
    }
  }
  return { matched, sampled: providerTitles.size };
}

/**
 * Pick a candidate by discography overlap when name/URL evidence was
 * inconclusive. Conservative: the winner needs at least two shared album
 * titles AND a clear margin over the runner-up, so shared compilations or a
 * single coincidental title can't flip an identity.
 */
export function bestDiscographyOverlapMatch(providerAlbumTitles: string[], candidates: LidarrArtist[]): {
  artist: LidarrArtist;
  status: "probable";
  confidence: number;
  method: string;
} | null {
  if (providerAlbumTitles.length === 0 || candidates.length === 0) {
    return null;
  }

  const scored = candidates
    .map((candidate) => ({ candidate, ...scoreDiscographyOverlap(providerAlbumTitles, candidate) }))
    .sort((left, right) => right.matched - left.matched);

  const best = scored[0];
  const runnerUp = scored[1];
  const runnerUpMatched = runnerUp?.matched ?? 0;

  if (best.matched >= 2 && best.matched >= runnerUpMatched + 2) {
    return {
      artist: best.candidate,
      status: "probable",
      confidence: best.matched >= 5 ? 0.9 : 0.8,
      method: "provider-discography-overlap",
    };
  }

  return null;
}

export interface ResolveProviderArtistOptions {
  /**
   * Lazily fetch the provider artist's album titles (one provider API call).
   * Only invoked when name/alias/URL evidence could not settle the identity,
   * so the common case pays nothing.
   */
  listProviderAlbumTitles?: () => Promise<string[]>;
}

export class ProviderArtistIdentityService {
  static async resolve(provider: string, artist: ProviderArtistIdentityInput, options?: ResolveProviderArtistOptions): Promise<ProviderArtistIdentityResolution> {
    const cached = db.prepare(`
      SELECT artist_mbid, match_status, match_confidence, match_method
      FROM ProviderItems
      WHERE provider = ?
        AND entity_type = 'artist'
        AND provider_id = ?
        AND artist_mbid IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(provider, artist.providerId) as {
      artist_mbid?: string | null;
      match_status?: string | null;
      match_confidence?: number | null;
      match_method?: string | null;
    } | undefined;

    if (cached?.artist_mbid) {
      return {
        mbid: cached.artist_mbid,
        status: cached.match_status === "probable" ? "probable" : "verified",
        confidence: cached.match_confidence ?? 1,
        method: cached.match_method || "provider-artist-cache",
      };
    }

    if (artist.mbid) {
      return {
        mbid: artist.mbid,
        status: "verified",
        confidence: 1,
        method: "provider-musicbrainz-id",
      };
    }

    try {
      const candidates = await servarrMetadata.searchForNewArtist(artist.name, 10);
      const match = bestCanonicalArtistMatch(artist, candidates, provider);

      if (match) {
        return {
          mbid: match.artist.id,
          status: match.status,
          confidence: match.confidence,
          method: match.method,
        };
      }

      // Name/alias/URL evidence was inconclusive. Before giving up, compare
      // discographies: fetch the provider artist's album titles (one API call)
      // and look for a candidate whose release groups clearly share them.
      if (options?.listProviderAlbumTitles && candidates.length > 0) {
        try {
          const providerAlbumTitles = (await options.listProviderAlbumTitles()).slice(0, 50);
          const overlapMatch = bestDiscographyOverlapMatch(providerAlbumTitles, candidates);
          if (overlapMatch) {
            return {
              mbid: overlapMatch.artist.id,
              status: overlapMatch.status,
              confidence: overlapMatch.confidence,
              method: overlapMatch.method,
            };
          }
        } catch (error) {
          console.warn(`[ProviderArtistIdentityService] Discography comparison for ${artist.name} failed:`, error);
        }
      }

      const normalizedName = normalizeSearchText(artist.name);
      const exactCount = candidates.filter((candidate) => normalizeSearchText(candidate.artistname || "") === normalizedName).length;
      if (exactCount > 1) {
        return {
          mbid: null,
          status: "ambiguous",
          confidence: 0,
          method: "musicbrainz-artist-name-ambiguous",
          reason: "musicbrainz_ambiguous",
        };
      }
    } catch (error) {
      console.warn(`[ProviderArtistIdentityService] Failed to match ${artist.name} to canonical metadata:`, error);
    }

    return {
      mbid: null,
      status: "provider_only",
      confidence: 0,
      method: "provider-artist-unmatched",
      reason: "musicbrainz_unmatched",
    };
  }

  static store(provider: string, artist: ProviderArtistIdentityInput, resolution: ProviderArtistIdentityResolution, _localArtistId?: string | null): void {
    db.prepare(`
      INSERT INTO ProviderItems (
        provider, entity_type, provider_id, artist_mbid,
        title, match_status, match_confidence, match_method, data, updated_at
      )
      VALUES (?, 'artist', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(provider, entity_type, provider_id) DO UPDATE SET
        artist_mbid = COALESCE(excluded.artist_mbid, ProviderItems.artist_mbid),
        title = excluded.title,
        match_status = excluded.match_status,
        match_confidence = excluded.match_confidence,
        match_method = excluded.match_method,
        data = excluded.data,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      provider,
      artist.providerId,
      resolution.mbid || null,
      artist.name,
      resolution.status,
      resolution.confidence,
      resolution.method,
      JSON.stringify({
        picture: artist.picture || null,
        providerUrl: artist.providerUrl || null,
        providerUrls: artist.providerUrls || null,
        popularity: artist.popularity ?? null,
      }),
    );
  }

  /**
   * Provider artists with no MusicBrainz identity — the ones a provider import
   * saw but could not monitor (Lidarr surfaces the same set as unmatched
   * import-list items). Read-only; used by the System Status page so a
   * "531 followed, 494 monitored" gap is explainable in the UI.
   */
  static listUnmatched(): Array<{
    provider: string;
    providerId: string;
    name: string;
    status: string;
    method: string;
    updatedAt: string | null;
  }> {
    const rows = db.prepare(`
      SELECT provider, provider_id, title, match_status, match_method, updated_at
      FROM ProviderItems
      WHERE entity_type = 'artist' AND artist_mbid IS NULL
      ORDER BY title COLLATE NOCASE ASC
    `).all() as Array<{
      provider: string;
      provider_id: string;
      title?: string | null;
      match_status?: string | null;
      match_method?: string | null;
      updated_at?: string | null;
    }>;

    return rows.map((row) => ({
      provider: row.provider,
      providerId: row.provider_id,
      name: row.title || row.provider_id,
      status: row.match_status || "provider_only",
      method: row.match_method || "unknown",
      updatedAt: row.updated_at ?? null,
    }));
  }
}
