import { getConfigSection } from "../config/config.js";

export type AudioLibrarySlot = "stereo" | "spatial";

export interface EnabledDownloadLibrarySlots {
  audio: AudioLibrarySlot[];
  video: boolean;
}

/**
 * One source of truth for the library slots that participate in monitored
 * download/completion calculations. Stereo is always enabled; spatial and
 * video follow the filtering settings.
 */
export function getEnabledDownloadLibrarySlots(): EnabledDownloadLibrarySlots {
  const filtering = getConfigSection("filtering");
  return {
    audio: filtering.include_spatial ? ["stereo", "spatial"] : ["stereo"],
    video: filtering.include_videos === true,
  };
}
