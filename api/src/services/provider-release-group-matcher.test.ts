import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-provider-release-group-matcher-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../database.js");
dbModule.initDatabase();

import { matchProviderAlbumToReleaseGroup } from "./metadata/provider-release-group-matcher.js";
const { selectReleaseGroupSlotAlbums } = await import("./release-group-slot-service.js");

const releaseGroups = [
    {
        mbid: "bc411157-431c-4f04-81e1-18e1c21d50ec",
        title: "Give Me the Future",
        primaryType: "Album",
        secondaryTypes: [],
        firstReleaseDate: "2022-02-04",
        releases: [
            {
                mbid: "db967b8b-99c1-4adf-8d12-f0ab285390b3",
                barcode: "602445123456",
                trackCount: 13,
                mediaCount: 1,
                isrcs: ["GBUM72108111", "GBUM72108112"],
            },
        ],
    },
    {
        mbid: "9a2e82b9-aaaa-4a1d-98ef-19f0641ce38a",
        title: "Doom Days",
        primaryType: "Album",
        secondaryTypes: [],
        firstReleaseDate: "2019-06-14",
        releases: [],
    },
];

const ampersandReleaseGroups = [
    {
        mbid: "b35978dd-8069-4c75-b9e0-6f6327900823",
        title: "&",
        primaryType: "Album",
        secondaryTypes: [],
        firstReleaseDate: "2024-10-25",
        releases: [
            { mbid: "ampersand-album-release", trackCount: 14, mediaCount: 1 },
        ],
    },
    {
        mbid: "64589d51-4d3a-48ac-89cd-e268eb5c6117",
        title: "“&” (Ampersand), Part One",
        primaryType: "EP",
        secondaryTypes: [],
        firstReleaseDate: "2024-07-26",
        releases: [
            { mbid: "ampersand-part-one-release", trackCount: 4, mediaCount: 1 },
        ],
    },
];

test("matches expanded provider editions to the MusicBrainz release group", () => {
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "243863069",
        title: "Give Me The Future + Dreams Of The Past",
        releaseDate: "2022-08-26",
        type: "ALBUM",
    }, releaseGroups);

    assert.equal(match.status, "probable");
    assert.equal(match.releaseGroup?.mbid, "bc411157-431c-4f04-81e1-18e1c21d50ec");
    assert.ok(match.confidence >= 0.78);
});

test("marks exact title and type matches as verified", () => {
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "214357460",
        title: "Give Me The Future",
        releaseDate: "2022-02-04",
        type: "ALBUM",
    }, releaseGroups);

    assert.equal(match.status, "verified");
    assert.equal(match.releaseGroup?.mbid, "bc411157-431c-4f04-81e1-18e1c21d50ec");
});

test("prefers an exact title over a nearby version even when release dates differ", () => {
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "liar-liar-acoustic",
        title: "Liar Liar (Acoustic)",
        releaseDate: "2023-08-04",
        type: "SINGLE",
        trackCount: 1,
        volumeCount: 1,
    }, [
        {
            mbid: "liar-liar",
            title: "Liar Liar",
            primaryType: "Single",
            firstReleaseDate: "2023-08-04",
            releases: [{ mbid: "liar-liar-release", trackCount: 1, mediaCount: 1 }],
        },
        {
            mbid: "liar-liar-acoustic",
            title: "Liar Liar (acoustic)",
            primaryType: "Single",
            firstReleaseDate: "2023-09-08",
            releases: [{ mbid: "liar-liar-acoustic-release", trackCount: 1, mediaCount: 1 }],
        },
    ]);

    assert.equal(match.releaseGroup?.mbid, "liar-liar-acoustic");
    assert.notEqual(match.status, "ambiguous");
});

test("uses UPC evidence to verify a provider album against a MusicBrainz release", () => {
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "upc-match",
        title: "Give Me the Future (Dolby Atmos)",
        releaseDate: "2022-02-04",
        type: "ALBUM",
        upc: "602445123456",
        trackCount: 13,
        volumeCount: 1,
    }, releaseGroups);

    assert.equal(match.status, "verified");
    assert.equal(match.method, "musicbrainz-release-upc");
    assert.equal(match.releaseGroup?.mbid, "bc411157-431c-4f04-81e1-18e1c21d50ec");
    assert.equal(match.evidence.matchedReleaseMbid, "db967b8b-99c1-4adf-8d12-f0ab285390b3");
});

test("uses MusicBrainz release titles when provider title differs from release group title", () => {
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "57231699",
        title: "Games (feat. Marie Plassard)",
        releaseDate: "2016-02-05",
        type: "SINGLE",
        trackCount: 3,
        volumeCount: 1,
    }, [{
        mbid: "b14c65e0-d21c-4999-aa9e-0c2cb9a23f8d",
        title: "Games Continued",
        primaryType: "Single",
        firstReleaseDate: "2016-02-05",
        releases: [
            { mbid: "16462c36-3748-4edd-9bb8-334628778f14", title: "Games", trackCount: 3, mediaCount: 1 },
            { mbid: "642b667a-b2b1-424d-bfea-b1da1ae17136", title: "Games Continued", trackCount: 2, mediaCount: 1 },
        ],
    }]);

    assert.equal(match.status, "verified");
    assert.equal(match.releaseGroup?.mbid, "b14c65e0-d21c-4999-aa9e-0c2cb9a23f8d");
    assert.equal(match.evidence.candidateTitle, "games");
    assert.deepEqual(match.evidence.availableReleaseMbids, ["16462c36-3748-4edd-9bb8-334628778f14"]);
});

test("matches symbolic MusicBrainz release-group titles before partial provider editions", () => {
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "394021126",
        title: "“&” (Ampersand)",
        releaseDate: "2024-10-25",
        type: "ALBUM",
        trackCount: 14,
        volumeCount: 1,
    }, ampersandReleaseGroups);

    assert.equal(match.releaseGroup?.mbid, "b35978dd-8069-4c75-b9e0-6f6327900823");
    assert.equal(match.evidence.trackCountMatched, true);
    assert.equal(match.evidence.typeMatched, true);
});

test("does not select a one-track provider single as the full release-group slot", () => {
    const releaseGroups = [{
        mbid: "no-bad-days-rg",
        title: "No Bad Days",
        primaryType: "Single",
        secondaryTypes: [],
        firstReleaseDate: "2021-11-19",
        releases: [{ mbid: "no-bad-days-ep", trackCount: 4, mediaCount: 1 }],
    }];
    const oneTrackMatch = matchProviderAlbumToReleaseGroup({
        providerId: "single",
        title: "No Bad Days",
        releaseDate: "2021-11-19",
        type: "SINGLE",
        trackCount: 1,
        volumeCount: 1,
    }, releaseGroups);
    const fourTrackMatch = matchProviderAlbumToReleaseGroup({
        providerId: "ep",
        title: "No Bad Days",
        releaseDate: "2021-11-19",
        type: "SINGLE",
        trackCount: 4,
        volumeCount: 1,
    }, releaseGroups);

    const selections = selectReleaseGroupSlotAlbums([
        { providerId: "single", title: "No Bad Days", quality: "HIRES_LOSSLESS", trackCount: 1, volumeCount: 1 },
        { providerId: "ep", title: "No Bad Days", quality: "LOSSLESS", trackCount: 4, volumeCount: 1 },
    ], new Map([
        ["single", oneTrackMatch],
        ["ep", fourTrackMatch],
    ]), { includeSpatial: false });

    assert.equal(selections.find((selection) => selection.slot === "stereo")?.album.providerId, "ep");
});

test("uses ISRC overlap and track count as fallback evidence", () => {
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "isrc-match",
        title: "Give Me the Future Deluxe",
        releaseDate: "2022-02-04",
        type: "ALBUM",
        isrcs: ["GBUM72108111", "GBUM72108112"],
        trackCount: 13,
        volumeCount: 1,
    }, releaseGroups);

    assert.equal(match.status, "probable");
    assert.equal(match.method, "musicbrainz-recording-isrc");
    assert.equal(match.releaseGroup?.mbid, "bc411157-431c-4f04-81e1-18e1c21d50ec");
    assert.equal(match.evidence.isrcOverlap, 2);
});

test("does not force weak provider rows into an MB release group", () => {
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "1",
        title: "Completely Different",
        releaseDate: "2020-01-01",
        type: "ALBUM",
    }, releaseGroups);

    assert.equal(match.status, "unmatched");
    assert.equal(match.releaseGroup, undefined);
});

test("selects separate stereo and spatial provider offers for the same release group", () => {
    const stereo = matchProviderAlbumToReleaseGroup({
        providerId: "stereo-hires",
        title: "Give Me The Future + Dreams Of The Past",
        releaseDate: "2022-08-26",
        type: "ALBUM",
    }, releaseGroups);
    const spatial = matchProviderAlbumToReleaseGroup({
        providerId: "spatial",
        title: "Give Me The Future + Dreams Of The Past",
        releaseDate: "2022-08-26",
        type: "ALBUM",
    }, releaseGroups);

    const selections = selectReleaseGroupSlotAlbums([
        { providerId: "stereo-lossless", title: "Give Me The Future + Dreams Of The Past", quality: "LOSSLESS", trackCount: 27, volumeCount: 3 },
        { providerId: "stereo-hires", title: "Give Me The Future + Dreams Of The Past", quality: "HIRES_LOSSLESS", trackCount: 27, volumeCount: 3 },
        { providerId: "spatial", title: "Give Me The Future + Dreams Of The Past", quality: "DOLBY_ATMOS", trackCount: 27, volumeCount: 3 },
    ], new Map([
        ["stereo-lossless", stereo],
        ["stereo-hires", stereo],
        ["spatial", spatial],
    ]), { includeSpatial: true });

    assert.equal(selections.find((selection) => selection.slot === "stereo")?.album.providerId, "stereo-hires");
    assert.equal(selections.find((selection) => selection.slot === "spatial")?.album.providerId, "spatial");
});
