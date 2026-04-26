import axios from "axios";
import { readIntEnv } from "../utils/env.js";

export interface MusicBrainzArtistCredit {
  id: string;
  name: string;
}

export interface MusicBrainzRecording {
  id: string;
  title: string;
  artists: string[];
  artistCredits?: MusicBrainzArtistCredit[];
  isrcs: string[];
  releaseTitles: string[];
  firstReleaseDate: string | null;
  durationSeconds: number | null;
}

export interface MusicBrainzReleaseMedium {
  position: number;
  format: string | null;
  title: string | null;
}

export interface MusicBrainzReleaseTrack {
  id: string;
  recordingId: string | null;
  title: string;
  mediumNumber: number;
  trackNumber: string;
  absoluteTrackNumber: number;
  durationSeconds: number | null;
  isrcs: string[];
}

export interface MusicBrainzRelease {
  id: string;
  title: string;
  barcode: string | null;
  date: string | null;
  country: string | null;
  status: string | null;
  releaseGroupId: string | null;
  disambiguation?: string | null;
  labels?: string[];
  media?: MusicBrainzReleaseMedium[];
  tracks?: MusicBrainzReleaseTrack[];
  trackCount?: number;
  durationSeconds?: number | null;
  artistCredits: MusicBrainzArtistCredit[];
}

const MUSICBRAINZ_USER_AGENT = "Discogenius/1.2.1 (music metadata enrichment)";
const MUSICBRAINZ_MIN_INTERVAL_MS = readIntEnv("DISCOGENIUS_MUSICBRAINZ_MIN_INTERVAL_MS", 1100, 250);

let lastMusicBrainzRequestAt = 0;
let musicBrainzQueue: Promise<unknown> = Promise.resolve();

function getMusicBrainzHeaders() {
  return {
    "User-Agent": MUSICBRAINZ_USER_AGENT,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runMusicBrainzRequest<T>(request: () => Promise<T>): Promise<T> {
  const task = musicBrainzQueue.then(async () => {
    const elapsed = Date.now() - lastMusicBrainzRequestAt;
    if (elapsed < MUSICBRAINZ_MIN_INTERVAL_MS) {
      await sleep(MUSICBRAINZ_MIN_INTERVAL_MS - elapsed);
    }

    try {
      return await request();
    } finally {
      lastMusicBrainzRequestAt = Date.now();
    }
  });

  musicBrainzQueue = task.catch(() => undefined);
  return task;
}

export function normalizeBarcode(value: string | null | undefined): string {
  return String(value || "").trim().replace(/[^0-9]/g, "");
}

function mapMusicBrainzArtistCredits(rawCredits: unknown): MusicBrainzArtistCredit[] {
  if (!Array.isArray(rawCredits)) {
    return [];
  }

  return rawCredits
    .map((credit: any) => {
      const id = String(credit?.artist?.id || "").trim();
      const name = String(credit?.name || credit?.artist?.name || "").trim();
      if (!id || !name) {
        return null;
      }

      return { id, name };
    })
    .filter(Boolean) as MusicBrainzArtistCredit[];
}

function secondsFromMilliseconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value / 1000)
    : null;
}

function mapMusicBrainzRelease(rawRelease: any): MusicBrainzRelease {
  const artistCredits = mapMusicBrainzArtistCredits(rawRelease?.["artist-credit"]);
  const labels = Array.isArray(rawRelease?.["label-info"])
    ? rawRelease["label-info"]
      .map((labelInfo: any) => String(labelInfo?.label?.name || "").trim())
      .filter(Boolean)
    : [];

  const media: MusicBrainzReleaseMedium[] = [];
  const tracks: MusicBrainzReleaseTrack[] = [];
  let absoluteTrackNumber = 0;

  for (const medium of Array.isArray(rawRelease?.media) ? rawRelease.media : []) {
    const mediumNumber = Number(medium?.position || media.length + 1);
    media.push({
      position: mediumNumber,
      format: String(medium?.format || "").trim() || null,
      title: String(medium?.title || "").trim() || null,
    });

    for (const track of Array.isArray(medium?.tracks) ? medium.tracks : []) {
      absoluteTrackNumber += 1;
      const recording = track?.recording || {};
      tracks.push({
        id: String(track?.id || "").trim(),
        recordingId: String(recording?.id || "").trim() || null,
        title: String(track?.title || recording?.title || "").trim(),
        mediumNumber,
        trackNumber: String(track?.number || track?.position || "").trim(),
        absoluteTrackNumber,
        durationSeconds: secondsFromMilliseconds(track?.length ?? recording?.length),
        isrcs: Array.isArray(recording?.isrcs)
          ? recording.isrcs.map((isrc: unknown) => String(isrc || "").trim().toUpperCase()).filter(Boolean)
          : [],
      });
    }
  }

  const durationSeconds = tracks.length > 0
    ? tracks.reduce((total, track) => total + Number(track.durationSeconds || 0), 0)
    : null;

  return {
    id: String(rawRelease?.id || "").trim(),
    title: String(rawRelease?.title || "").trim(),
    barcode: normalizeBarcode(rawRelease?.barcode) || null,
    date: String(rawRelease?.date || "").trim() || null,
    country: String(rawRelease?.country || "").trim() || null,
    status: String(rawRelease?.status || "").trim() || null,
    releaseGroupId: String(rawRelease?.["release-group"]?.id || "").trim() || null,
    disambiguation: String(rawRelease?.disambiguation || "").trim() || null,
    labels,
    media,
    tracks,
    trackCount: tracks.length || Number(rawRelease?.["track-count"] || 0) || undefined,
    durationSeconds,
    artistCredits,
  };
}

export async function lookupMusicBrainzRecording(recordingId: string): Promise<MusicBrainzRecording | null> {
  if (!recordingId) {
    return null;
  }

  const url = `https://musicbrainz.org/ws/2/recording/${encodeURIComponent(recordingId)}?fmt=json&inc=artist-credits+isrcs+releases`;

  try {
    const response = await runMusicBrainzRequest(() => axios.get(url, {
      timeout: 10000,
      headers: getMusicBrainzHeaders(),
    }));

    const data = response.data || {};
    const artistCredits = mapMusicBrainzArtistCredits(data["artist-credit"]);
    const artists = artistCredits.map((credit) => credit.name);
    const releaseTitles = Array.isArray(data.releases)
      ? data.releases
        .map((release: any) => release?.title || null)
        .filter(Boolean)
      : [];

    return {
      id: String(data.id || recordingId),
      title: data.title || "",
      artists,
      artistCredits,
      isrcs: Array.isArray(data.isrcs) ? data.isrcs.filter(Boolean) : [],
      releaseTitles,
      firstReleaseDate: data["first-release-date"] || null,
      durationSeconds: secondsFromMilliseconds(data.length),
    };
  } catch (error: any) {
    const status = error?.response?.status;
    if (status === 404) {
      return null;
    }

    console.warn(`[MusicBrainz] Recording lookup failed for ${recordingId}:`, error?.message || error);
    return null;
  }
}

export async function lookupMusicBrainzRecordingsByIsrc(isrc: string): Promise<MusicBrainzRecording[]> {
  const normalized = String(isrc || "").trim().toUpperCase();
  if (!normalized) {
    return [];
  }

  const url = `https://musicbrainz.org/ws/2/recording?fmt=json&limit=10&query=${encodeURIComponent(`isrc:${normalized}`)}`;

  try {
    const response = await runMusicBrainzRequest(() => axios.get(url, {
      timeout: 10000,
      headers: getMusicBrainzHeaders(),
    }));

    const recordings = Array.isArray(response.data?.recordings) ? response.data.recordings : [];
    return recordings.map((recording: any) => {
      const artistCredits = mapMusicBrainzArtistCredits(recording?.["artist-credit"]);
      const releaseTitles = Array.isArray(recording?.releases)
        ? recording.releases.map((release: any) => String(release?.title || "").trim()).filter(Boolean)
        : [];

      return {
        id: String(recording?.id || "").trim(),
        title: String(recording?.title || "").trim(),
        artists: artistCredits.map((credit) => credit.name),
        artistCredits,
        isrcs: [normalized],
        releaseTitles,
        firstReleaseDate: recording?.["first-release-date"] || null,
        durationSeconds: secondsFromMilliseconds(recording?.length),
      } satisfies MusicBrainzRecording;
    }).filter((recording: MusicBrainzRecording) => Boolean(recording.id && recording.title));
  } catch (error: any) {
    console.warn(`[MusicBrainz] ISRC lookup failed for ${normalized}:`, error?.message || error);
    return [];
  }
}

export async function lookupMusicBrainzReleaseById(releaseId: string): Promise<MusicBrainzRelease | null> {
  const id = String(releaseId || "").trim();
  if (!id) {
    return null;
  }

  const inc = "artist-credits+labels+recordings+release-groups+media+isrcs";
  const url = `https://musicbrainz.org/ws/2/release/${encodeURIComponent(id)}?fmt=json&inc=${inc}`;

  try {
    const response = await runMusicBrainzRequest(() => axios.get(url, {
      timeout: 10000,
      headers: getMusicBrainzHeaders(),
    }));
    const release = mapMusicBrainzRelease(response.data || {});
    return release.id ? release : null;
  } catch (error: any) {
    const status = error?.response?.status;
    if (status === 404) {
      return null;
    }

    console.warn(`[MusicBrainz] Release lookup failed for ${id}:`, error?.message || error);
    return null;
  }
}

export async function lookupMusicBrainzReleasesByBarcode(barcode: string, limit = 10): Promise<MusicBrainzRelease[]> {
  const normalized = normalizeBarcode(barcode);
  if (!normalized) {
    return [];
  }

  const url = `https://musicbrainz.org/ws/2/release?fmt=json&limit=${Math.max(1, Math.min(limit, 25))}&query=${encodeURIComponent(`barcode:${normalized}`)}`;

  try {
    const response = await runMusicBrainzRequest(() => axios.get(url, {
      timeout: 10000,
      headers: getMusicBrainzHeaders(),
    }));

    const releases = Array.isArray(response.data?.releases) ? response.data.releases : [];
    return releases
      .map(mapMusicBrainzRelease)
      .filter((release: MusicBrainzRelease) => Boolean(release.id && release.title));
  } catch (error: any) {
    console.warn(`[MusicBrainz] Barcode lookup failed for ${normalized}:`, error?.message || error);
    return [];
  }
}
