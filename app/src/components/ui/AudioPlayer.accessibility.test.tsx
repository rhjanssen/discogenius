import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioPlayer } from "./AudioPlayer";

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe("AudioPlayer seek control accessibility", () => {
    it("exposes slider state and supports keyboard seeking", () => {
        vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
        vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);

        render(
            <AudioPlayer
                src="/api/files/1/stream"
                knownDuration={120}
                autoPlay={false}
            />
        );

        const audio = document.querySelector("audio");
        const slider = screen.getByRole("slider", { name: "Seek audio" });
        expect(audio).not.toBeNull();
        expect(slider).toHaveAttribute("tabindex", "0");
        expect(slider).toHaveAttribute("aria-valuemin", "0");
        expect(slider).toHaveAttribute("aria-valuemax", "120");
        expect(slider).toHaveAttribute("aria-valuenow", "0");
        expect(slider).toHaveAttribute("aria-valuetext", "0:00 of 2:00");

        fireEvent.timeUpdate(audio!, { target: { currentTime: 30 } });
        expect(slider).toHaveAttribute("aria-valuenow", "30");

        fireEvent.keyDown(slider, { key: "ArrowRight" });
        expect(audio!.currentTime).toBe(31);
        expect(slider).toHaveAttribute("aria-valuenow", "31");

        fireEvent.keyDown(slider, { key: "End" });
        expect(audio!.currentTime).toBe(120);
        expect(slider).toHaveAttribute("aria-valuetext", "2:00 of 2:00");

        fireEvent.keyDown(slider, { key: "ArrowLeft" });
        expect(audio!.currentTime).toBe(119);

        fireEvent.keyDown(slider, { key: "Home" });
        expect(audio!.currentTime).toBe(0);
    });

    it("keeps an unavailable-duration seek control out of the tab order", () => {
        vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
        vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);

        render(<AudioPlayer src="/api/files/1/stream" autoPlay={false} />);

        const slider = screen.getByRole("slider", { name: "Seek audio" });
        expect(slider).toHaveAttribute("aria-disabled", "true");
        expect(slider).toHaveAttribute("tabindex", "-1");
    });
});
