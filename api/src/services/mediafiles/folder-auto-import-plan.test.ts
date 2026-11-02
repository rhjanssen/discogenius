import assert from "node:assert/strict";
import test from "node:test";

import { isAutoImportStatusAllowed, planFolderAutoImport, type AutoImportFile, type AutoImportRelease } from "./folder-auto-import-plan.js";

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

// ADR-13: untagged folders match the own catalog the way Lidarr does.
import type { AutoImportCandidateRelease } from "./folder-auto-import-plan.js";
import { munkres, trackDistance as lidarrTrackDistance } from "./lidarr-distance.js";
const ART = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
function candidate(id: number, title: string, tracks: Array<[string, number]>, extra: Partial<AutoImportCandidateRelease> = {}): AutoImportCandidateRelease {
    return {
        id, mbid: `m-${id}`, title, releaseGroupTitle: title, artistMbid: ART, artistName: "Taylor Swift", preferred: false, countries: ["XE"],
        tracks: tracks.map(([t, sec], i) => ({ id: id * 100 + i, mbid: `t${id}-${i}`, recordingMbid: `r-${t}`, mediumPosition: 1, position: i + 1, title: t, durationMs: sec * 1000 })),
        ...extra,
    };
}
function loose(id: number, track: number, title: string, sec: number, album = "1989"): AutoImportFile {
    return { id, libraryRoot: "/music/stereo", ignored: false, durationSeconds: sec, tags: { ALBUM: album, ALBUMARTIST: "Taylor Swift", TRACK: String(track), TITLE: title } };
}
const deluxe: Array<[string, number]> = [["Welcome to New York", 212], ["Blank Space", 231], ["Wonderland", 245]];
const looseFiles = [loose(1, 1, "Welcome To New York", 213), loose(2, 2, "Blank Space", 231), loose(3, 3, "Wonderland", 246)];
const none = new Map<number, string[]>();

test("lowest distance wins; on an exact tie the first candidate wins (no monitored preference)", () => {
    const plan = planFolderAutoImport({ files: looseFiles, libraries, findRelease, folderArtistMbid: ART, fingerprints: none,
        findCandidates: () => [candidate(2, "1989", deluxe), candidate(3, "1989", deluxe, { preferred: true })] });
    assert.equal(plan.decision === "import" && plan.editionId, 2);
});

test("no candidate asks for the online lookup; a distant one is rejected", () => {
    const empty = planFolderAutoImport({ files: looseFiles, libraries, findRelease, findCandidates: () => [] });
    assert.equal(empty.decision === "review" && empty.needsEvidence, "online");
    const wrong = planFolderAutoImport({ files: looseFiles, libraries, findRelease, folderArtistMbid: ART, fingerprints: none,
        findCandidates: () => [candidate(4, "Lover", [["Other", 100], ["Songs", 100], ["Here", 100]])] });
    assert.equal(wrong.decision, "review");
});

test("1989: the deluxe (voice memo) beats the tour edition (guitar/vocal) on track titles", () => {
    const memo = [loose(1, 1, "Welcome to New York", 213), loose(2, 2, "Blank Space", 231), loose(3, 3, "Blank Space (voice memo)", 131)];
    const tour = candidate(8, "1989", [["Welcome to New York", 212], ["Blank Space", 231], ["Blank Space (guitar/vocal)", 131]], { preferred: true });
    const dlx = candidate(7, "1989", [["Welcome to New York", 212], ["Blank Space", 231], ["Blank Space (voice memo)", 131]]);
    const plan = planFolderAutoImport({ files: memo, libraries, findRelease, folderArtistMbid: ART, fingerprints: none, findCandidates: () => [tour, dlx] });
    assert.equal(plan.decision === "import" && plan.editionId, 7);
});

test("Lidarr ShouldFingerprint: missing tracks ask for fingerprints first", () => {
    const plan = planFolderAutoImport({ files: looseFiles.slice(0, 2), libraries, findRelease, folderArtistMbid: ART, findCandidates: () => [candidate(2, "1989", deluxe)] });
    assert.equal(plan.decision === "review" && plan.needsEvidence, "fingerprint");
    const after = planFolderAutoImport({ files: looseFiles.slice(0, 2), libraries, findRelease, folderArtistMbid: ART, fingerprints: none, findCandidates: () => [candidate(2, "1989", deluxe)] });
    assert.equal(after.decision === "import" && after.mappings.length, 2);
});

test("fingerprints count as recording_id in the track distance (Bowie stereo vs mono)", () => {
    const tracks: Array<[string, number]> = [["Uncle Arthur", 133], ["Sell Me a Coat", 183], ["Rubber Band", 140]];
    const files = tracks.map(([t, sec], i) => ({ id: i + 1, libraryRoot: "/music/stereo", ignored: false, durationSeconds: sec, tags: { ALBUM: "David Bowie", ALBUMARTIST: "David Bowie", TRACK: String(i + 1), TITLE: t } }) as AutoImportFile);
    const rec = (c: AutoImportCandidateRelease, prefix: string) => ({ ...c, artistName: "David Bowie", tracks: c.tracks.map((t, i) => ({ ...t, recordingMbid: `${prefix}-${i}` })) });
    const mono = rec(candidate(11, "David Bowie", tracks), "mono");
    const stereo = rec(candidate(10, "David Bowie", tracks), "st");
    const plan = planFolderAutoImport({ files, libraries, findRelease, folderArtistMbid: ART, findCandidates: () => [mono, stereo],
        fingerprints: new Map([[1, ["st-0"]], [2, ["st-1"]], [3, ["st-2"]]]) });
    assert.equal(plan.decision === "import" && plan.editionId, 10);
});

test("CloseTrackMatch: a file over 0.40 stays in Unmapped, the rest imports", () => {
    const files = [...looseFiles, loose(9, 9, "Completely Different Jam", 600)];
    const plan = planFolderAutoImport({ files, libraries, findRelease, folderArtistMbid: ART, fingerprints: none, findCandidates: () => [candidate(2, "1989", deluxe)] });
    assert.deepEqual(plan.decision === "import" && plan.mappings.map((m) => m.unmappedFileId).sort(), [1, 2, 3]);
});

test("Munkres finds the minimum-cost pairing where greedy would not", () => {
    assert.deepEqual(munkres([[0.1, 0.2], [0.15, 0.9]]), [[0, 1], [1, 0]]);
    assert.deepEqual(munkres([[0.5], [0.1], [0.3]]), [[1, 0]]);
});

test("track length: free up to 10 s, full penalty at 40 s", () => {
    const local = { id: 1, title: "X", artist: null, album: null, trackNumber: null, discNumber: null, discCount: null, year: null, country: null, label: null, disambiguation: null, releaseMbid: null, recordingMbid: null, durationSeconds: 110 };
    const mb = { id: 1, title: "X", position: 1, mediumPosition: 1, durationMs: 100_000, recordingMbid: null };
    assert.equal(lidarrTrackDistance(local, mb, 1).penalties.get("track_length")?.[0], 0);
    assert.equal(lidarrTrackDistance({ ...local, durationSeconds: 140 }, mb, 1).penalties.get("track_length")?.[0], 1);
});

test("bootlegs only when the status filter includes them and a provider offers the release", () => {
    assert.equal(isAutoImportStatusAllowed("Official", true, false), true);
    assert.equal(isAutoImportStatusAllowed("Bootleg", false, true), false);
    assert.equal(isAutoImportStatusAllowed("Bootleg", true, false), false);
    assert.equal(isAutoImportStatusAllowed("Bootleg", true, true), true);
    assert.equal(isAutoImportStatusAllowed("Promotion", false, true), false);
});
