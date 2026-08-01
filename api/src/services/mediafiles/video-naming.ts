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

export function resolveVideoTypeSuffix(
  title: string | null | undefined,
  videoVariant?: string | null,
  placement: "inline" | "separated" = "separated",
): string {
  return resolveVideoTypeSuffixFromVariant(
    videoVariant != null && String(videoVariant).trim()
      ? normalizeVideoVariant(videoVariant)
      : parseVideoVariant(title),
    title,
    placement,
  );
}

export function stemEndsWithVideoTypeSuffix(stem: string | null | undefined): boolean {
  const lower = String(stem || "").toLowerCase();
  return VIDEO_TYPE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}
