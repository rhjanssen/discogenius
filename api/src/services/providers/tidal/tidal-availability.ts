import { ProviderUnavailableError } from "../../download/provider-unavailable-error.js";

export function tidalTrackAvailability(track: {
    streamReady?: unknown;
    allowStreaming?: unknown;
}): "available" | "unavailable" | "unknown" {
    if (track.streamReady === false || track.allowStreaming === false) return "unavailable";
    if (track.streamReady === true || track.allowStreaming === true) return "available";
    return "unknown";
}

export async function assertTidalTrackAvailable(
    id: string,
    fetchTrack: (id: string) => Promise<{ streamReady?: unknown; allowStreaming?: unknown }>,
): Promise<void> {
    let track;
    try {
        track = await fetchTrack(id);
    } catch (error) {
        if ((error as { status?: number })?.status === 404) {
            throw new ProviderUnavailableError("tidal", "track", id, `TIDAL track ${id} is no longer available (404)`);
        }
        throw error;
    }
    if (tidalTrackAvailability(track) === "unavailable") {
        throw new ProviderUnavailableError("tidal", "track", id, `TIDAL track ${id} is not streamable in the configured region`);
    }
}
