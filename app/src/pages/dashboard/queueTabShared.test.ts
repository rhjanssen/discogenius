import { describe, expect, it } from "vitest";
import {
    isInteractiveElementTarget,
    isQueueRowActivationKey,
} from "./queueTabShared";

describe("queue row accessibility helpers", () => {
    it("accepts the standard keyboard activation keys", () => {
        expect(isQueueRowActivationKey("Enter")).toBe(true);
        expect(isQueueRowActivationKey(" ")).toBe(true);
        expect(isQueueRowActivationKey("Escape")).toBe(false);
    });

    it("recognizes nested controls so their activation is not repeated by the row", () => {
        const row = document.createElement("div");
        const button = document.createElement("button");
        const icon = document.createElement("span");
        button.append(icon);
        row.append(button);

        expect(isInteractiveElementTarget(icon)).toBe(true);
        expect(isInteractiveElementTarget(row)).toBe(false);
    });
});
