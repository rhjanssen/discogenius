import { db } from "../../database.js";
import { ProviderCatalogRepository } from "../providers/provider-catalog-repository.js";
import { ProviderMatchRepository } from "../music/provider-match-repository.js";
import type { LidarrArtist } from "./servarr-metadata.js";
import { catalogProviderRegistry } from "../catalog/index.js";
import type { ProviderArtist } from "../providers/streaming-provider.js";
import { providerResourceKey } from "./provider-url-identity.js";
import {
  matchProviderAlbumToReleaseGroup,
  type MusicBrainzReleaseGroupForMatching,
  type ProviderAlbumForReleaseGroupMatching,
} from "./provider-release-group-matcher.js";

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

export type ProviderArtistEvidenceAlbum = {
  provider?: string | null;
  providerId?: string | null;
  title: string;
  releaseDate?: string | null;
  type?: string | null;
  upc?: string | null;
  trackCount?: number | null;
  volumeCount?: number | null;
  isrcs?: string[] | null;
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
 * The provider artist's album titles that appear in a MusicBrainz candidate's
 * release-group list, deduped by normalized title. Name evidence can't
 * separate same-named artists (Eden, Japan, Ellis Hall …), but two different
 * artists essentially never share several album titles — so overlap is strong
 * disambiguation evidence. The MB side is free: Servarr artist-search results
 * already embed each candidate's release groups. Returns the matched
 * candidate-side titles so callers can show the evidence to a human.
 */
export function intersectDiscographyTitles(providerAlbumTitles: string[], candidate: LidarrArtist): { matched: string[]; sampled: number } {
  const providerTitles = new Set(
    providerAlbumTitles
      .map(normalizeAlbumTitleForOverlap)
      .filter((title) => title.length > 2),
  );
  if (providerTitles.size === 0) {
    return { matched: [], sampled: 0 };
  }

  const matched: string[] = [];
  const seen = new Set<string>();
  for (const album of candidate.Albums || []) {
    const normalized = normalizeAlbumTitleForOverlap(album.Title || "");
    if (normalized.length > 2 && providerTitles.has(normalized) && !seen.has(normalized)) {
      seen.add(normalized);
      matched.push(album.Title || "");
    }
  }
  return { matched, sampled: providerTitles.size };
}

export function scoreDiscographyOverlap(providerAlbumTitles: string[], candidate: LidarrArtist): { matched: number; sampled: number } {
  const { matched, sampled } = intersectDiscographyTitles(providerAlbumTitles, candidate);
  return { matched: matched.length, sampled };
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

type SearchAllAlbumRow = {
  id?: string;
  Id?: string;
  title?: string;
  Title?: string;
  type?: string | null;
  Type?: string | null;
  secondarytypes?: string[];
  SecondaryTypes?: string[];
  releasedate?: string | null;
  ReleaseDate?: string | null;
  disambiguation?: string | null;
  Disambiguation?: string | null;
  artistid?: string | null;
  artistId?: string | null;
  artists?: unknown[];
  Releases?: unknown[];
  releases?: unknown[];
};

function uniqueByArtistId(candidates: LidarrArtist[]): LidarrArtist[] {
  const byId = new Map<string, LidarrArtist>();
  for (const candidate of candidates) {
    if (candidate?.id && !byId.has(candidate.id)) {
      byId.set(candidate.id, candidate);
    }
  }
  return Array.from(byId.values());
}

function mapSearchArtist(value: unknown): LidarrArtist | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const id = String(raw.id || "").trim();
  const artistname = String(raw.artistname || raw.name || "").trim();
  if (!id || !artistname) {
    return null;
  }
  return {
    id,
    artistname,
    sortname: String(raw.sortname || raw["sort-name"] || artistname),
    artistaliases: Array.isArray(raw.artistaliases) ? raw.artistaliases.map(String) : [],
    artistAliases: Array.isArray(raw.artistAliases) ? raw.artistAliases.map(String) : [],
    links: Array.isArray(raw.links) ? raw.links as LidarrArtist["links"] : [],
    disambiguation: typeof raw.disambiguation === "string" ? raw.disambiguation : undefined,
    type: typeof raw.type === "string" ? raw.type : undefined,
    images: Array.isArray(raw.images) ? raw.images as LidarrArtist["images"] : [],
    Albums: Array.isArray(raw.Albums) ? raw.Albums as LidarrArtist["Albums"] : [],
  };
}

function searchRowArtists(row: unknown): LidarrArtist[] {
  if (!row || typeof row !== "object") {
    return [];
  }
  const raw = row as Record<string, unknown>;
  const artists: LidarrArtist[] = [];
  const direct = mapSearchArtist(raw.artist);
  if (direct) {
    artists.push(direct);
  }
  const album = raw.album as SearchAllAlbumRow | undefined;
  for (const artist of Array.isArray(album?.artists) ? album.artists : []) {
    const mapped = mapSearchArtist(artist);
    if (mapped) {
      artists.push(mapped);
    }
  }
  const albumArtistId = String(album?.artistid || album?.artistId || "").trim();
  if (albumArtistId && artists.length === 0) {
    artists.push({
      id: albumArtistId,
      artistname: "",
      sortname: "",
      images: [],
      Albums: [],
    });
  }
  return uniqueByArtistId(artists).filter((artist) => artist.artistname);
}

function searchRowReleaseGroup(row: unknown): MusicBrainzReleaseGroupForMatching | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const album = (row as Record<string, unknown>).album as SearchAllAlbumRow | undefined;
  const id = String(album?.id || album?.Id || "").trim();
  const title = String(album?.title || album?.Title || "").trim();
  if (!album || !id || !title) {
    return null;
  }
  const releases = (Array.isArray(album.Releases) ? album.Releases : Array.isArray(album.releases) ? album.releases : [])
    .filter((release): release is Record<string, unknown> => Boolean(release && typeof release === "object"))
    .map((release) => {
      const rawTracks = Array.isArray(release.Tracks) ? release.Tracks : [];
      const isrcs = rawTracks
        .flatMap((track) => {
          if (!track || typeof track !== "object") return [];
          const raw = track as Record<string, unknown>;
          const values = [raw.isrc, raw.ISRC, raw.Isrc, raw.isrcs, raw.ISRCs];
          return values.flatMap((value) => Array.isArray(value) ? value : [value]);
        })
        .map((value) => String(value || "").trim())
        .filter(Boolean);
      return {
        mbid: String(release.Id || release.id || ""),
        title: typeof release.Title === "string" ? release.Title : typeof release.title === "string" ? release.title : null,
        disambiguation: typeof release.Disambiguation === "string" ? release.Disambiguation : typeof release.disambiguation === "string" ? release.disambiguation : null,
        barcode: typeof release.Barcode === "string" ? release.Barcode : typeof release.barcode === "string" ? release.barcode : null,
        date: typeof release.ReleaseDate === "string" ? release.ReleaseDate : typeof release.date === "string" ? release.date : null,
        trackCount: Number(release.TrackCount ?? release.trackCount ?? rawTracks.length) || null,
        mediaCount: Number(release.MediaCount ?? release.MediumCount ?? release.mediaCount ?? release.mediumCount) || null,
        externalUrls: Array.isArray(release.ExternalUrls) ? release.ExternalUrls.map(String) : [],
        isrcs,
      };
    })
    .filter((release) => release.mbid);

  return {
    mbid: id,
    title,
    primaryType: album.type ?? album.Type ?? null,
    secondaryTypes: Array.isArray(album.secondarytypes) ? album.secondarytypes : Array.isArray(album.SecondaryTypes) ? album.SecondaryTypes : [],
    firstReleaseDate: album.releasedate ?? album.ReleaseDate ?? null,
    disambiguation: album.disambiguation ?? album.Disambiguation ?? null,
    releases,
  };
}

function providerAlbumForReleaseMatcher(provider: string | null | undefined, album: ProviderArtistEvidenceAlbum): ProviderAlbumForReleaseGroupMatching {
  return {
    provider: provider ?? album.provider ?? null,
    providerId: String(album.providerId || album.title),
    title: album.title,
    releaseDate: album.releaseDate ?? null,
    type: album.type ?? null,
    upc: album.upc ?? null,
    isrcs: album.isrcs ?? null,
    trackCount: album.trackCount ?? null,
    volumeCount: album.volumeCount ?? null,
  };
}

function releaseEvidenceSearchTitle(title: string): string {
  return String(title || "")
    .replace(/\((?:[^)]*)\)/g, " ")
    .replace(/\[(?:[^\]]*)\]/g, " ")
    .replace(/\s+(?:[-:–—])\s+(?:remix|radio edit|single version|deluxe|expanded|remastered).*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function releaseEvidenceSample(albums: ProviderArtistEvidenceAlbum[]): ProviderArtistEvidenceAlbum[] {
  return albums
    .map((album) => ({ ...album, title: String(album.title || "").trim() }))
    .filter((album) => album.title.length > 0)
    .sort((left, right) => {
      const leftTitle = releaseEvidenceSearchTitle(left.title);
      const rightTitle = releaseEvidenceSearchTitle(right.title);
      const leftTooLong = leftTitle.length > 80 ? 1 : 0;
      const rightTooLong = rightTitle.length > 80 ? 1 : 0;
      return leftTooLong - rightTooLong
        || leftTitle.length - rightTitle.length
        || String(left.releaseDate || "").localeCompare(String(right.releaseDate || ""))
        || left.title.localeCompare(right.title);
    })
    .slice(0, 6);
}

function sortReleaseEvidenceCandidates(candidates: Iterable<ProviderArtistReleaseEvidenceCandidate>): ProviderArtistReleaseEvidenceCandidate[] {
  return Array.from(candidates)
    .sort((left, right) =>
      right.upcMatches - left.upcMatches
      || right.isrcMatches - left.isrcMatches
      || right.matchedAlbumTitles.length - left.matchedAlbumTitles.length
      || right.score - left.score
      || left.artist.id.localeCompare(right.artist.id));
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function artistNameCompatible(providerArtistName: string, candidateArtistName: string): boolean {
  const providerName = normalizeSearchText(providerArtistName);
  const candidateName = normalizeSearchText(candidateArtistName);
  if (!providerName || !candidateName) {
    return false;
  }
  return candidateName === providerName
    || candidateName.startsWith(`${providerName} `)
    || providerName.startsWith(`${candidateName} `);
}

export type ProviderArtistReleaseEvidenceCandidate = {
  artist: LidarrArtist;
  matchedAlbumTitles: string[];
  upcMatches: number;
  isrcMatches: number;
  score: number;
};

export async function findArtistCandidatesByProviderReleaseEvidence(
  providerArtist: ProviderArtistIdentityInput,
  providerAlbums: ProviderArtistEvidenceAlbum[],
  provider?: string | null,
): Promise<ProviderArtistReleaseEvidenceCandidate[]> {
  const scored = new Map<string, ProviderArtistReleaseEvidenceCandidate>();
  const sample = releaseEvidenceSample(providerAlbums);

  for (let index = 0; index < sample.length; index += 1) {
    const album = sample[index];
    if (index > 0) {
      await delay(350);
    }
    let searchRows: Array<{ releaseGroup: MusicBrainzReleaseGroupForMatching; artists: LidarrArtist[] }> = [];
    try {
      const searchResults = await catalogProviderRegistry.getActive().search(
        `${providerArtist.name} ${releaseEvidenceSearchTitle(album.title)}`,
        { limit: 25 },
      );
      searchRows = [
        ...(searchResults.releaseGroups || []).map((releaseGroup) => ({
          releaseGroup: {
            mbid: releaseGroup.mbid,
            title: releaseGroup.title,
            primaryType: null,
            secondaryTypes: [],
            firstReleaseDate: releaseGroup.releaseDate ?? null,
            disambiguation: releaseGroup.disambiguation ?? null,
            releases: [],
          },
          artists: releaseGroup.artistMbid
            ? [{
                id: releaseGroup.artistMbid,
                artistname: releaseGroup.artistName || "",
                sortname: releaseGroup.artistName || "",
                images: [],
                Albums: [],
              }]
            : searchResults.artists,
        })),
        ...(searchResults.raw || [])
          .map((row) => {
            const releaseGroup = searchRowReleaseGroup(row);
            return releaseGroup ? { releaseGroup, artists: searchRowArtists(row) } : null;
          })
          .filter((row): row is { releaseGroup: MusicBrainzReleaseGroupForMatching; artists: LidarrArtist[] } => Boolean(row)),
      ];
    } catch (error) {
      console.warn(`[ProviderArtistIdentityService] Release-evidence search failed for ${providerArtist.name} / ${album.title}:`, error);
      continue;
    }
    const providerAlbum = providerAlbumForReleaseMatcher(provider, album);
    for (const row of searchRows) {
      const match = matchProviderAlbumToReleaseGroup(providerAlbum, [row.releaseGroup]);
      if (match.status === "unmatched" || match.confidence < 0.78) {
        continue;
      }
      for (const artist of row.artists) {
        if (!artistNameCompatible(providerArtist.name, artist.artistname)) {
          continue;
        }
        const current = scored.get(artist.id) || {
          artist,
          matchedAlbumTitles: [],
          upcMatches: 0,
          isrcMatches: 0,
          score: 0,
        };
        if (!current.matchedAlbumTitles.some((title) => normalizeAlbumTitleForOverlap(title) === normalizeAlbumTitleForOverlap(album.title))) {
          current.matchedAlbumTitles.push(album.title);
        }
        if (match.evidence.upcMatched) {
          current.upcMatches += 1;
        }
        if ((match.evidence.isrcOverlap || 0) > 0) {
          current.isrcMatches += match.evidence.isrcOverlap || 0;
        }
        current.score += (match.evidence.upcMatched ? 100 : 0)
          + Math.min(50, (match.evidence.isrcOverlap || 0) * 12)
          + Math.round(match.confidence * 20);
        current.artist = current.artist.Albums?.length ? current.artist : artist;
        scored.set(artist.id, current);
      }
    }
    const earlyMatch = bestProviderReleaseEvidenceArtistMatch(sortReleaseEvidenceCandidates(scored.values()));
    if (earlyMatch) {
      break;
    }
  }

  return sortReleaseEvidenceCandidates(scored.values());
}

export function bestProviderReleaseEvidenceArtistMatch(candidates: ProviderArtistReleaseEvidenceCandidate[]): {
  artist: LidarrArtist;
  status: "verified" | "probable";
  confidence: number;
  method: string;
} | null {
  const best = candidates[0];
  if (!best) {
    return null;
  }
  const runnerUp = candidates[1];
  const runnerUpAlbums = runnerUp?.matchedAlbumTitles.length ?? 0;

  if (best.upcMatches > 0 && best.upcMatches > (runnerUp?.upcMatches ?? 0)) {
    return {
      artist: best.artist,
      status: "verified",
      confidence: 0.995,
      method: "provider-discography-upc",
    };
  }

  if (best.isrcMatches >= 2 && best.isrcMatches >= (runnerUp?.isrcMatches ?? 0) + 2) {
    return {
      artist: best.artist,
      status: "verified",
      confidence: 0.96,
      method: "provider-discography-isrc",
    };
  }

  if (best.matchedAlbumTitles.length >= 2 && best.matchedAlbumTitles.length >= runnerUpAlbums + 2) {
    return {
      artist: best.artist,
      status: "probable",
      confidence: best.matchedAlbumTitles.length >= 4 ? 0.9 : 0.84,
      method: "provider-discography-release-search",
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
  /**
   * Structured provider albums for artist-identity evidence. Title overlap is
   * still useful in default Servarr Metadata Server mode; UPC/ISRC/shape become
   * available here when the provider and catalog payloads expose them.
   */
  listProviderAlbums?: () => Promise<ProviderArtistEvidenceAlbum[]>;
}

export class ProviderArtistIdentityService {
  static async resolve(provider: string, artist: ProviderArtistIdentityInput, options?: ResolveProviderArtistOptions): Promise<ProviderArtistIdentityResolution> {
    const cached = db.prepare(`
      WITH accepted AS (
        SELECT
          canonical.id AS artist_id,
          canonical.mbid AS artist_mbid,
          match.confidence,
          match.method
        FROM ProviderItems item
        JOIN ProviderArtistMatches match
          ON match.provider_artist_item_id = item.id
         AND match.match_state = 'accepted'
        JOIN ArtistMetadata canonical ON canonical.id = match.artist_id
        WHERE item.provider = ?
          AND item.entity_type = 'artist'
          AND item.provider_id = ?
      )
      SELECT
        MAX(artist_mbid) AS artist_mbid,
        MAX(confidence) AS confidence,
        MAX(method) AS method
      FROM accepted
      HAVING COUNT(DISTINCT artist_id) = 1
    `).get(provider, artist.providerId) as {
      artist_mbid?: string | null;
      confidence?: number | null;
      method?: string | null;
    } | undefined;

    if (cached?.artist_mbid) {
      return {
        mbid: cached.artist_mbid,
        status: (cached.confidence ?? 1) >= 0.99 ? "verified" : "probable",
        confidence: cached.confidence ?? 1,
        method: cached.method || "provider-artist-cache",
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
      const candidates = (await catalogProviderRegistry.getActive().search(artist.name, { limit: 10 })).artists;
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
      if (options?.listProviderAlbumTitles || options?.listProviderAlbums) {
        try {
          const providerAlbums = options.listProviderAlbums ? (await options.listProviderAlbums()).slice(0, 50) : [];
          const providerAlbumTitles = providerAlbums.length > 0
            ? providerAlbums.map((album) => album.title).filter(Boolean)
            : (await options.listProviderAlbumTitles?.() ?? []).slice(0, 50);
          const overlapMatch = bestDiscographyOverlapMatch(providerAlbumTitles, candidates);
          if (overlapMatch) {
            return {
              mbid: overlapMatch.artist.id,
              status: overlapMatch.status,
              confidence: overlapMatch.confidence,
              method: overlapMatch.method,
            };
          }
          if (providerAlbums.length > 0) {
            const releaseEvidenceCandidates = await findArtistCandidatesByProviderReleaseEvidence(artist, providerAlbums, provider);
            const releaseEvidenceMatch = bestProviderReleaseEvidenceArtistMatch(releaseEvidenceCandidates);
            if (releaseEvidenceMatch) {
              return {
                mbid: releaseEvidenceMatch.artist.id,
                status: releaseEvidenceMatch.status,
                confidence: releaseEvidenceMatch.confidence,
                method: releaseEvidenceMatch.method,
              };
            }
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
    const providerItemId = new ProviderCatalogRepository(db).upsertItem({
      provider,
      entityType: "artist",
      providerId: artist.providerId,
      title: artist.name,
      availability: "unknown",
      checkedAt: new Date().toISOString(),
      providerUrl: artist.providerUrl || artist.providerUrls?.[0] || null,
      coverId: /^https?:\/\//i.test(String(artist.picture || "")) ? null : artist.picture || null,
      artworkUrl: /^https?:\/\//i.test(String(artist.picture || "")) ? artist.picture || null : null,
    });
    db.prepare("DELETE FROM ProviderArtistIgnores WHERE provider_artist_item_id = ?")
      .run(providerItemId);
    if (resolution.mbid) {
      const canonicalArtist = db.prepare(`
        SELECT id FROM ArtistMetadata WHERE mbid = ? LIMIT 1
      `).get(resolution.mbid) as { id: number } | undefined;
      if (canonicalArtist) {
        new ProviderMatchRepository(db).upsertArtistMatch({
          providerArtistItemId: providerItemId,
          artistId: canonicalArtist.id,
          decision: {
            matchState: resolution.status === "ambiguous" ? "ambiguous" : "accepted",
            decisionSource: resolution.method === "manual" ? "manual" : "automatic",
            confidence: Math.max(0, Math.min(1, resolution.confidence)),
            method: resolution.method,
            evidence: { source: "provider-artist-identity" },
            matcherVersion: 1,
          },
        });
      }
    }
  }

  /**
   * Provider artists with no MusicBrainz identity — the ones a provider import
   * saw but could not monitor (Lidarr surfaces the same set as unmatched
   * import-list items). Read-only; used by the System Status page so a
   * "531 followed, 494 monitored" gap is explainable in the UI.
   */
  static countUnmatched(): number {
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM ProviderItems item
      WHERE item.entity_type = 'artist'
        AND NOT EXISTS (
          SELECT 1
          FROM ProviderArtistMatches match
          WHERE match.provider_artist_item_id = item.id
            AND match.match_state = 'accepted'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM ProviderArtistIgnores ignored
          WHERE ignored.provider_artist_item_id = item.id
        )
    `).get() as { count: number };
    return Number(row.count || 0);
  }

  static listUnmatched(options: { limit?: number; offset?: number } = {}): Array<{
    provider: string;
    providerId: string;
    name: string;
    status: string;
    method: string;
    updatedAt: string | null;
  }> {
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(Number(options.limit))) : undefined;
    const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(Number(options.offset))) : 0;
    const rows = db.prepare(`
      SELECT
        item.provider,
        item.provider_id,
        item.title,
        item.updated_at
      FROM ProviderItems item
      WHERE item.entity_type = 'artist'
        AND NOT EXISTS (
          SELECT 1
          FROM ProviderArtistMatches match
          WHERE match.provider_artist_item_id = item.id
            AND match.match_state = 'accepted'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM ProviderArtistIgnores ignored
          WHERE ignored.provider_artist_item_id = item.id
        )
      ORDER BY item.title COLLATE NOCASE ASC
      ${limit == null ? "" : "LIMIT ? OFFSET ?"}
    `).all(...(limit == null ? [] : [limit, offset])) as Array<{
      provider: string;
      provider_id: string;
      title?: string | null;
      updated_at?: string | null;
    }>;

    return rows.map((row) => ({
      provider: row.provider,
      providerId: row.provider_id,
      name: row.title || row.provider_id,
      status: "provider_only",
      method: "provider-artist-unmatched",
      updatedAt: row.updated_at ?? null,
    }));
  }
}
