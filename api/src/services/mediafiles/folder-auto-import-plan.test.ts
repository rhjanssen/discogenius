import assert from "node:assert/strict";
import test from "node:test";

import { planFolderAutoImport, type AutoImportFile, type AutoImportRelease } from "./folder-auto-import-plan.js";

const REL = "11111111-1111-1111-1111-111111111111";
const release: AutoImportRelease = {
    id: 7,
    mbid: REL,
    tracks: [
        { id: 70, mbid: "t-1", recordingMbid: "r-1", mediumPosition: 1, position: 1, title: "Intro", durationMs: 60_000 },
        { id: 71, mbid: "t-2", recordingMbid: "r-2", mediumPosition: 1, position: 2, title: "Little Bombardier", durationMs: 200_000 },
    ],
};
const libraries = [{ id: 1, rootPath: "/music/stereo/" }];
const findRelease = (mbid: string) => (mbid === REL ? release : null);

function file(id: number, tags: Record<string, string>, extra: Partial<AutoImportFile> = {}): AutoImportFile {
    return { id, libraryRoot: "/music/stereo", ignored: false, durationSeconds: null, tags: { MUSICBRAINZ_ALBUMID: REL, ...tags }, ...extra };
}

test("maps by track MBID, recording MBID or position+title", () => {
    const plan = planFolderAutoImport({
        files: [
            file(1, { MUSICBRAINZ_RELEASETRACKID: "t-1" }),
            file(2, { "MusicBrainz Track Id": "r-2" }),
        ],
        libraries,
        findRelease,
    });
    assert.deepEqual(plan, { decision: "import", libraryId: 1, editionId: 7, mappings: [
        { unmappedFileId: 1, trackId: 70 }, { unmappedFileId: 2, trackId: 71 },
    ] });

    const byPosition = planFolderAutoImport({
        files: [file(3, { track: "2/2", disc: "1/1", title: "Little  Bombardier!" })],
        libraries,
        findRelease,
    });
    assert.equal(byPosition.decision, "import");
});

test("sends uncertain folders to review with a reason", () => {
    const cases: Array<[AutoImportFile[], RegExp]> = [
        [[file(1, { MUSICBRAINZ_ALBUMID: "" })], /no MusicBrainz release id/],
        [[file(1, { MUSICBRAINZ_ALBUMID: "22222222-2222-2222-2222-222222222222" })], /not in the catalog/],
        [[file(1, { MUSICBRAINZ_RELEASETRACKID: "t-1" }), file(2, { MUSICBRAINZ_RELEASETRACKID: "t-1" })], /Two files map/],
        [[file(1, { track: "2", title: "Something else" })], /matches no track/],
        [[file(1, { MUSICBRAINZ_RELEASETRACKID: "t-2" }, { durationSeconds: 120 })], /length differs/],
        [[file(1, { MUSICBRAINZ_RELEASETRACKID: "t-1" }, { libraryRoot: "/elsewhere" })], /No enabled library/],
        [[file(1, { MUSICBRAINZ_RELEASETRACKID: "t-1" }, { ignored: true })], /ignored/],
    ];
    for (const [files, reason] of cases) {
        const plan = planFolderAutoImport({ files, libraries, findRelease });
        assert.equal(plan.decision, "review");
        assert.match(plan.decision === "review" ? plan.reason : "", reason);
    }
});

test("is all-or-nothing: one unmatched file blocks the folder", () => {
    const plan = planFolderAutoImport({
        files: [file(1, { MUSICBRAINZ_RELEASETRACKID: "t-1" }), file(2, { title: "Unknown" })],
        libraries,
        findRelease,
    });
    assert.equal(plan.decision, "review");
});
