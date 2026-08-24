import { describe, expect, it } from "vitest";
import type { UnmappedFile } from "./ManualImportTab";
import { groupUnmappedFilesForReview, normalizeComparableText } from "./manualImportGrouping";

function ampersandFile(id: number): UnmappedFile {
    const filename = `${String(id).padStart(2, "0")} - Track ${id}.flac`;
    return {
        id,
        file_path: `C:\\Music\\Bastille\\& (Ampersand) (2024)\\${filename}`,
        relative_path: `Bastille/& (Ampersand) (2024)/${filename}`,
        library_root: "music",
        filename,
        extension: "flac",
        file_size: 1_000,
        detected_artist: "Bastille",
        detected_album: "&",
        detected_track: `Track ${id}`,
        ignored: false,
    };
}

describe("manual import album grouping", () => {
    it("preserves ampersands as comparable title content", () => {
        expect(normalizeComparableText("&")).toBe("and");
        expect(normalizeComparableText("Intros & Narrators")).toBe("intros and narrators");
    });

    it("keeps an ampersand-titled album together as one review row", () => {
        const groups = groupUnmappedFilesForReview(Array.from({ length: 14 }, (_, index) => ampersandFile(index + 1)));

        expect(groups).toHaveLength(1);
        expect(groups[0]).toHaveLength(14);
        expect(groups[0][0].detected_album).toBe("&");
    });
});
