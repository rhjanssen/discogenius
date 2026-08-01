import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useGlobalEvents } from "@/hooks/useGlobalEvents";

type StreamCallbacks = {
  onError: (error: Error) => void;
  onOpen: () => void;
  close: ReturnType<typeof vi.fn>;
};

function GlobalEventConsumer() {
  useGlobalEvents(["command.updated"]);
  return null;
}

describe("useGlobalEvents", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps reconnecting with capped backoff and resets the delay when a stream opens", () => {
    const streams: StreamCallbacks[] = [];
    vi.spyOn(api, "createGlobalEventStream").mockImplementation((_onEvent, onError, onOpen) => {
      const stream = {
        onError: onError!,
        onOpen: onOpen!,
        close: vi.fn(),
      };
      streams.push(stream);
      return { close: stream.close } as unknown as EventSource;
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<GlobalEventConsumer />);
    });
    expect(streams).toHaveLength(1);

    // Exceed the old five-attempt limit. Advancing by the 30-second cap
    // observes exactly one reconnect per injected failure.
    for (let attempt = 0; attempt < 8; attempt++) {
      act(() => {
        streams[attempt].onError(new Error("offline"));
      });
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(streams).toHaveLength(attempt + 2);
    }

    // Opening the latest stream resets the next failure to the one-second
    // initial delay, even when the stream has not emitted a domain event.
    act(() => {
      streams[8].onOpen();
      streams[8].onError(new Error("offline again"));
      vi.advanceTimersByTime(999);
    });
    expect(streams).toHaveLength(9);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(streams).toHaveLength(10);
  });
});
