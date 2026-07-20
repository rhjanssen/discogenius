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

/**
 * First non-empty editorial text among candidates, ordered by
 * `streaming.provider_priority` (settings list order).
 */
export async function firstProviderEditorialText(opts: {
  kind: "artistBio" | "albumReview";
  candidates: ProviderEditorialCandidate[];
}): Promise<ProviderEditorialText | null> {
  const ordered = sortCandidatesByProviderPriority(uniqueCandidates(opts.candidates));

  for (const candidate of ordered) {
    const provider = resolveEditorialProvider(candidate.provider);
    if (!provider) {
      continue;
    }

    try {
      const raw = opts.kind === "artistBio"
        ? await provider.getArtistBio?.(candidate.providerId)
        : await provider.getAlbumReview?.(candidate.providerId);
      const text = trimEditorialText(raw);
      if (text) {
        return { text, source: provider.id };
      }
    } catch (error) {
      console.warn(
        `[provider-editorial] ${opts.kind} failed for ${candidate.provider}:${candidate.providerId}:`,
        error,
      );
    }
  }

  return null;
}

/** Matched album offers for a release group, ready for priority-ordered review fetch. */
export function listReleaseGroupAlbumOfferCandidates(
  releaseGroupMbid: string,
): ProviderEditorialCandidate[] {
  const rows = db.prepare(`
    SELECT provider, provider_id
    FROM ProviderItems
    WHERE entity_type = 'album'
      AND release_group_mbid = ?
      AND provider_id IS NOT NULL
  `).all(releaseGroupMbid) as Array<{ provider?: string | null; provider_id?: string | number | null }>;

  return rows.map((row) => ({
    provider: String(row.provider || "").trim(),
    providerId: String(row.provider_id ?? "").trim(),
  }));
}
