import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-provider-release-group-matcher-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();
const configModule = await import("../config/config.js");
const selectionTestConfig = configModule.readConfig();
// These matcher-only fixtures intentionally do not materialize their in-memory
// MusicBrainz releases in SQLite. Keep availability enforcement outside this
// unit boundary; production/fresh-install defaults are covered separately.
selectionTestConfig.filtering.require_provider_availability = false;
configModule.writeConfig(selectionTestConfig);

import { matchProviderAlbumToReleaseGroup } from "./provider-release-group-matcher.js";

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

test("keeps one shared ISRC as a hybrid candidate when track counts differ", () => {
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "short-remix",
        title: "Unrelated Remix Package",
        type: "EP",
        trackCount: 3,
        volumeCount: 1,
        isrcs: ["NLAAA0100001", "NLAAA0100002", "NLAAA0100003"],
    }, [{
        mbid: "full-album-group",
        title: "Original Album",
        primaryType: "Album",
        releases: [{
            mbid: "full-album-release",
            trackCount: 9,
            mediaCount: 1,
            isrcs: ["NLAAA0100001"],
        }],
    }]);

    assert.equal(match.status, "candidate");
    assert.equal(match.releaseGroup?.mbid, "full-album-group");
    assert.equal(match.evidence.isrcCoverageMatched, false);
});

test("keeps one shared ISRC candidate-only for equal-sized multi-track releases", () => {
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "compilation",
        title: "Unrelated Compilation",
        type: "Album",
        trackCount: 9,
        volumeCount: 1,
        isrcs: ["NLAAA0100001", "NLBBB0100002"],
    }, [{
        mbid: "original-group",
        title: "Original Album",
        primaryType: "Album",
        releases: [{
            mbid: "original-release",
            trackCount: 9,
            mediaCount: 1,
            isrcs: ["NLAAA0100001", "NLCCC0100003"],
        }],
    }]);

    assert.equal(match.status, "candidate");
    assert.equal(match.evidence.isrcCoverageMatched, false);
});

test("a fully-track-covered '… EP' expansion is verified, not just probable", () => {
    // Provider titles an EP "Goosebumps EP" while MusicBrainz titles the release
    // group "Goosebumps"; the track count matches the MB edition exactly.
    const goosebumps = [
        {
            mbid: "ggg-mbid",
            title: "Goosebumps",
            primaryType: "EP",
            secondaryTypes: [],
            firstReleaseDate: "2023-01-01",
            releases: [
                { mbid: "ggg-release", trackCount: 4, mediaCount: 1 },
            ],
        },
    ];
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "ggg-provider",
        title: "Goosebumps EP",
        releaseDate: "2023-01-01",
        type: "EP",
        trackCount: 4,
        volumeCount: 1,
    }, goosebumps);

    assert.equal(match.releaseGroup?.mbid, "ggg-mbid");
    assert.equal(match.evidence.titleExpansionMatched, true);
    assert.equal(match.evidence.trackCountMatched, true);
    assert.equal(match.status, "verified");
});

test("matches expanded provider editions even when they contain bonus discs", () => {
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "243863069",
        title: "Give Me The Future + Dreams Of The Past",
        releaseDate: "2022-08-26",
        type: "ALBUM",
        trackCount: 27,
        volumeCount: 3,
    }, releaseGroups);

    assert.equal(match.status, "probable");
    assert.equal(match.releaseGroup?.mbid, "bc411157-431c-4f04-81e1-18e1c21d50ec");
    assert.ok(match.confidence >= 0.78);
    assert.equal(match.evidence.candidateTitle, "give me the future");
    assert.equal(match.releaseMbid, "db967b8b-99c1-4adf-8d12-f0ab285390b3");
    assert.deepEqual(match.evidence.availableReleaseMbids, ["db967b8b-99c1-4adf-8d12-f0ab285390b3"]);
});

test("matches expanded provider editions with compact separators and version suffixes", () => {
    const plusMatch = matchProviderAlbumToReleaseGroup({
        providerId: "compact-plus",
        title: "Give Me The Future+Dreams Of The Past",
        releaseDate: "2022-08-26",
        type: "ALBUM",
        trackCount: 27,
        volumeCount: 3,
    }, releaseGroups);

    assert.equal(plusMatch.status, "probable");
    assert.equal(plusMatch.releaseGroup?.mbid, "bc411157-431c-4f04-81e1-18e1c21d50ec");
    assert.equal(plusMatch.evidence.candidateTitle, "give me the future");

    const suffixMatch = matchProviderAlbumToReleaseGroup({
        providerId: "dash-suffix",
        title: "Give Me the Future - Expanded Edition",
        releaseDate: "2022-08-26",
        type: "ALBUM",
        trackCount: 27,
        volumeCount: 3,
    }, releaseGroups);

    assert.equal(suffixMatch.status, "probable");
    assert.equal(suffixMatch.releaseGroup?.mbid, "bc411157-431c-4f04-81e1-18e1c21d50ec");
    assert.equal(suffixMatch.evidence.candidateTitle, "give me the future");
});

test("marks exact title and type matches as verified", () => {
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "214357460",
        title: "Give Me The Future",
        releaseDate: "2022-02-04",
        type: "ALBUM",
        trackCount: 13,
        volumeCount: 1,
    }, releaseGroups);

    assert.equal(match.status, "verified");
    assert.equal(match.releaseGroup?.mbid, "bc411157-431c-4f04-81e1-18e1c21d50ec");
    assert.equal(match.evidence.trackCountMatched, true);
});

test("exact title without a provider track count stays candidate", () => {
    // SoundCloud album stubs often report title/year with track_count 0.
    // Title-only shells must not become probable/verified availability with no
    // tracklist — that leaves the offer switcher showing a match with no tips.
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "2881942",
        title: "Other People’s Heartache, Pt. 2",
        releaseDate: "2012-12-06",
        type: "ALBUM",
        trackCount: 0,
        volumeCount: 1,
    }, [{
        mbid: "2d1c5d7d-56e3-4f7c-8194-d065595302d8",
        title: "Other People’s Heartache, Pt. 2",
        primaryType: "EP",
        secondaryTypes: ["Mixtape/Street"],
        firstReleaseDate: "2012-12-06",
        releases: [{
            mbid: "6085cdeb-aa4b-4d64-937b-4f22f8520546",
            title: "Other People’s Heartache, Pt. 2",
            trackCount: 11,
            mediaCount: 1,
        }],
    }]);

    assert.equal(match.releaseGroup?.mbid, "2d1c5d7d-56e3-4f7c-8194-d065595302d8");
    assert.equal(match.status, "candidate");
    assert.equal(match.evidence.trackCountMatched, false);
    assert.equal(match.evidence.providerTrackCount, 0);
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

test("a same-titled remix cannot tie the barcode-matched original (identity ceiling)", () => {
    // Regression for Bakermat "One Day (Vandaag)": the "… (Remix)" single
    // (no matching barcode) title-expanded onto the base release and reached
    // confidence 1.0, tying the radio edit that actually shares the barcode and
    // winning downstream confidence-ordered selection.
    const vandaag = [
        {
            mbid: "9aad95d9-0674-433b-ab50-2229c93d32b2",
            title: "Vandaag",
            primaryType: "Single",
            secondaryTypes: [],
            firstReleaseDate: "2012-08-27",
            releases: [
                {
                    mbid: "1bdcf41c-63d1-43be-a69f-2836a9a49213",
                    title: "One Day (Vandaag)",
                    barcode: "886444522359",
                    trackCount: 1,
                    mediaCount: 1,
                },
            ],
        },
    ];

    const radioEdit = matchProviderAlbumToReleaseGroup({
        providerId: "26891889",
        title: "One Day (Vandaag)",
        version: "Radio Edit",
        upc: "886444522359",
        type: "SINGLE",
        trackCount: 1,
        volumeCount: 1,
        releaseDate: "2014-03-14",
    }, vandaag);

    const remix = matchProviderAlbumToReleaseGroup({
        providerId: "33923839",
        title: "One Day (Vandaag) (Oliver $ & Matthew K Remix)",
        upc: "886444809603", // matches no MusicBrainz barcode in the group
        type: "SINGLE",
        trackCount: 1,
        volumeCount: 1,
        releaseDate: "2014-09-01",
    }, vandaag);

    assert.equal(radioEdit.evidence.upcMatched, true);
    assert.equal(remix.evidence.upcMatched, false);
    assert.ok(
        remix.confidence < radioEdit.confidence,
        `remix ${remix.confidence} must stay below the barcode match ${radioEdit.confidence}`,
    );
    assert.ok(remix.confidence <= 0.99, `remix confidence ${remix.confidence} must be below the UPC tier`);
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

// TIDAL (and others) zero-pad UPCs to 12–14 digits; MusicBrainz often stores the
// same code without the pad. Leading zeros must not make identity miss.
test("UPC identity ignores leading-zero padding", () => {
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "243864035",
        title: "Give Me The Future + Dreams Of The Past",
        releaseDate: "2022-08-26",
        type: "ALBUM",
        upc: "00602445123456",
        trackCount: 13,
        volumeCount: 1,
    }, releaseGroups);

    assert.equal(match.status, "verified");
    assert.equal(match.method, "musicbrainz-release-upc");
    assert.equal(match.evidence.upcMatched, true);
    assert.equal(match.evidence.matchedReleaseMbid, "db967b8b-99c1-4adf-8d12-f0ab285390b3");
});

test("uses MusicBrainz external links before UPC and title fallback", () => {
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "287367980",
        title: "Pompeii",
        releaseDate: "2013-01-01",
        type: "SINGLE",
        upc: "000000000000",
        trackCount: 2,
        volumeCount: 1,
    }, [
        {
            mbid: "wrong-title-rg",
            title: "Pompeii",
            primaryType: "Single",
            firstReleaseDate: "2013-01-01",
            releases: [{ mbid: "wrong-title-release", title: "Pompeii", trackCount: 2, mediaCount: 1 }],
        },
        {
            mbid: "linked-rg",
            title: "Pompeii / Come as You Are (MTV Unplugged)",
            primaryType: "Single",
            firstReleaseDate: "2023-04-12",
            releases: [{
                mbid: "linked-release",
                title: "Pompeii / Come as You Are (MTV Unplugged)",
                externalUrls: ["https://tidal.com/album/287367980"],
                trackCount: 2,
                mediaCount: 1,
            }],
        },
    ]);

    assert.equal(match.status, "verified");
    assert.equal(match.method, "musicbrainz-release-url");
    assert.equal(match.releaseGroup?.mbid, "linked-rg");
    assert.equal(match.releaseMbid, "linked-release");
    assert.equal(match.evidence.providerUrlMatched, true);
});

test("does not treat unrelated numeric external URLs as provider release links", () => {
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "287367980",
        title: "Different Provider Title",
        releaseDate: "2023-04-12",
        type: "SINGLE",
        trackCount: 2,
        volumeCount: 1,
    }, [
        {
            mbid: "apple-linked-rg",
            title: "Different Provider Title",
            primaryType: "Single",
            firstReleaseDate: "2023-04-12",
            releases: [{
                mbid: "apple-linked-release",
                title: "Different Provider Title",
                externalUrls: ["https://music.apple.com/us/album/287367980"],
                trackCount: 2,
                mediaCount: 1,
            }],
        },
    ]);

    assert.equal(match.method, "musicbrainz-release-title-year-type-track-count");
    assert.equal(match.evidence.providerUrlMatched, false);
    assert.equal(match.releaseMbid, "apple-linked-release");
});

test("uses Apple Music release URL relationships as provider identity evidence", () => {
    const match = matchProviderAlbumToReleaseGroup({
        provider: "apple-music",
        providerId: "287367980",
        providerUrl: "https://music.apple.com/us/album/example/287367980",
        title: "Provider Title",
        releaseDate: "2023-04-12",
        type: "ALBUM",
        trackCount: 10,
        volumeCount: 1,
    }, [
        {
            mbid: "apple-linked-rg",
            title: "Different Canonical Title",
            primaryType: "Album",
            firstReleaseDate: "2023-04-12",
            releases: [{
                mbid: "apple-linked-release",
                title: "Different Canonical Title",
                externalUrls: ["https://music.apple.com/us/album/different-canonical-title/287367980"],
                trackCount: 10,
                mediaCount: 1,
            }],
        },
    ]);

    assert.equal(match.status, "verified");
    assert.equal(match.method, "musicbrainz-release-url");
    assert.equal(match.releaseMbid, "apple-linked-release");
    assert.equal(match.evidence.providerUrlMatched, true);
});

test("uses Spotify release URL relationships as provider identity evidence", () => {
    const match = matchProviderAlbumToReleaseGroup({
        provider: "spotify",
        providerId: "4aawyAB9vmqN3uQ7FjRGTy",
        providerUrl: "https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy",
        title: "Provider Title",
        releaseDate: "2012-01-01",
        type: "ALBUM",
        trackCount: 12,
        volumeCount: 1,
    }, [
        {
            mbid: "spotify-linked-rg",
            title: "Different Canonical Title",
            primaryType: "Album",
            firstReleaseDate: "2012-01-01",
            releases: [{
                mbid: "spotify-linked-release",
                title: "Different Canonical Title",
                externalUrls: ["https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy?si=ignored"],
                trackCount: 12,
                mediaCount: 1,
            }],
        },
    ]);

    assert.equal(match.status, "verified");
    assert.equal(match.method, "musicbrainz-release-url");
    assert.equal(match.releaseMbid, "spotify-linked-release");
    assert.equal(match.evidence.providerUrlMatched, true);
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

test("prefers a full release-title match over a shorter expanded-title prefix", () => {
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "287367980",
        title: "Pompeii / Come As You Are (MTV Unplugged)",
        version: "MTV Unplugged",
        releaseDate: "2023-04-12",
        type: "SINGLE",
        trackCount: 2,
        volumeCount: 1,
    }, [
        {
            mbid: "pompeii-single-rg",
            title: "Pompeii",
            primaryType: "Single",
            firstReleaseDate: "2013-01-01",
            releases: [
                { mbid: "pompeii-single-release", title: "Pompeii", trackCount: 2, mediaCount: 1 },
            ],
        },
        {
            mbid: "mtv-unplugged-rg",
            title: "Pompeii / Come as You Are (MTV Unplugged)",
            primaryType: "Single",
            firstReleaseDate: "2023-04-12",
            releases: [
                {
                    mbid: "mtv-unplugged-release",
                    title: "Pompeii / Come as You Are (MTV Unplugged)",
                    trackCount: 2,
                    mediaCount: 1,
                },
            ],
        },
    ]);

    assert.equal(match.status, "verified");
    assert.equal(match.releaseGroup?.mbid, "mtv-unplugged-rg");
    assert.equal(match.releaseMbid, "mtv-unplugged-release");
    assert.equal(match.evidence.candidateTitle, "pompeii come as you are mtv unplugged");
    assert.notDeepEqual(match.evidence.ambiguousWith, ["mtv-unplugged-rg"]);
});

test("prefers spatial MusicBrainz release disambiguation for Dolby Atmos provider albums", () => {
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "291445075",
        title: "MTV Unplugged",
        releaseDate: "2023-04-22",
        type: "ALBUM",
        quality: "DOLBY_ATMOS",
        qualityTags: ["DOLBY_ATMOS"],
        trackCount: 15,
        volumeCount: 1,
    }, [{
        mbid: "mtv-unplugged-rg",
        title: "MTV Unplugged – Live in London",
        primaryType: "Album",
        firstReleaseDate: "2023-04-22",
        releases: [
            {
                mbid: "normal-digital-release",
                title: "MTV Unplugged – Live in London",
                trackCount: 15,
                mediaCount: 1,
            },
            {
                mbid: "dolby-atmos-release",
                title: "MTV Unplugged – Live in London",
                disambiguation: "Dolby Atmos mix",
                trackCount: 15,
                mediaCount: 1,
            },
        ],
    }]);

    assert.equal(match.status, "verified");
    assert.equal(match.releaseMbid, "dolby-atmos-release");
    assert.deepEqual(match.evidence.availableReleaseMbids, ["dolby-atmos-release"]);
});

test("prefers matching explicit MusicBrainz release disambiguation for explicit provider albums", () => {
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "123964309",
        title: "Doom Days (This Got Out Of Hand Edition)",
        version: "This Got Out Of Hand Edition",
        releaseDate: "2019-12-06",
        type: "ALBUM",
        quality: "HIRES_LOSSLESS",
        explicit: true,
        trackCount: 22,
        volumeCount: 1,
    }, [{
        mbid: "doom-days-rg",
        title: "Doom Days",
        primaryType: "Album",
        firstReleaseDate: "2019-06-14",
        releases: [
            {
                mbid: "clean-release",
                title: "Doom Days (This Got Out of Hand edition)",
                disambiguation: "clean",
                trackCount: 22,
                mediaCount: 1,
            },
            {
                mbid: "explicit-release",
                title: "Doom Days (This Got Out of Hand edition)",
                disambiguation: "explicit",
                trackCount: 22,
                mediaCount: 1,
            },
            {
                mbid: "hires-explicit-release",
                title: "Doom Days (This Got Out of Hand edition)",
                disambiguation: "24bit/44.1kHz; explicit",
                trackCount: 22,
                mediaCount: 1,
            },
        ],
    }]);

    assert.equal(match.status, "verified");
    assert.equal(match.releaseMbid, "explicit-release");
    assert.deepEqual(match.evidence.availableReleaseMbids, ["explicit-release"]);
});

test("prefers matching clean MusicBrainz release disambiguation for clean provider albums", () => {
    const match = matchProviderAlbumToReleaseGroup({
        providerId: "123964389",
        title: "Doom Days (This Got Out Of Hand Edition)",
        version: "This Got Out Of Hand Edition",
        releaseDate: "2019-12-06",
        type: "ALBUM",
        quality: "HIRES_LOSSLESS",
        explicit: false,
        trackCount: 22,
        volumeCount: 1,
    }, [{
        mbid: "doom-days-rg",
        title: "Doom Days",
        primaryType: "Album",
        firstReleaseDate: "2019-06-14",
        releases: [
            {
                mbid: "explicit-release",
                title: "Doom Days (This Got Out of Hand edition)",
                disambiguation: "explicit",
                trackCount: 22,
                mediaCount: 1,
            },
            {
                mbid: "clean-release",
                title: "Doom Days (This Got Out of Hand edition)",
                disambiguation: "clean",
                trackCount: 22,
                mediaCount: 1,
            },
        ],
    }]);

    assert.equal(match.status, "verified");
    assert.equal(match.releaseMbid, "clean-release");
    assert.deepEqual(match.evidence.availableReleaseMbids, ["clean-release"]);
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

    assert.equal(match.status, "verified");
    assert.equal(match.method, "musicbrainz-recording-isrc");
    assert.equal(match.releaseGroup?.mbid, "bc411157-431c-4f04-81e1-18e1c21d50ec");
    assert.equal(match.evidence.isrcOverlap, 2);
});

test("prefers matching media count when ISRC overlap and track count tie", () => {
    const sharedIsrcs = Array.from({ length: 27 }, (_, index) =>
        `GBUM7220${String(index + 1).padStart(4, "0")}`);
    const volumeTieReleaseGroups = [{
        mbid: "bc411157-431c-4f04-81e1-18e1c21d50ec",
        title: "Give Me the Future",
        primaryType: "Album",
        secondaryTypes: [],
        firstReleaseDate: "2022-02-04",
        releases: [
            {
                mbid: "0a0bd5a8-two-disc-release",
                trackCount: 27,
                mediaCount: 2,
                isrcs: sharedIsrcs,
            },
            {
                mbid: "063b19f1-three-disc-release",
                trackCount: 27,
                mediaCount: 3,
                isrcs: sharedIsrcs,
            },
        ],
    }];

    const match = matchProviderAlbumToReleaseGroup({
        providerId: "expanded-hires",
        title: "Give Me The Future + Dreams Of The Past",
        releaseDate: "2022-08-26",
        type: "ALBUM",
        isrcs: sharedIsrcs,
        trackCount: 27,
        volumeCount: 3,
    }, volumeTieReleaseGroups);

    assert.equal(match.method, "musicbrainz-recording-isrc");
    assert.equal(match.releaseMbid, "063b19f1-three-disc-release");
    assert.deepEqual(match.evidence.availableReleaseMbids, [
        "0a0bd5a8-two-disc-release",
        "063b19f1-three-disc-release",
    ]);
    assert.equal(match.evidence.volumeCountMatched, true);
    assert.equal(match.evidence.targetVolumeCount, 3);
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

