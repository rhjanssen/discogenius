export type UnmappedMediaFormat = {
    duration?: number | null;
    bitrate?: number | null;
    sampleRate?: number | null;
    bitsPerSample?: number | null;
    numberOfChannels?: number | null;
    codec?: string | null;
};

export function getUnmappedMediaMetrics(format: UnmappedMediaFormat | null | undefined, extension: string) {
    const bitrate = typeof format?.bitrate === "number" ? Math.round(format.bitrate) : null;
    const sampleRate = typeof format?.sampleRate === "number" ? Math.round(format.sampleRate) : null;
    const bitDepth = typeof format?.bitsPerSample === "number" ? Math.round(format.bitsPerSample) : null;
    const channels = typeof format?.numberOfChannels === "number" ? Math.round(format.numberOfChannels) : null;
    const codec = String(format?.codec || extension.toUpperCase().replace(".", "") || "").trim() || null;
    const audioQuality = [
        bitDepth ? `${bitDepth}-BIT` : "",
        sampleRate ? `${(sampleRate / 1000).toFixed(1)}KHZ` : "",
        codec || "",
    ].filter(Boolean).join(" ") || null;

    return {
        duration: typeof format?.duration === "number" ? Math.round(format.duration) : null,
        bitrate,
        sampleRate,
        bitDepth,
        channels,
        codec,
        audioQuality,
    };
}
