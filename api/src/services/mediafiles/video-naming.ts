import {
  resolveVideoTypeSuffix as resolveVideoTypeSuffixFromVariant,
  parseVideoVariant,
  normalizeVideoVariant,
} from "../music/video-variant.js";

/**
 * Map a provider video title to a music-video extras suffix
 * (-behindthescenes / -concert / -interview / -live / -lyrics / -video).
 *
 * Classification is best-effort from title qualifiers: providers often title a
 * lyric video plainly ("Pompeii"), which can only default to "-video". Keyword
 * checks are word-bounded and biased toward parenthetical/bracketed qualifiers
 * so song titles like "Oblivion" or "Alive" never classify as live recordings.
 */
export const VIDEO_TYPE_SUFFIXES = [
  "-behindthescenes",
  "-concert",
  "-interview",
  "-live",
  "-lyrics",
  "-video",
] as const;

/** @deprecated Prefer VIDEO_TYPE_SUFFIXES */
export const PLEX_VIDEO_TYPE_SUFFIXES = VIDEO_TYPE_SUFFIXES;

export function resolveVideoTypeSuffix(
  title: string | null | undefined,
  videoVariant?: string | null,
): string {
  return resolveVideoTypeSuffixFromVariant(
    videoVariant != null && String(videoVariant).trim()
      ? normalizeVideoVariant(videoVariant)
      : parseVideoVariant(title),
    title,
  );
}

/** @deprecated Prefer resolveVideoTypeSuffix */
export const resolvePlexVideoSuffix = resolveVideoTypeSuffix;

export function stemEndsWithVideoTypeSuffix(stem: string | null | undefined): boolean {
  const lower = String(stem || "").toLowerCase();
  return VIDEO_TYPE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** @deprecated Prefer stemEndsWithVideoTypeSuffix */
export const stemEndsWithPlexVideoType = stemEndsWithVideoTypeSuffix;
