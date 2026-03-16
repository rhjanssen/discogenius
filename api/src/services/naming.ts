import path from "path";
import { getConfigSection, type NamingConfig } from "./config.js";

export type LibraryRoot = "music" | "spatial_music" | "music_videos";

export type NamingContext = {
  artistName: string;

  albumTitle?: string | null;
  albumVersion?: string | null;
  albumFullTitle?: string | null;
  releaseYear?: string | null;
  explicit?: boolean | null;

  trackTitle?: string | null;
  trackVersion?: string | null;
  trackFullTitle?: string | null;
  trackNumber?: number | null;
  volumeNumber?: number | null;

  artistId?: string | null;
  albumId?: string | null;
  trackId?: string | null;

  videoTitle?: string | null;
};

function sanitizeSegment(input: string): string {
  return (input || "")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanupRendered(input: string): string {
  return (input || "")
    .replace(/\(\s*\)/g, "")
    .replace(/\[\s*\]/g, "")
    .replace(/\{\s*\}/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildDerived(context: NamingContext) {
  const artistName = context.artistName || "Unknown Artist";
  const artistId = context.artistId || "";

  const albumTitle = context.albumTitle || "Unknown Album";
  const albumId = context.albumId || "";
  const albumVersion = context.albumVersion ?? "";
  const albumFullTitle =
    context.albumFullTitle ||
    (albumVersion && !albumTitle.toLowerCase().includes(albumVersion.toLowerCase())
      ? `${albumTitle} (${albumVersion})`
      : albumTitle);

  const trackTitle = context.trackTitle || "Unknown Track";
  const trackVersion = context.trackVersion ?? "";
  const trackFullTitle =
    context.trackFullTitle ||
    (trackVersion && !trackTitle.toLowerCase().includes(trackVersion.toLowerCase())
      ? `${trackTitle} (${trackVersion})`
      : trackTitle);

  const trackNumber = Number(context.trackNumber || 0);
  const volumeNumber = Number(context.volumeNumber || 1);

  const releaseYear = (context.releaseYear ? String(context.releaseYear) : "").toString();
  const videoTitle = context.videoTitle || "Unknown Video";
  const trackId = context.trackId || "";

  return {
    artistName,
    artistId,
    albumTitle,
    albumId,
    albumVersion,
    albumFullTitle,
    releaseYear,
    trackTitle,
    trackVersion,
    trackFullTitle,
    trackNumber,
    volumeNumber,
    videoTitle,
    trackId,
  };
}

function renderTokens(template: string, context: NamingContext): string {
  const derived = buildDerived(context);

  const replacements: Record<string, string> = {
    "{artistName}": sanitizeSegment(derived.artistName),
    "{artistId}": sanitizeSegment(derived.artistId),

    "{albumTitle}": sanitizeSegment(derived.albumTitle),
    "{albumId}": sanitizeSegment(derived.albumId),
    "{albumFullTitle}": sanitizeSegment(derived.albumFullTitle),
    "{releaseYear}": sanitizeSegment(derived.releaseYear),

    "{trackTitle}": sanitizeSegment(derived.trackTitle),
    "{trackFullTitle}": sanitizeSegment(derived.trackFullTitle),
    "{trackId}": sanitizeSegment(derived.trackId),

    "{videoTitle}": sanitizeSegment(derived.videoTitle),

    "{trackNumber}": String(derived.trackNumber),
    "{trackNumber0}": String(derived.trackNumber).padStart(1, "0"),
    "{trackNumber00}": String(derived.trackNumber).padStart(2, "0"),
    "{trackNumber000}": String(derived.trackNumber).padStart(3, "0"),

    "{volumeNumber}": String(derived.volumeNumber),
    "{volumeNumber0}": String(derived.volumeNumber).padStart(1, "0"),
    "{volumeNumber00}": String(derived.volumeNumber).padStart(2, "0"),
    "{volumeNumber000}": String(derived.volumeNumber).padStart(3, "0"),

    // Explicit tags - returns value when true, empty string when false
    // The cleanupRendered() function handles double spaces automatically
    "{explicit}": context.explicit ? "(Explicit)" : "",
    "{E}": context.explicit ? "[E]" : "",

    // Legacy-ish: intentionally not supported as explicit variables.
    // Keep as empty so older templates don't render "Unknown".
    "{albumVersion}": "",
    "{trackVersion}": "",
  };

  return (template || "").replace(/\{[a-zA-Z0-9]+\}/g, (token) => replacements[token] ?? "");
}

export function getNamingConfig(): NamingConfig {
  return getConfigSection("naming");
}

export function renderRelativePath(template: string, context: NamingContext): string {
  const rendered = cleanupRendered(renderTokens(template, context));
  const rawSegments = rendered.split(/[\\/]+/g);

  const segments = rawSegments
    .map((segment) => cleanupRendered(segment))
    .map((segment) => sanitizeSegment(segment))
    .filter((segment) => segment.length > 0)
    .filter((segment) => segment !== "." && segment !== "..");

  return segments.length > 0 ? path.join(...segments) : "Unknown";
}

export function renderFileStem(template: string, context: NamingContext): string {
  return sanitizeSegment(cleanupRendered(renderTokens(template, context)));
}

export function getLibraryRootPath(libraryPath: string, root: LibraryRoot): string {
  return path.join(libraryPath, root);
}
