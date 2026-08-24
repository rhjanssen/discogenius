import axe from "axe-core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaCard } from "./MediaCard";

afterEach(cleanup);

type CardProps = Parameters<typeof MediaCard>[0];

function renderCard(props: Omit<CardProps, "alt">) {
    return render(<MemoryRouter><MediaCard alt="" {...props} /></MemoryRouter>);
}

describe("MediaCard accessibility", () => {
    it("uses a native button for a custom primary action", () => {
        const onClick = vi.fn();
        renderCard({ imageUrl: null, title: "Bad Blood", onClick });

        const action = screen.getByRole("button", { name: "Bad Blood" });
        fireEvent.click(action);

        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("uses a native link for route navigation", () => {
        renderCard({ imageUrl: null, title: "Pompeii", to: "/album/pompeii" });

        expect(screen.getByRole("link", { name: "Pompeii" })).toHaveAttribute("href", "/album/pompeii");
    });

    it("keeps primary and monitor actions as sibling controls", () => {
        renderCard({
            imageUrl: null,
            title: "Bad Blood",
            onClick: vi.fn(),
            monitored: true,
            onMonitorToggle: vi.fn(),
        });

        const primary = screen.getByRole("button", { name: "Bad Blood" });
        const monitor = screen.getByRole("button", { name: "Unmonitor Bad Blood" });
        expect(primary.contains(monitor)).toBe(false);
        expect(monitor.contains(primary)).toBe(false);
    });

    it("stays non-interactive when the card has no action", () => {
        renderCard({ imageUrl: null, title: "Static" });

        expect(screen.queryByRole("button", { name: "Static" })).toBeNull();
        expect(screen.queryByRole("link", { name: "Static" })).toBeNull();
    });

    it("has no automated accessibility violations with separate actions", async () => {
        const { container } = renderCard({
            imageUrl: null,
            title: "Bad Blood",
            subtitle: "Bastille",
            to: "/album/bad-blood",
            monitored: false,
            onMonitorToggle: vi.fn(),
        });

        const results = await axe.run(container);
        expect(results.violations).toEqual([]);
    });
});
