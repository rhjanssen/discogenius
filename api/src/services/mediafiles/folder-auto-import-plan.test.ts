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

// ADR-2 step 2: untagged folders match the own catalog by distance with margin.
import type { AutoImportCandidateRelease } from "./folder-auto-import-plan.js";
const ART = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
function candidate(id: number, title: string, tracks: Array<[string, number]>, extra: Partial<AutoImportCandidateRelease> = {}): AutoImportCandidateRelease {
    return {
        id, mbid: `m-${id}`, title, releaseGroupTitle: title, artistMbid: ART, preferred: false,
        tracks: tracks.map(([t, sec], i) => ({ id: id * 100 + i, mbid: `t${id}-${i}`, recordingMbid: `r-${t}`, mediumPosition: 1, position: i + 1, title: t, durationMs: sec * 1000 })),
        ...extra,
    };
}
function loose(id: number, track: number, title: string, sec: number): AutoImportFile {
    return { id, libraryRoot: "/music/stereo", ignored: false, durationSeconds: sec, tags: { ALBUM: "1989 (Deluxe)", ALBUMARTIST: "Taylor Swift", TRACK: String(track), TITLE: title } };
}
const deluxe: Array<[string, number]> = [["Welcome to New York", 212], ["Blank Space", 231], ["Wonderland", 245]];
const standard: Array<[string, number]> = [["Welcome to New York", 212], ["Blank Space", 231]];
const looseFiles = [loose(1, 1, "Welcome To New York", 213), loose(2, 2, "Blank Space", 231), loose(3, 3, "Wonderland", 246)];

test("an untagged folder imports the closest catalog release; exact ties prefer the monitored edition", () => {
    const plan = planFolderAutoImport({
        files: looseFiles, libraries, findRelease, folderArtistMbid: ART,
        findCandidates: () => [candidate(1, "1989", standard), candidate(2, "1989 (Deluxe)", deluxe), candidate(3, "1989 (Deluxe)", deluxe, { preferred: true })],
    });
    assert.equal(plan.decision, "import");
    assert.equal(plan.decision === "import" && plan.editionId, 3);
});

test("an untagged folder goes to review when nothing is close or two different releases tie", () => {
    const none = planFolderAutoImport({ files: looseFiles, libraries, findRelease, findCandidates: () => [] });
    assert.match(none.decision === "review" ? none.reason : "", /No catalog release/);
    const wrong = planFolderAutoImport({ files: looseFiles, libraries, findRelease, folderArtistMbid: ART,
        findCandidates: () => [candidate(4, "1989 (Deluxe)", [["Other", 100], ["Songs", 100], ["Here", 100]])] });
    assert.equal(wrong.decision, "review");
    const tie = planFolderAutoImport({ files: looseFiles, libraries, findRelease, folderArtistMbid: ART,
        findCandidates: () => [candidate(5, "1989 (Deluxe)", deluxe), candidate(6, "1989 (Deluxe)", [["Welcome to New York", 212], ["Blank Space", 231], ["Wonderland (Live)", 246]])] });
    assert.match(tie.decision === "review" ? tie.reason : "", /Too close/);
});

test("same recordings: the edition whose titles fit wins over a monitored edition with other qualifiers (1989 deluxe vs tour edition)", () => {
    const sameRecordings = (c: AutoImportCandidateRelease) => ({ ...c, tracks: c.tracks.map((t, i) => ({ ...t, recordingMbid: `rec-${i}` })) });
    const memoFiles = [loose(1, 1, "Welcome to New York", 213), loose(2, 2, "Blank Space", 231), loose(3, 3, "Blank Space (voice memo)", 131)];
    for (const f of memoFiles) f.tags.ALBUM = "1989 (Deluxe)";
    const deluxe2014 = sameRecordings(candidate(7, "1989", [["Welcome to New York", 212], ["Blank Space", 231], ["Blank Space (voice memo)", 131]]));
    const tour2015 = sameRecordings(candidate(8, "1989 (tour edition)", [["Welcome to New York", 212], ["Blank Space", 231], ["Blank Space (guitar/vocal)", 131]], { preferred: true }));
    const plan = planFolderAutoImport({ files: memoFiles, libraries, findRelease, folderArtistMbid: ART, findCandidates: () => [tour2015, deluxe2014] });
    assert.equal(plan.decision, "import");
    assert.equal(plan.decision === "import" && plan.editionId, 7);
});

// ADR-13 steps 2b/3: online lookup hint and fingerprint tie-break/verification.
const stereo: Array<[string, number]> = [["Uncle Arthur", 133], ["Sell Me a Coat", 183], ["Rubber Band", 140]];
const bowieFiles = [1, 2, 3].map((n) => ({ id: n, libraryRoot: "/music/stereo", ignored: false, durationSeconds: stereo[n - 1][1],
    tags: { ALBUM: "David Bowie", ALBUMARTIST: "David Bowie", TRACK: String(n), TITLE: stereo[n - 1][0] } }) as AutoImportFile);
const withRecordings = (c: AutoImportCandidateRelease, prefix: string) => ({ ...c, tracks: c.tracks.map((t, i) => ({ ...t, recordingMbid: `${prefix}-${i}` })) });
const stereoRelease = withRecordings(candidate(10, "David Bowie", stereo), "st");
const monoRelease = withRecordings(candidate(11, "David Bowie", stereo, { title: "David Bowie" }), "mono");
const bowie = (fingerprints?: Map<number, string[]>) => planFolderAutoImport({ files: bowieFiles, libraries, findRelease, folderArtistMbid: ART,
    findCandidates: () => [monoRelease, stereoRelease], fingerprints });

test("two releases with different recordings that tie on tags ask for fingerprints", () => {
    const plan = bowie();
    assert.equal(plan.decision, "review");
    assert.equal(plan.decision === "review" && plan.needsEvidence, "fingerprint");
});

test("fingerprints settle a close call when they clearly favour one release", () => {
    const plan = bowie(new Map([[1, ["st-0"]], [2, ["st-1"]], [3, ["st-2", "other"]]]));
    assert.equal(plan.decision === "import" && plan.editionId, 10);
});

test("fingerprints without a clear margin keep the folder in review", () => {
    const plan = bowie(new Map([[1, ["st-0", "mono-0"]], [2, ["st-1", "mono-1"]], [3, ["st-2", "mono-2"]]]));
    assert.match(plan.decision === "review" ? plan.reason : "", /even by fingerprint/);
});

test("fingerprints that contradict a distance match veto it", () => {
    const plan = planFolderAutoImport({ files: bowieFiles, libraries, findRelease, folderArtistMbid: ART,
        findCandidates: () => [stereoRelease], fingerprints: new Map([[1, ["x"]], [2, ["y"]], [3, ["st-2"]]]) });
    assert.match(plan.decision === "review" ? plan.reason : "", /Fingerprints disagree/);
    const ok = planFolderAutoImport({ files: bowieFiles, libraries, findRelease, folderArtistMbid: ART, findCandidates: () => [stereoRelease] });
    assert.equal(ok.decision === "import" && ok.via, "distance");
});

test("no close catalog release asks for the online lookup", () => {
    const plan = planFolderAutoImport({ files: bowieFiles, libraries, findRelease, folderArtistMbid: ART, findCandidates: () => [] });
    assert.equal(plan.decision === "review" && plan.needsEvidence, "online");
});
