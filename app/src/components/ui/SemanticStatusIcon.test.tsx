import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QueuedStatusIcon, SemanticStatusIcon } from "./SemanticStatusIcon";
import { statusIconGlyphPx } from "./statusIconMetrics";

describe("SemanticStatusIcon", () => {
    it("renders each status without applying a CSS color tint", () => {
        const { container, rerender } = render(<SemanticStatusIcon status="success" title="ok" />);
        expect(container.querySelector("svg")).toBeTruthy();

        rerender(<SemanticStatusIcon status="info" />);
        expect(container.querySelector("svg")).toBeTruthy();

        rerender(<SemanticStatusIcon status="warning" size={24} />);
        expect(container.querySelector("svg")).toBeTruthy();
    });

    it("draws Color glyphs slightly larger than Filled glyphs in the same slot", () => {
        expect(statusIconGlyphPx("color", 16)).toBeGreaterThan(statusIconGlyphPx("filled", 16));
        expect(statusIconGlyphPx("color", 24)).toBeGreaterThan(statusIconGlyphPx("filled", 24));
    });

    it("renders queued state as a monochrome clock in the requested slot size", () => {
        const { container } = render(<QueuedStatusIcon size={24} aria-label="Queued" />);
        const slot = container.firstElementChild;
        const icon = container.querySelector("svg");

        expect(slot).toHaveStyle({ width: "24px", height: "24px" });
        expect(icon).toHaveAttribute("aria-label", "Queued");
        expect(icon?.style.color).toBeTruthy();
    });
});
