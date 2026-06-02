import path from "node:path";
import { isSpatialAudioQuality, normalizeQualityTag } from "../utils/spatial-audio.js";

function sameResolvedPath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export function renderAudioRelativePathForLibrary(options: {
  relativePath: string;
  quality?: string | null;
  musicRoot: string;
  spatialRoot: string;
  mustDisambiguate?: boolean;
}): string {
  if (
    !isSpatialAudioQuality(options.quality)
    || !sameResolvedPath(options.musicRoot, options.spatialRoot)
    || options.mustDisambiguate !== true
  ) {
    return options.relativePath;
  }

  const parsed = path.parse(options.relativePath);
  const quality = normalizeQualityTag(options.quality) || "SPATIAL";
  const suffix = ` [${quality}]`;
  if (parsed.name.endsWith(suffix)) {
    return options.relativePath;
  }

  return path.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext}`);
}
