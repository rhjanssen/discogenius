import assert from "node:assert/strict";
import test from "node:test";

import { matchProviderAlbumToReleaseGroup } from "./metadata/provider-release-group-matcher.js";
import { selectReleaseGroupSlotAlbums } from "./release-group-slot-service.js";

const releaseGroups = [
    {
        mbid: "bc411157-431c-4f04-81e1-18e1c21d50ec",
        title: "Give Me the Future",
        primaryType: "Album",
        secondaryTypes: [],
        firstReleaseDate: "2022-02-04",
    },
    {
        mbid: "9a2e82b9-aaaa-4a1d-98ef-19f0641ce38a",
        title: "Doom Days",
        primaryType: "Album",
        secondaryTypes: [],
        firstReleaseDate: "2019-06-14",
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
        providerId: "atmos",
        title: "Give Me The Future + Dreams Of The Past",
        releaseDate: "2022-08-26",
        type: "ALBUM",
    }, releaseGroups);

    const selections = selectReleaseGroupSlotAlbums([
        { providerId: "stereo-lossless", title: "Give Me The Future + Dreams Of The Past", quality: "LOSSLESS", trackCount: 27, volumeCount: 3 },
        { providerId: "stereo-hires", title: "Give Me The Future + Dreams Of The Past", quality: "HIRES_LOSSLESS", trackCount: 27, volumeCount: 3 },
        { providerId: "atmos", title: "Give Me The Future + Dreams Of The Past", quality: "DOLBY_ATMOS", trackCount: 27, volumeCount: 3 },
    ], new Map([
        ["stereo-lossless", stereo],
        ["stereo-hires", stereo],
        ["atmos", spatial],
    ]), { includeSpatial: true });

    assert.equal(selections.find((selection) => selection.slot === "stereo")?.album.providerId, "stereo-hires");
    assert.equal(selections.find((selection) => selection.slot === "spatial")?.album.providerId, "atmos");
});
