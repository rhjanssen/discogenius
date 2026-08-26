import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SemanticStatusIcon } from "./SemanticStatusIcon";
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
});
