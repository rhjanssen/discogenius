import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useTrackPlayback, type PlayableTrack } from "@/hooks/useTrackPlayback";

const toastMock = vi.fn();
vi.mock("@/hooks/useToast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

describe("useTrackPlayback fallback error handling", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    toastMock.mockReset();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
    vi.restoreAllMocks();
  });

  it("stops after a single fallback attempt when both local and preview streams fail", async () => {
    const signSpy = vi.spyOn(api, "signTrackPreviewStream").mockResolvedValue({
      url: "https://preview.example/stream.mp3",
      hlsUrl: undefined,
      quality: "HIGH",
    } as any);

    const track: PlayableTrack = {
      id: "trk-1",
      preview_provider: "tidal",
      preview_provider_track_id: "prov-1",
      downloaded: true,
      files: [
        {
          id: 10,
          file_type: "track",
          extension: "flac",
          codec: "flac",
        },
      ],
    };

    let hookApi!: ReturnType<typeof useTrackPlayback>;
    function Harness() {
      hookApi = useTrackPlayback();
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<Harness />);
    });

    // First playback error switches from local file to browser-compatible preview.
    await act(async () => {
      await hookApi.handleTrackPlaybackError(track);
    });
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(hookApi.playingTrackId).toBe("trk-1");

    // Second playback error (fallback stream also fails) must STOP instead of ping-ponging back to local.
    await act(async () => {
      await hookApi.handleTrackPlaybackError(track);
    });
    expect(hookApi.playingTrackId).toBeNull();
    expect(toastMock).toHaveBeenLastCalledWith(expect.objectContaining({
      title: "Playback failed",
      variant: "destructive",
    }));
  });
});
