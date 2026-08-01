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
    // Global search renders album results as onClick cards. They are exposed as
    // buttons, so Enter and Space both have to activate them — a focusable
    // element that only responds to a pointer is not keyboard operable.
    it("activates an onClick card with Enter and Space", () => {
        const onClick = vi.fn();
        renderCard({ imageUrl: null, title: "Bad Blood", onClick });

        const card = screen.getByRole("button", { name: "Bad Blood" });
        expect(card).toHaveAttribute("tabindex", "0");

        fireEvent.keyDown(card, { key: "Enter" });
        fireEvent.keyDown(card, { key: " " });

        expect(onClick).toHaveBeenCalledTimes(2);
    });

    // A `to` card is a link, so Enter activates and Space does not, matching
    // native anchor behaviour.
    it("activates a link card with Enter only", () => {
        renderCard({ imageUrl: null, title: "Pompeii", to: "/album/pompeii" });

        const card = screen.getByRole("link", { name: "Pompeii" });
        expect(card).toHaveAttribute("tabindex", "0");

        fireEvent.keyDown(card, { key: " " });
        expect(window.location.pathname).not.toContain("pompeii");
    });

    it("exposes no nested interactive control inside the card surface", () => {
        renderCard({ imageUrl: null, title: "Bad Blood", onClick: vi.fn() });

        const card = screen.getByRole("button", { name: "Bad Blood" });
        expect(card.querySelectorAll("button, a, [role='button'], [role='link']")).toHaveLength(0);
    });

    it("stays non-interactive when the card has no action", () => {
        renderCard({ imageUrl: null, title: "Static" });

        expect(screen.queryByRole("button", { name: "Static" })).toBeNull();
        expect(screen.queryByRole("link", { name: "Static" })).toBeNull();
    });
});
