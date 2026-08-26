import { db } from "../../database.js";
import { streamingProviderManager } from "./index.js";
import type { StreamingProvider } from "./streaming-provider.js";

export type ProviderEditorialCandidate = {
  provider: string;
  providerId: string;
};

export type ProviderEditorialText = {
  text: string;
  source: string;
};

function trimEditorialText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function splitHybridProviderIds(value: unknown): string[] {
  return String(value || "")
    .split(/[;+]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function sortCandidatesByProviderPriority(
  candidates: ProviderEditorialCandidate[],
): ProviderEditorialCandidate[] {
  return [...candidates].sort(
    (left, right) =>
      streamingProviderManager.getProviderPreferenceRank(left.provider)
      - streamingProviderManager.getProviderPreferenceRank(right.provider)
      || left.provider.localeCompare(right.provider)
      || left.providerId.localeCompare(right.providerId),
  );
}

function uniqueCandidates(
  candidates: ProviderEditorialCandidate[],
): ProviderEditorialCandidate[] {
  const seen = new Set<string>();
  const out: ProviderEditorialCandidate[] = [];
  for (const candidate of candidates) {
    const provider = String(candidate.provider || "").trim();
    for (const providerId of splitHybridProviderIds(candidate.providerId)) {
      const key = `${provider}:${providerId}`;
      if (!provider || !providerId || seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({ provider, providerId });
    }
  }
  return out;
}

function resolveEditorialProvider(providerId: string): StreamingProvider | null {
  try {
    const provider = streamingProviderManager.getStreamingProvider(providerId);
    if (typeof provider.isAuthenticated === "function" && !provider.isAuthenticated()) {
      return null;
    }
    if (provider.capabilities?.editorialMetadata !== true) {
      return null;
    }
    return provider;
  } catch {
    return null;
  }
}

export type ProviderEditorialLookup = {
  editorial: ProviderEditorialText | null;
  /** How many provider bio/review endpoints were actually called. */
  attempted: number;
};

/**
 * First non-empty editorial text among candidates, ordered by
 * `streaming.provider_priority` (settings list order).
 */
export async function lookupProviderEditorialText(opts: {
  kind: "artistBio" | "albumReview";
  candidates: ProviderEditorialCandidate[];
}): Promise<ProviderEditorialLookup> {
  const ordered = sortCandidatesByProviderPriority(uniqueCandidates(opts.candidates));
  let attempted = 0;

  for (const candidate of ordered) {
    const provider = resolveEditorialProvider(candidate.provider);
    if (!provider) {
      continue;
    }

    attempted += 1;
    try {
      const raw = opts.kind === "artistBio"
        ? await provider.getArtistBio?.(candidate.providerId)
        : await provider.getAlbumReview?.(candidate.providerId);
      const text = trimEditorialText(raw);
      if (text) {
        return { editorial: { text, source: provider.id }, attempted };
      }
    } catch (error) {
      console.warn(
        `[provider-editorial] ${opts.kind} failed for ${candidate.provider}:${candidate.providerId}:`,
        error,
      );
    }
  }

  return { editorial: null, attempted };
}

export async function firstProviderEditorialText(opts: {
  kind: "artistBio" | "albumReview";
  candidates: ProviderEditorialCandidate[];
}): Promise<ProviderEditorialText | null> {
  return (await lookupProviderEditorialText(opts)).editorial;
}

/** Matched album offers for a release group, ready for priority-ordered review fetch. */
export function listReleaseGroupAlbumOfferCandidates(
  releaseGroupMbid: string,
): ProviderEditorialCandidate[] {
  // There is no entity_type 'album' and no release_group_mbid shadow column:
  // a provider edition reaches its album through its accepted typed match.
  const rows = db.prepare(`
    SELECT DISTINCT item.provider, CAST(item.provider_id AS TEXT) AS provider_id
    FROM ProviderItems item
    JOIN ProviderEditionMatches edition_match
      ON edition_match.provider_edition_item_id = item.id
     AND edition_match.match_state = 'accepted'
    JOIN AlbumEditions edition ON edition.id = edition_match.edition_id
    JOIN Albums album ON album.id = edition.release_group_id
    WHERE item.entity_type = 'release'
      AND album.mbid = ?
      AND item.provider_id IS NOT NULL
  `).all(releaseGroupMbid) as Array<{ provider?: string | null; provider_id?: string | number | null }>;

  return rows.map((row) => ({
    provider: String(row.provider || "").trim(),
    providerId: String(row.provider_id ?? "").trim(),
  }));
}
