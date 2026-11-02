import assert from "node:assert/strict";
import test from "node:test";

import {
    planFolderAutoImport,
    type AutoImportCandidateRelease,
    type AutoImportFile,
} from "./folder-auto-import-plan.js";

/**
 * The 33-file Lidarr library from issue #70: David Bowie's 1967 album (14)
 * plus Taylor Swift's 1989 deluxe (19). Files carry album, artist, title,
 * track number and duration, and Bowie's recording ids. They do not carry a
 * MusicBrainz release id. The wrong editions are listed first.
 */
const BOWIE_EDITION = "b971735b-2c49-48c9-845d-076310742673";
const DELUXE_EDITION = "eb1acde0-35b3-4acc-bd36-b5a7037b7f38";
const BOOTLEG_EDITION = "5e045192-76e0-4234-8de5-31b7a38c601f";
const BOWIE_ARTIST = "5441c29d-3602-4898-b1a1-b77fa23b8e50";
const SWIFT_ARTIST = "20244d07-534f-4eff-b4d4-930878889970";

const libraries = [{ id: 1, rootPath: "/music/stereo" }];
const findRelease = () => null;
const fingerprints = new Map<number, string[]>();

type TrackRow = [title: string, lengthMs: number, recordingMbid: string];

const bowieTracks: TrackRow[] = [
    ["Uncle Arthur", 132946, "87d8cbad-f34e-4162-a809-a38fd49248f8"],
    ["Sell Me a Coat", 183040, "008fbf08-649f-4257-b6cc-78cb6d441c22"],
    ["Rubber Band", 140333, "3f0b540a-fed2-4ec8-b8dd-e2d19c660eee"],
    ["Love You Till Tuesday", 193973, "24b01ae9-c5ae-434a-b5b4-bfbd7af04cb4"],
    ["There Is a Happy Land", 196293, "a45052d7-d5f0-4b60-afdd-9a72a8755507"],
    ["We Are Hungry Men", 180640, "2a851410-fb7e-439c-82f1-439cb98606e7"],
    ["When I Live My Dream", 206773, "725a4d31-5e4a-413d-80a7-eb40c6d1e8a4"],
    ["Little Bombardier", 208120, "56838c0b-5fbb-4b8c-a041-e6fcee78c75e"],
    ["Silly Boy Blue", 234266, "2e3ae1f9-3f3d-4480-b6ec-65ed14455f80"],
    ["Come and Buy My Toys", 130586, "f2c28327-2f24-4108-9ad0-5c3fa3cb9cfa"],
    ["Join the Gang", 141320, "ffc068b1-8b43-44c4-a891-725ad5b5267d"],
    ["She’s Got Medals", 146440, "0e5fca0a-93be-4295-8546-d6c9f063a8ed"],
    ["Maid of Bond Street", 105866, "ca638ace-b2f0-4437-bd2a-74e70d1a40f5"],
    ["Please Mr. Gravedigger", 165346, "09fae20a-a5b8-4263-a49b-aa9d7d48dde3"],
];

const swiftTracks: TrackRow[] = [
    ["Welcome to New York", 212600, "3c2fefb5-ca6a-4793-b044-babc85bed24e"],
    ["Blank Space", 231826, "c3fe7791-0a91-4f0a-a89b-b056f38d3cde"],
    ["Style", 231000, "4459f042-afff-4fa3-b5e5-e10d9782992d"],
    ["Out of the Woods", 235800, "6c63a910-6e61-445f-8fbe-3bd17b954c95"],
    ["All You Had to Do Was Stay", 193293, "035c98ee-1aae-4c19-bb2b-7f22a42807d3"],
    ["Shake It Off", 219200, "59fc5ddf-a1d9-4746-902d-71fb5a9a78c2"],
    ["I Wish You Would", 207440, "ed00ad44-7707-4fe1-ba79-79073144dcff"],
    ["Bad Blood", 211933, "914f6a27-fce4-4a75-9267-049b51a1b086"],
    ["Wildest Dreams", 220440, "598bc2a9-1a27-4f6a-a7cc-30649303edca"],
    ["How You Get the Girl", 247533, "4324d234-b2f0-4018-9bd4-9241983b9a79"],
    ["This Love", 250093, "84bd2543-751d-4f56-a840-f28106b31fb7"],
    ["I Know Places", 195706, "adfcdd81-4129-436b-97d1-7aa522392583"],
    ["Clean", 271000, "ca9c624b-2272-49d4-a25b-2235659de660"],
    ["Wonderland", 245560, "cba4e253-78e4-43cf-8044-6af0f62b4d13"],
    ["You Are in Love", 267106, "d391479e-b32d-47ea-8e43-62338d4ea6ad"],
    ["New Romantics", 230466, "dd7b009d-8890-4ab6-b6f7-cde626c33ed9"],
    ["I Know Places (voice memo)", 216333, "34f4c934-6123-447f-a726-f1145211e22e"],
    ["I Wish You Would (voice memo)", 107133, "7b319612-c300-4c3f-b898-5fa24e0246de"],
    ["Blank Space (voice memo)", 131186, "ede9b083-a70d-41eb-8602-afd6374f133e"],
];

function release(
    id: number,
    mbid: string,
    title: string,
    groupTitle: string,
    artistName: string,
    artistMbid: string,
    tracks: TrackRow[],
    extra: Partial<AutoImportCandidateRelease> = {},
): AutoImportCandidateRelease {
    return {
        id,
        mbid,
        title,
        releaseGroupTitle: groupTitle,
        artistMbid,
        artistName,
        preferred: false,
        albumYear: extra.albumYear,
        releaseYear: extra.releaseYear,
        mediaCount: 1,
        mediaFormats: extra.mediaFormats ?? ["CD"],
        countries: extra.countries ?? [],
        tracks: tracks.map(([trackTitle, lengthMs, recordingMbid], index) => ({
            id: id * 100 + index + 1,
            mbid: `${mbid}-t${index + 1}`,
            recordingMbid,
            mediumPosition: 1,
            position: index + 1,
            title: trackTitle,
            durationMs: lengthMs,
        })),
        ...extra,
    };
}

function filesFor(
    tracks: TrackRow[],
    album: string,
    artist: string,
    year: string,
    options: { recordingIds?: boolean; startId?: number } = {},
): AutoImportFile[] {
    const startId = options.startId ?? 1;
    return tracks.map(([title, lengthMs, recordingMbid], index) => ({
        id: startId + index,
        libraryRoot: "/music/stereo",
        ignored: false,
        durationSeconds: Math.round(lengthMs / 1000),
        tags: {
            ALBUM: album,
            ALBUMARTIST: artist,
            TITLE: title.replace("She’s", "She's"),
            TRACK: String(index + 1),
            DISC: "1",
            DATE: year,
            ...(options.recordingIds ? { MUSICBRAINZ_TRACKID: recordingMbid } : {}),
        },
    }));
}

test("33 Lidarr files import to Bowie 1967 and 1989 D.L.X., never the bootleg", () => {
    const bowieFiles = filesFor(bowieTracks, "David Bowie", "David Bowie", "1967", { recordingIds: true });
    const swiftFiles = filesFor(swiftTracks, "1989", "Taylor Swift", "2014", { startId: 100 });
    assert.equal(bowieFiles.length + swiftFiles.length, 33);

    const usTracks = bowieTracks
        .filter((track) => track[0] !== "We Are Hungry Men" && track[0] !== "Maid of Bond Street")
        .map(([title, lengthMs], index): TrackRow => [title, lengthMs, `us-${index}`]);
    const monoTracks = bowieTracks.map(([title, lengthMs], index): TrackRow => [title, lengthMs, `mono-${index}`]);
    const bowieCandidates = [
        release(12, "us-1967-short", "David Bowie", "David Bowie", "David Bowie", BOWIE_ARTIST, usTracks, {
            albumYear: 1967, releaseYear: 1967, countries: ["US"], preferred: true,
        }),
        release(11, "mono-1967", "David Bowie", "David Bowie", "David Bowie", BOWIE_ARTIST, monoTracks, {
            albumYear: 1967, releaseYear: 1967, countries: ["GB"], mediaFormats: ["Vinyl"],
        }),
        release(1967, BOWIE_EDITION, "David Bowie", "David Bowie", "David Bowie", BOWIE_ARTIST, bowieTracks, {
            albumYear: 1967, releaseYear: 2016, countries: ["JP"], mediaFormats: ["SHM-CD"],
        }),
    ];
    const bowie = planFolderAutoImport({
        files: bowieFiles,
        libraries,
        findRelease,
        folderArtistMbid: BOWIE_ARTIST,
        fingerprints,
        findCandidates: () => bowieCandidates,
    });
    assert.equal(bowie.decision, "import", bowie.decision === "review" ? bowie.reason : "");
    if (bowie.decision !== "import") return;
    assert.equal(bowie.editionId, 1967);
    assert.equal(bowieCandidates.find((candidate) => candidate.id === bowie.editionId)?.mbid, BOWIE_EDITION);
    assert.equal(bowie.mappings.length, 14);

    const bootlegTracks = swiftTracks.slice(0, 13).map(([title, lengthMs], index): TrackRow => [title, lengthMs, `boot-${index}`]);
    const swiftCandidates = [
        release(2015, BOOTLEG_EDITION, "1989", "1989", "Taylor Swift", SWIFT_ARTIST, bootlegTracks, {
            albumYear: 2014, releaseYear: 2014, countries: ["XW"], mediaFormats: ["Cassette"], preferred: true,
        }),
        release(2014, DELUXE_EDITION, "1989 D.L.X.", "1989", "Taylor Swift", SWIFT_ARTIST, swiftTracks, {
            albumYear: 2014, releaseYear: 2014, countries: ["XE"],
        }),
    ];
    const swift = planFolderAutoImport({
        files: swiftFiles,
        libraries,
        findRelease,
        folderArtistMbid: SWIFT_ARTIST,
        fingerprints,
        findCandidates: () => swiftCandidates,
    });
    assert.equal(swift.decision, "import", swift.decision === "review" ? swift.reason : "");
    if (swift.decision !== "import") return;
    assert.equal(swift.editionId, 2014);
    assert.equal(swiftCandidates.find((candidate) => candidate.id === swift.editionId)?.mbid, DELUXE_EDITION);
    assert.notEqual(swift.editionId, 2015);
    assert.equal(swift.mappings.length, 19);
});

test("minimal album/title/track tags tie on the first candidate, not the monitored one", () => {
    const tracks = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];
    const files: AutoImportFile[] = tracks.map((title, index) => ({
        id: index + 1,
        libraryRoot: "/music/stereo",
        ignored: false,
        durationSeconds: null,
        tags: { ALBUM: "Same Album", TITLE: title, TRACK: String(index + 1) },
    }));
    const same = (id: number, preferred: boolean): AutoImportCandidateRelease => ({
        id,
        mbid: `same-${id}`,
        title: "Same Album",
        releaseGroupTitle: "Same Album",
        artistMbid: "artist",
        artistName: "Artist",
        preferred,
        mediaCount: 1,
        mediaFormats: ["CD"],
        countries: ["US"],
        tracks: tracks.map((title, index) => ({
            id: id * 10 + index,
            mbid: null,
            recordingMbid: null,
            mediumPosition: 1,
            position: index + 1,
            title,
            durationMs: null,
        })),
    });
    const plan = planFolderAutoImport({
        files,
        libraries,
        findRelease,
        fingerprints,
        findCandidates: () => [same(1, false), same(2, true)],
    });
    assert.equal(plan.decision, "import", plan.decision === "review" ? plan.reason : "");
    if (plan.decision === "import") assert.equal(plan.editionId, 1);
});
