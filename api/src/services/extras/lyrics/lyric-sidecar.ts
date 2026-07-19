import fs from "node:fs";
import path from "node:path";

export const SYNCHRONIZED_LYRIC_EXTENSION = ".lrc" as const;
export const PLAIN_LYRIC_EXTENSION = ".txt" as const;
export const LYRIC_SIDECAR_EXTENSIONS = [
  SYNCHRONIZED_LYRIC_EXTENSION,
  PLAIN_LYRIC_EXTENSION,
] as const;

export type LyricSidecarExtension = typeof LYRIC_SIDECAR_EXTENSIONS[number];

export type ClassifiedLyrics = {
  content: string;
  extension: LyricSidecarExtension;
  synchronized: boolean;
  text: string;
  subtitles: string;
};

export type ExistingLyricSidecar = ClassifiedLyrics & {
  filePath: string;
};

// LRC timestamps are [minutes:seconds], optionally followed by a fractional
// component. Metadata tags such as [ar:Artist] deliberately do not qualify.
// Seconds above 59 are invalid and must not turn a plain-text file into LRC.
const LRC_LINE_TIMESTAMP = /^\s*(?:\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\])+\s*/mu;

function normalizedContent(value: unknown): string {
  return String(value ?? "").replace(/^\uFEFF/u, "").trim();
}

export function isSynchronizedLyricContent(value: unknown): boolean {
  return LRC_LINE_TIMESTAMP.test(normalizedContent(value));
}

export function classifyLyricsForSidecar(lyrics: {
  subtitles?: string | null;
  text?: string | null;
} | null | undefined): ClassifiedLyrics | null {
  const subtitles = normalizedContent(lyrics?.subtitles);
  const text = normalizedContent(lyrics?.text);

  if (subtitles && isSynchronizedLyricContent(subtitles)) {
    return {
      content: subtitles,
      extension: SYNCHRONIZED_LYRIC_EXTENSION,
      synchronized: true,
      text,
      subtitles,
    };
  }

  // Some providers put timed content in the plain field. Preserve the actual
  // semantics rather than trusting the field name alone.
  if (text && isSynchronizedLyricContent(text)) {
    return {
      content: text,
      extension: SYNCHRONIZED_LYRIC_EXTENSION,
      synchronized: true,
      text: "",
      subtitles: text,
    };
  }

  const plain = text || subtitles;
  if (!plain) return null;

  return {
    content: plain,
    extension: PLAIN_LYRIC_EXTENSION,
    synchronized: false,
    text: plain,
    subtitles: "",
  };
}

export function isLyricSidecarExtension(extension: string): boolean {
  return LYRIC_SIDECAR_EXTENSIONS.includes(extension.toLowerCase() as LyricSidecarExtension);
}

export function lyricSidecarPath(
  mediaOrSidecarPath: string,
  extension: LyricSidecarExtension,
): string {
  const parsed = path.parse(mediaOrSidecarPath);
  return path.join(parsed.dir, `${parsed.name}${extension}`);
}

export function readLyricSidecar(filePath: string): ExistingLyricSidecar | null {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf8");
  const synchronized = isSynchronizedLyricContent(content);
  const classified = classifyLyricsForSidecar({
    subtitles: synchronized ? content : "",
    text: synchronized ? "" : content,
  });
  return classified ? { ...classified, filePath } : null;
}

/**
 * Find the best adjacent lyric sidecar, preferring genuinely synchronized
 * content. When requested, safely correct a mismatched extension if the
 * destination does not already exist (for example an old timestamp-free LRC
 * becomes a plain `.txt` sidecar).
 */
export function findAdjacentLyricSidecar(
  mediaPath: string,
  options: { normalizeExtension?: boolean } = {},
): ExistingLyricSidecar | null {
  const candidates = LYRIC_SIDECAR_EXTENSIONS
    .map((extension) => readLyricSidecar(lyricSidecarPath(mediaPath, extension)))
    .filter((candidate): candidate is ExistingLyricSidecar => candidate != null)
    .sort((left, right) => {
      if (left.synchronized !== right.synchronized) return left.synchronized ? -1 : 1;
      const leftMatches = path.extname(left.filePath).toLowerCase() === left.extension;
      const rightMatches = path.extname(right.filePath).toLowerCase() === right.extension;
      return Number(rightMatches) - Number(leftMatches);
    });

  const selected = candidates[0] ?? null;
  if (!selected || !options.normalizeExtension) return selected;

  const normalizedPath = lyricSidecarPath(mediaPath, selected.extension);
  if (path.resolve(normalizedPath) === path.resolve(selected.filePath)) return selected;
  if (fs.existsSync(normalizedPath)) return selected;

  try {
    fs.renameSync(selected.filePath, normalizedPath);
    return { ...selected, filePath: normalizedPath };
  } catch {
    // Discovery must remain useful on read-only libraries. Content-based
    // classification still prevents incorrect synchronized-tag reuse.
    return selected;
  }
}
