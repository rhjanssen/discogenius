import { Config, type QualityConfig } from "./config.js";
import { normalizeAudioQualityTag } from "./quality.js";

export type AudioQualityTier = "LOW" | "HIGH" | "LOSSLESS" | "HIRES_LOSSLESS";
export type VideoQualityTier = "MP4_360P" | "MP4_480P" | "MP4_720P" | "MP4_1080P";
export type QualityChangeDirection = "upgrade" | "downgrade" | "none";

export interface EffectiveQualityProfile {
    audioCutoff: AudioQualityTier;
    videoCutoff: VideoQualityTier;
    allowRedownloads: boolean;
    preferFlac: boolean;
    preferMp4: boolean;
}

export interface QualityChangeEvaluation {
    needsChange: boolean;
    direction: QualityChangeDirection;
    currentQuality: string;
    targetQuality: string | null;
    qualityCutoffNotMet: boolean;
    reason: string;
}

const AUDIO_RANKINGS: Record<AudioQualityTier, number> = {
    LOW: 1,
    HIGH: 2,
    LOSSLESS: 3,
    HIRES_LOSSLESS: 4,
};

const VIDEO_RANKINGS: Record<VideoQualityTier, number> = {
    MP4_360P: 1,
    MP4_480P: 2,
    MP4_720P: 3,
    MP4_1080P: 4,
};

const RANK_TO_AUDIO_QUALITY: Record<number, AudioQualityTier> = {
    1: "LOW",
    2: "HIGH",
    3: "LOSSLESS",
    4: "HIRES_LOSSLESS",
};

function getAudioCutoffFromSetting(setting: QualityConfig["audio_quality"]): AudioQualityTier {
    switch (setting) {
        case "low":
            return "LOW";
        case "normal":
            return "HIGH";
        case "high":
            return "LOSSLESS";
        case "max":
        default:
            return "HIRES_LOSSLESS";
    }
}

function getVideoCutoffFromSetting(setting: QualityConfig["video_quality"]): VideoQualityTier {
    switch (setting) {
        case "sd":
            return "MP4_480P";
        case "hd":
            return "MP4_720P";
        case "fhd":
        default:
            return "MP4_1080P";
    }
}

function normalizeAudioTier(value?: string | null): AudioQualityTier | null {
    const normalized = normalizeAudioQualityTag(value);
    if (normalized === "LOW" || normalized === "HIGH" || normalized === "LOSSLESS" || normalized === "HIRES_LOSSLESS") {
        return normalized;
    }

    return null;
}

function normalizeVideoTier(value?: string | null): VideoQualityTier | null {
    const normalized = String(value || "").trim().toUpperCase();
    if (
        normalized === "MP4_360P"
        || normalized === "MP4_480P"
        || normalized === "MP4_720P"
        || normalized === "MP4_1080P"
    ) {
        return normalized;
    }

    return null;
}

export class UpgradableSpecification {
    static buildEffectiveProfile(config: QualityConfig = Config.getQualityConfig()): EffectiveQualityProfile {
        return {
            audioCutoff: getAudioCutoffFromSetting(config.audio_quality),
            videoCutoff: getVideoCutoffFromSetting(config.video_quality),
            allowRedownloads: config.upgrade_existing_files !== false,
            preferFlac: config.extract_flac !== false,
            preferMp4: config.convert_video_mp4 !== false,
        };
    }

    static qualityCutoffNotMet(profile: EffectiveQualityProfile, currentQuality: string | null | undefined, newQuality?: string | null): boolean {
        const currentTier = normalizeAudioTier(currentQuality);
        const currentRank = currentTier ? AUDIO_RANKINGS[currentTier] : 0;
        const cutoffRank = AUDIO_RANKINGS[profile.audioCutoff];

        if (currentRank < cutoffRank) {
            return true;
        }

        const nextTier = normalizeAudioTier(newQuality);
        if (!nextTier) {
            return false;
        }

        return AUDIO_RANKINGS[nextTier] > currentRank;
    }

    static evaluateAudioChange(params: {
        profile?: EffectiveQualityProfile;
        currentQuality: string | null | undefined;
        sourceQuality?: string | null | undefined;
        codec?: string | null | undefined;
        extension?: string | null | undefined;
    }): QualityChangeEvaluation {
        const profile = params.profile ?? this.buildEffectiveProfile();
        const normalizedCurrentQuality = normalizeAudioTier(params.currentQuality);
        const currentQuality = normalizedCurrentQuality ?? normalizeAudioQualityTag(params.currentQuality);

        if (normalizeAudioQualityTag(params.currentQuality) === "DOLBY_ATMOS") {
            return {
                needsChange: false,
                direction: "none",
                currentQuality,
                targetQuality: null,
                qualityCutoffNotMet: false,
                reason: "Dolby Atmos is curated separately",
            };
        }

        const desiredRank = AUDIO_RANKINGS[profile.audioCutoff];
        const sourceTier = normalizeAudioTier(params.sourceQuality);
        const sourceRank = sourceTier ? AUDIO_RANKINGS[sourceTier] : desiredRank;
        const targetRank = Math.min(desiredRank, sourceRank);
        const targetQuality = RANK_TO_AUDIO_QUALITY[targetRank];
        const currentRank = normalizedCurrentQuality ? AUDIO_RANKINGS[normalizedCurrentQuality] : 0;
        const qualityCutoffNotMet = currentRank < targetRank;
        const codec = String(params.codec || "").toUpperCase();
        const extension = String(params.extension || "").replace(/^\./, "").toLowerCase();

        if (currentRank !== targetRank) {
            const direction: QualityChangeDirection = currentRank < targetRank ? "upgrade" : "downgrade";
            return {
                needsChange: profile.allowRedownloads,
                direction,
                currentQuality,
                targetQuality,
                qualityCutoffNotMet,
                reason: `Quality ${direction}: ${currentQuality || "UNKNOWN"} -> ${targetQuality}`,
            };
        }

        const requiresFlac = profile.preferFlac && (targetQuality === "LOSSLESS" || targetQuality === "HIRES_LOSSLESS");
        if (requiresFlac && codec !== "FLAC" && extension !== "flac") {
            return {
                needsChange: profile.allowRedownloads,
                direction: "upgrade",
                currentQuality,
                targetQuality,
                qualityCutoffNotMet,
                reason: `Format upgrade: ${codec || extension || "unknown"} -> FLAC`,
            };
        }

        return {
            needsChange: false,
            direction: "none",
            currentQuality,
            targetQuality,
            qualityCutoffNotMet,
            reason: `Current quality (${currentQuality || "UNKNOWN"}) matches target (${targetQuality})`,
        };
    }

    static evaluateVideoChange(params: {
        profile?: EffectiveQualityProfile;
        currentQuality: string | null | undefined;
        extension?: string | null | undefined;
    }): QualityChangeEvaluation {
        const profile = params.profile ?? this.buildEffectiveProfile();
        const normalizedCurrentQuality = normalizeVideoTier(params.currentQuality);
        const currentQuality = normalizedCurrentQuality ?? String(params.currentQuality || "").trim().toUpperCase();
        const targetQuality = profile.videoCutoff;
        const currentRank = normalizedCurrentQuality ? VIDEO_RANKINGS[normalizedCurrentQuality] : 0;
        const targetRank = VIDEO_RANKINGS[targetQuality];
        const qualityCutoffNotMet = currentRank < targetRank;
        const extension = String(params.extension || "").replace(/^\./, "").toLowerCase();

        if (currentRank !== targetRank) {
            const direction: QualityChangeDirection = currentRank < targetRank ? "upgrade" : "downgrade";
            return {
                needsChange: profile.allowRedownloads,
                direction,
                currentQuality,
                targetQuality,
                qualityCutoffNotMet,
                reason: `Video quality ${direction}: ${currentQuality || "UNKNOWN"} -> ${targetQuality}`,
            };
        }

        if (profile.preferMp4 && extension === "ts") {
            return {
                needsChange: profile.allowRedownloads,
                direction: "upgrade",
                currentQuality,
                targetQuality,
                qualityCutoffNotMet,
                reason: "Format upgrade: TS -> MP4",
            };
        }

        return {
            needsChange: false,
            direction: "none",
            currentQuality,
            targetQuality,
            qualityCutoffNotMet,
            reason: `Current quality (${currentQuality || "UNKNOWN"}) matches target (${targetQuality})`,
        };
    }
}
