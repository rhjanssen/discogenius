import type Database from "better-sqlite3";
import { db as defaultDb } from "../database.js";
import {
  type MusicBrainzRelease,
  type MusicBrainzReleaseTrack,
  lookupMusicBrainzReleaseById,
  lookupMusicBrainzReleasesByBarcode,
  normalizeBarcode,
} from "./musicbrainz.js";
import { normalizeComparableText, stringSimilarity } from "./import-matching-utils.js";

type LocalAlbumForMusicBrainzMatch = {
  id: string | number;
  title: string;
  version?: string | null;
  upc?: string | null;
  release_date?: string | null;
  num_tracks?: number | null;
  artist_name?: string | null;
};

export type MusicBrainzReleaseMatch = {
  release: MusicBrainzRelease;
  score: number;
  confidence: number;
  method: "barcode";
  titleScore: number;
  artistScore: number;
  yearScore: number;
  trackCountScore: number;
  formatScore: number;
  statusScore: number;
};

type EnrichAlbumOptions = {
  database?: Database.Database;
  force?: boolean;
  provider?: string;
};

type EnrichAlbumResult = {
  matched: boolean;
  skipped?: "missing_album" | "missing_barcode" | "existing_match" | "no_candidates" | "low_confidence";
  releaseId?: string;
  releaseGroupId?: string | null;
  score?: number;
  confidence?: number;
  updatedTracks?: number;
};

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeYear(value?: string | null): string {
  return String(value || "").trim().slice(0, 4);
}

function releaseFullTitle(release: MusicBrainzRelease): string {
  return [release.title, release.disambiguation].filter(Boolean).join(" ");
}

function albumFullTitle(album: LocalAlbumForMusicBrainzMatch): string {
  return [album.title, album.version].filter(Boolean).join(" ");
}

function isDigitalRelease(release: MusicBrainzRelease): boolean {
  return (release.media || []).some((medium) => normalizeComparableText(medium.format).includes("digital"));
}

function releaseTracksFromRows(rows: any[]): MusicBrainzReleaseTrack[] {
  return rows.map((row) => ({
    id: String(row.track_mbid || "").trim(),
    recordingId: String(row.recording_mbid || "").trim() || null,
    title: String(row.title || "").trim(),
    mediumNumber: Number(row.medium_number || 0),
    trackNumber: String(row.track_number || "").trim(),
    absoluteTrackNumber: Number(row.absolute_track_number || 0),
    durationSeconds: row.duration === null || row.duration === undefined ? null : Number(row.duration),
    isrcs: parseJsonArray<string>(row.isrcs),
  }));
}

function mapCachedRelease(row: any, tracks: MusicBrainzReleaseTrack[]): MusicBrainzRelease {
  return {
    id: String(row.mbid),
    title: String(row.title || ""),
    barcode: String(row.barcode || "").trim() || null,
    date: String(row.date || "").trim() || null,
    country: String(row.country || "").trim() || null,
    status: String(row.status || "").trim() || null,
    releaseGroupId: String(row.release_group_mbid || "").trim() || null,
    disambiguation: String(row.disambiguation || "").trim() || null,
    labels: parseJsonArray<string>(row.labels),
    artistCredits: parseJsonArray(row.artist_credits),
    media: parseJsonArray(row.media),
    tracks,
    trackCount: Number(row.track_count || tracks.length || 0),
    durationSeconds: row.duration === null || row.duration === undefined ? null : Number(row.duration),
  };
}

export function scoreMusicBrainzReleaseCandidate(
  album: LocalAlbumForMusicBrainzMatch,
  release: MusicBrainzRelease,
): MusicBrainzReleaseMatch {
  const albumBarcode = normalizeBarcode(album.upc);
  const releaseBarcode = normalizeBarcode(release.barcode);
  const barcodeScore = albumBarcode && releaseBarcode && albumBarcode === releaseBarcode ? 5 : 0;

  const normalizedAlbumTitle = normalizeComparableText(album.title);
  const normalizedAlbumFullTitle = normalizeComparableText(albumFullTitle(album));
  const normalizedReleaseTitle = normalizeComparableText(release.title);
  const normalizedReleaseFullTitle = normalizeComparableText(releaseFullTitle(release));
  const titleScore = Math.max(
    normalizedAlbumTitle ? stringSimilarity(normalizedAlbumTitle, normalizedReleaseTitle) : 0,
    normalizedAlbumFullTitle ? stringSimilarity(normalizedAlbumFullTitle, normalizedReleaseFullTitle) : 0,
  );

  const normalizedArtist = normalizeComparableText(album.artist_name);
  const artistScore = normalizedArtist && release.artistCredits.length > 0
    ? Math.max(...release.artistCredits.map((credit) => stringSimilarity(
      normalizedArtist,
      normalizeComparableText(credit.name),
    )))
    : 0;

  const albumYear = normalizeYear(album.release_date);
  const releaseYear = normalizeYear(release.date);
  const yearScore = albumYear && releaseYear
    ? (albumYear === releaseYear ? 1 : 0)
    : 0.25;

  const albumTrackCount = Number(album.num_tracks || 0);
  const releaseTrackCount = Number(release.trackCount || release.tracks?.length || 0);
  const trackDelta = Math.abs(albumTrackCount - releaseTrackCount);
  const trackCountScore = albumTrackCount > 0 && releaseTrackCount > 0
    ? (trackDelta === 0 ? 1 : trackDelta === 1 ? 0.5 : 0)
    : 0.25;

  const formatScore = isDigitalRelease(release) ? 0.5 : 0;
  const statusScore = String(release.status || "").toLowerCase() === "official" ? 0.5 : 0;
  const score = barcodeScore + (titleScore * 2.5) + (artistScore * 1.5) + yearScore + trackCountScore + formatScore + statusScore;
  const confidence = Math.max(0, Math.min(1, score / 11));

  return {
    release,
    score,
    confidence,
    method: "barcode",
    titleScore,
    artistScore,
    yearScore,
    trackCountScore,
    formatScore,
    statusScore,
  };
}

export function isAcceptableMusicBrainzReleaseMatch(match: MusicBrainzReleaseMatch): boolean {
  if (normalizeBarcode(match.release.barcode).length === 0) {
    return false;
  }

  if (match.titleScore < 0.72) {
    return false;
  }

  if (match.artistScore > 0 && match.artistScore < 0.65) {
    return false;
  }

  return match.score >= 7;
}

export function selectBestMusicBrainzReleaseCandidate(
  album: LocalAlbumForMusicBrainzMatch,
  releases: MusicBrainzRelease[],
): MusicBrainzReleaseMatch | null {
  let best: MusicBrainzReleaseMatch | null = null;
  for (const release of releases) {
    const candidate = scoreMusicBrainzReleaseCandidate(album, release);
    if (!isAcceptableMusicBrainzReleaseMatch(candidate)) {
      continue;
    }

    if (!best || candidate.score > best.score) {
      best = candidate;
    }
  }

  return best;
}

export function upsertMusicBrainzReleaseSnapshot(
  release: MusicBrainzRelease,
  database: Database.Database = defaultDb,
) {
  const upsertRelease = database.prepare(`
    INSERT INTO musicbrainz_releases (
      mbid, release_group_mbid, title, disambiguation, barcode, date, country, status,
      labels, artist_credits, media, track_count, duration, data, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(mbid) DO UPDATE SET
      release_group_mbid = excluded.release_group_mbid,
      title = excluded.title,
      disambiguation = excluded.disambiguation,
      barcode = excluded.barcode,
      date = excluded.date,
      country = excluded.country,
      status = excluded.status,
      labels = excluded.labels,
      artist_credits = excluded.artist_credits,
      media = excluded.media,
      track_count = excluded.track_count,
      duration = excluded.duration,
      data = excluded.data,
      fetched_at = CURRENT_TIMESTAMP
  `);
  const deleteTracks = database.prepare("DELETE FROM musicbrainz_release_tracks WHERE release_mbid = ?");
  const insertTrack = database.prepare(`
    INSERT INTO musicbrainz_release_tracks (
      release_mbid, track_mbid, recording_mbid, title, medium_number,
      track_number, absolute_track_number, duration, isrcs
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  database.transaction(() => {
    upsertRelease.run(
      release.id,
      release.releaseGroupId || null,
      release.title,
      release.disambiguation || null,
      normalizeBarcode(release.barcode) || null,
      release.date || null,
      release.country || null,
      release.status || null,
      jsonString(release.labels || []),
      jsonString(release.artistCredits || []),
      jsonString(release.media || []),
      Number(release.trackCount || release.tracks?.length || 0),
      release.durationSeconds ?? null,
      jsonString(release),
    );

    deleteTracks.run(release.id);
    for (const track of release.tracks || []) {
      if (!track.id) continue;
      insertTrack.run(
        release.id,
        track.id,
        track.recordingId || null,
        track.title,
        track.mediumNumber || null,
        track.trackNumber || null,
        track.absoluteTrackNumber || null,
        track.durationSeconds ?? null,
        jsonString(track.isrcs || []),
      );
    }
  })();
}

export function getCachedMusicBrainzReleasesByBarcode(
  barcode: string,
  database: Database.Database = defaultDb,
): MusicBrainzRelease[] {
  const normalized = normalizeBarcode(barcode);
  if (!normalized) return [];

  const rows = database.prepare(`
    SELECT *
    FROM musicbrainz_releases
    WHERE barcode = ?
    ORDER BY
      CASE WHEN LOWER(status) = 'official' THEN 0 ELSE 1 END,
      date DESC,
      fetched_at DESC
  `).all(normalized) as any[];

  if (rows.length === 0) return [];

  const trackRows = database.prepare(`
    SELECT *
    FROM musicbrainz_release_tracks
    WHERE release_mbid = ?
    ORDER BY COALESCE(absolute_track_number, 0), medium_number, track_number
  `);

  return rows.map((row) => mapCachedRelease(row, releaseTracksFromRows(trackRows.all(row.mbid))));
}

async function getMusicBrainzReleaseCandidates(
  album: LocalAlbumForMusicBrainzMatch,
  database: Database.Database,
): Promise<MusicBrainzRelease[]> {
  const barcode = normalizeBarcode(album.upc);
  if (!barcode) return [];

  const cached = getCachedMusicBrainzReleasesByBarcode(barcode, database);
  if (cached.length > 0) {
    return cached;
  }

  const summaries = await lookupMusicBrainzReleasesByBarcode(barcode, 10);
  const rankedSummaries = [...summaries]
    .map((release) => scoreMusicBrainzReleaseCandidate(album, release))
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);

  const detailed: MusicBrainzRelease[] = [];
  for (const summary of rankedSummaries) {
    const release = await lookupMusicBrainzReleaseById(summary.release.id);
    if (!release) continue;
    upsertMusicBrainzReleaseSnapshot(release, database);
    detailed.push(release);
  }

  return detailed.length > 0 ? detailed : summaries;
}

function applyRecordingIdsFromRelease(
  albumId: string | number,
  release: MusicBrainzRelease,
  database: Database.Database,
): number {
  const localTracks = database.prepare(`
    SELECT id, title, isrc, track_number, volume_number, mbid
    FROM media
    WHERE album_id = ?
      AND type != 'Music Video'
  `).all(albumId) as Array<{
    id: string | number;
    title: string;
    isrc: string | null;
    track_number: number | null;
    volume_number: number | null;
    mbid: string | null;
  }>;

  if (localTracks.length === 0 || !release.tracks?.length) {
    return 0;
  }

  const releaseTracksByIsrc = new Map<string, MusicBrainzReleaseTrack>();
  for (const track of release.tracks) {
    for (const isrc of track.isrcs || []) {
      releaseTracksByIsrc.set(String(isrc).trim().toUpperCase(), track);
    }
  }

  const update = database.prepare("UPDATE media SET mbid = COALESCE(mbid, ?) WHERE id = ?");
  let updated = 0;

  for (const localTrack of localTracks) {
    if (localTrack.mbid) continue;

    const localIsrc = String(localTrack.isrc || "").trim().toUpperCase();
    let matchedTrack = localIsrc ? releaseTracksByIsrc.get(localIsrc) : undefined;

    if (!matchedTrack) {
      matchedTrack = release.tracks.find((candidate) => {
        const sameMedium = Number(candidate.mediumNumber || 1) === Number(localTrack.volume_number || 1);
        const sameTrackNumber = String(candidate.trackNumber || candidate.absoluteTrackNumber) === String(localTrack.track_number || "");
        if (!sameMedium || !sameTrackNumber) return false;
        return stringSimilarity(
          normalizeComparableText(localTrack.title),
          normalizeComparableText(candidate.title),
        ) >= 0.85;
      });
    }

    if (!matchedTrack?.recordingId) continue;
    updated += update.run(matchedTrack.recordingId, localTrack.id).changes;
  }

  return updated;
}

export async function enrichAlbumWithMusicBrainzRelease(
  albumId: string | number,
  options: EnrichAlbumOptions = {},
): Promise<EnrichAlbumResult> {
  const database = options.database ?? defaultDb;
  const provider = options.provider || "tidal";
  const album = database.prepare(`
    SELECT
      a.id,
      a.title,
      a.version,
      a.upc,
      a.release_date,
      a.num_tracks,
      a.mbid,
      a.mb_release_group_id,
      ar.name AS artist_name
    FROM albums a
    LEFT JOIN artists ar ON ar.id = a.artist_id
    WHERE a.id = ?
  `).get(albumId) as (LocalAlbumForMusicBrainzMatch & {
    mbid?: string | null;
    mb_release_group_id?: string | null;
  }) | undefined;

  if (!album) {
    return { matched: false, skipped: "missing_album" };
  }

  if (!normalizeBarcode(album.upc)) {
    return { matched: false, skipped: "missing_barcode" };
  }

  if (!options.force && album.mbid && album.mb_release_group_id) {
    return { matched: false, skipped: "existing_match" };
  }

  const candidates = await getMusicBrainzReleaseCandidates(album, database);
  if (candidates.length === 0) {
    return { matched: false, skipped: "no_candidates" };
  }

  const bestMatch = selectBestMusicBrainzReleaseCandidate(album, candidates);
  if (!bestMatch) {
    return { matched: false, skipped: "low_confidence" };
  }

  upsertMusicBrainzReleaseSnapshot(bestMatch.release, database);

  const updateAlbum = database.prepare(`
    UPDATE albums
    SET
      mbid = CASE WHEN ? = 1 OR mbid IS NULL OR mbid = '' THEN ? ELSE mbid END,
      mb_release_group_id = CASE WHEN ? = 1 OR mb_release_group_id IS NULL OR mb_release_group_id = '' THEN ? ELSE mb_release_group_id END
    WHERE id = ?
  `);
  const upsertMatch = database.prepare(`
    INSERT INTO provider_release_matches (
      provider, provider_album_id, musicbrainz_release_mbid, match_method, confidence, score, data, matched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(provider, provider_album_id) DO UPDATE SET
      musicbrainz_release_mbid = excluded.musicbrainz_release_mbid,
      match_method = excluded.match_method,
      confidence = excluded.confidence,
      score = excluded.score,
      data = excluded.data,
      matched_at = CURRENT_TIMESTAMP
  `);

  database.transaction(() => {
    const force = options.force ? 1 : 0;
    updateAlbum.run(
      force,
      bestMatch.release.id,
      force,
      bestMatch.release.releaseGroupId || null,
      albumId,
    );
    upsertMatch.run(
      provider,
      String(albumId),
      bestMatch.release.id,
      bestMatch.method,
      bestMatch.confidence,
      bestMatch.score,
      jsonString({
        titleScore: bestMatch.titleScore,
        artistScore: bestMatch.artistScore,
        yearScore: bestMatch.yearScore,
        trackCountScore: bestMatch.trackCountScore,
        formatScore: bestMatch.formatScore,
        statusScore: bestMatch.statusScore,
      }),
    );
  })();

  const updatedTracks = applyRecordingIdsFromRelease(albumId, bestMatch.release, database);

  return {
    matched: true,
    releaseId: bestMatch.release.id,
    releaseGroupId: bestMatch.release.releaseGroupId,
    score: bestMatch.score,
    confidence: bestMatch.confidence,
    updatedTracks,
  };
}
