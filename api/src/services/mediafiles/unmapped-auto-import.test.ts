import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

import {
    closeActiveSchemaDb,
    openActiveSchemaDb,
    prepareActiveSchemaEnv,
    resetActiveSchemaRows,
} from "../../test-support/active-schema-fixture.js";
import type { AcoustIdIdentificationResult } from "./acoustid-identification-service.js";

const { tempDir } = prepareActiveSchemaEnv("unmapped-auto-import");
const { db, dbModule } = await openActiveSchemaDb();
const { UnmappedFileRepository } = await import("../../repositories/mediafiles/UnmappedFileRepository.js");
const { ImportService } = await import("./import-service.js");
const { UnmappedFilesService } = await import("./unmapped-files.js");

after(() => closeActiveSchemaDb(dbModule, tempDir));

const DELUXE = "eb1acde0-35b3-4acc-bd36-b5a7037b7f38";
const BOOTLEG = "5e045192-76e0-4234-8de5-31b7a38c601f";
const ROOT = tempDir;
const incoming = path.join(tempDir, "Taylor Swift", "1989", "01 Blank Space.flac");

function seed(): void {
    resetActiveSchemaRows(db, ["commands", "UnmappedFiles", "Libraries", "MetadataProfiles", "quality_profiles"]);
    db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'taylor', 'Taylor Swift')").run();
    db.prepare(`
        INSERT INTO Albums (id, mbid, artist_mbid, title, first_release_date)
        VALUES (1, 'rg-1989', 'taylor', '1989', '2014-10-27')
    `).run();
    db.prepare(`
        INSERT INTO AlbumEditions (
            id, mbid, release_group_id, release_group_mbid, artist_mbid, title, status, date, country, media_count, media
        ) VALUES (
            10, ?, 1, 'rg-1989', 'taylor', '1989 D.L.X.', 'Official', '2014-10-27', '["XE"]', 1, '[{"format":"CD"}]'
        )
    `).run(DELUXE);
    db.prepare(`
        INSERT INTO AlbumEditions (
            id, mbid, release_group_id, release_group_mbid, artist_mbid, title, status, date, country, media_count, media
        ) VALUES (
            11, ?, 1, 'rg-1989', 'taylor', '1989', 'Bootleg', '2014-10-24', '["XW"]', 1, '[{"format":"Cassette"}]'
        )
    `).run(BOOTLEG);
    db.prepare(`
        INSERT INTO Recordings (id, mbid, title, length_ms) VALUES (100, 'rec-blank', 'Blank Space', 231826)
    `).run();
    db.prepare(`
        INSERT INTO Tracks (
            id, mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
            medium_position, position, title, length_ms
        ) VALUES (1000, 'track-deluxe', 10, ?, 100, 'rec-blank', 1, 1, 'Blank Space', 231826)
    `).run(DELUXE);
    db.prepare(`
        INSERT INTO Tracks (
            id, mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
            medium_position, position, title, length_ms
        ) VALUES (1001, 'track-bootleg', 11, ?, 100, 'rec-blank', 1, 1, 'Blank Space', 231826)
    `).run(BOOTLEG);
    db.prepare(`
        INSERT INTO MetadataProfiles (
            id, name, release_type_policy, explicit_policy, require_provider_availability, redundancy_enabled
        ) VALUES (1, 'Default', '{}', 'allow', 1, 0)
    `).run();
    db.prepare(`
        INSERT INTO quality_profiles (
            id, name, allowed_source_formats, preference_order, cutoff,
            continue_upgrades, fallback_policy, output_format, transcode_policy
        ) VALUES (1, 'High', '["lossless"]', '["lossless"]', 'lossless', 0, 'none', '{}', 'preserve')
    `).run();
    db.prepare(`
        INSERT INTO Libraries (id, name, root_path, metadata_profile_id, quality_profile_id)
        VALUES (1, 'Stereo', ?, 1, 1)
    `).run(ROOT);
    fs.mkdirSync(path.dirname(incoming), { recursive: true });
    fs.writeFileSync(incoming, "untouched-foreign-file");
    db.prepare(`
        INSERT INTO UnmappedFiles (id, file_path, relative_path, library_root, filename, extension, duration, reason)
        VALUES (1, ?, '01 Blank Space.flac', 'music', '01 Blank Space.flac', 'flac', 232, NULL)
    `).run(incoming);
}

function service(): InstanceType<typeof UnmappedFilesService> {
    const tags = new Map<string, Record<string, string>>([
        [incoming, {
            ALBUM: "1989",
            ALBUMARTIST: "Taylor Swift",
            TITLE: "Blank Space",
            TRACK: "1",
            DISC: "1",
            DATE: "2014",
        }],
    ]);
    return new UnmappedFilesService(
        new UnmappedFileRepository(db),
        new ImportService(),
        async () => ({ recordingIds: [] }) as unknown as AcoustIdIdentificationResult,
        async () => null,
        async (filePath) => ({ tags: tags.get(filePath) ?? {}, durationSeconds: null }),
    );
}

test("catalog candidates drop the 1989 bootleg and keep the official deluxe", () => {
    seed();
    const candidates = service().findCatalogCandidates({
        libraryId: 1,
        artistMbid: "taylor",
        artistName: "Taylor Swift",
        album: "1989",
    });
    assert.deepEqual(candidates.map((candidate) => candidate.mbid), [DELUXE]);
});

test("dry-run reports the import and does not touch the file or queue it", async () => {
    seed();
    const before = fs.readFileSync(incoming);
    const preview = await service().autoImportByIds([1], { dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.folders.length, 1);
    const folder = preview.folders[0];
    assert.equal(folder.decision, "import", folder.reason);
    assert.equal(folder.editionId, 10);
    assert.equal(folder.filesUntouched, true);
    assert.equal(folder.queued, undefined);
    assert.equal(folder.actions.some((action) => action.type === "monitor" && action.selectionMode === "auto" && action.locked === false), true);
    assert.equal(folder.actions.some((action) => action.type === "import" && action.trackId === 1000), true);
    assert.deepEqual(fs.readFileSync(incoming), before);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM commands").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT reason FROM UnmappedFiles WHERE id = 1").get() as { reason: string | null }).reason, null);
});

test("queuing an auto-import does not delete an existing copy of the recording", async () => {
    seed();
    const existingPath = path.join(tempDir, "already-in-library.flac");
    fs.writeFileSync(existingPath, "better-or-not");
    db.prepare(`
        INSERT INTO TrackFiles (
            id, artist_metadata_id, library_root, file_type, library_id, release_group_id,
            album_edition_id, track_id, recording_id, file_path, relative_path, filename, extension
        ) VALUES (
            5, 1, ?, 'track', 1, 1, 10, 1000, 100, ?, 'already-in-library.flac', 'already-in-library.flac', 'flac'
        )
    `).run(ROOT, existingPath);

    const result = await service().autoImportByIds([1], { dryRun: false });
    assert.equal(result.folders[0]?.decision, "import");
    assert.equal(result.folders[0]?.queued, 1);
    const payload = JSON.parse((db.prepare(`
        SELECT payload FROM commands WHERE name = 'ImportUnmappedFiles'
    `).get() as { payload: string }).payload) as {
        applyStandardTags?: boolean;
        canonical?: { editionId: number };
    };
    assert.equal(payload.applyStandardTags, true);
    assert.equal(payload.canonical?.editionId, 10);
    assert.equal(fs.readFileSync(incoming, "utf8"), "untouched-foreign-file");
    assert.equal(fs.readFileSync(existingPath, "utf8"), "better-or-not");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM TrackFiles WHERE id = 5").get() as { n: number }).n, 1);
    const monitored = db.prepare(`
        SELECT selection_mode, locked FROM LibraryAlbums WHERE library_id = 1
    `).get() as { selection_mode: string; locked: number } | undefined;
    assert.equal(monitored, undefined, "monitoring happens when the import command runs, not when it is queued");
});

test("a folder with no album tag stays in review and a dry-run does not record that", async () => {
    seed();
    db.prepare(`
        INSERT INTO UnmappedFiles (id, file_path, relative_path, library_root, filename, extension)
        VALUES (2, ?, 'loose.flac', 'music', 'loose.flac', 'flac')
    `).run(path.join(tempDir, "loose", "loose.flac"));
    const preview = await service().autoImportByIds([2], { dryRun: true });
    assert.equal(preview.folders[0]?.decision, "review");
    assert.match(preview.folders[0]?.reason ?? "", /no album tag/);
    assert.equal((db.prepare("SELECT reason FROM UnmappedFiles WHERE id = 2").get() as { reason: string | null }).reason, null);

    const live = await service().autoImportByIds([2], { dryRun: false });
    assert.equal(live.folders[0]?.queued, 0);
    assert.match(
        (db.prepare("SELECT reason FROM UnmappedFiles WHERE id = 2").get() as { reason: string }).reason,
        /no album tag/,
    );
});

test("folder auto-import verifies AcoustID recording even when tags match, holding mismatches in review", async () => {
    seed();
    const folder = path.join(tempDir, "acoustid-check");
    fs.mkdirSync(folder, { recursive: true });
    const filePath = path.join(folder, "01 Blank Space.flac");
    fs.writeFileSync(filePath, "audio-bytes");
    db.prepare(`
        INSERT INTO UnmappedFiles (id, file_path, relative_path, library_root, filename, extension, duration)
        VALUES (3, ?, 'acoustid-check/01 Blank Space.flac', 'music', '01 Blank Space.flac', 'flac', 232)
    `).run(filePath);

    const makeService = (identify: (p: string, o?: any) => Promise<AcoustIdIdentificationResult>) =>
        new UnmappedFilesService(
            new UnmappedFileRepository(db),
            new ImportService(),
            identify,
            async () => null,
            async () => ({
                durationSeconds: 232,
                tags: {
                    MUSICBRAINZ_ALBUMID: DELUXE,
                    TRACK: "1",
                    DISC: "1",
                    TITLE: "Blank Space",
                },
            }),
        );

    // 1. Confident mismatch -> review, nothing queued
    const mismatchService = makeService(async () => ({
        status: "matched",
        fingerprint: "fp",
        duration: 232,
        cached: false,
        recordingIds: ["rec-other"],
        candidates: [{
            acoustId: "aid-other",
            score: 0.99,
            recording: {
                id: "rec-other",
                title: "Different Song",
                artists: ["Taylor Swift"],
                isrcs: [],
                releaseTitles: [],
                firstReleaseDate: null,
                durationSeconds: 232,
            },
            durationDeltaSeconds: 0,
        }],
        rejected: [],
    }));
    const mismatchReport = await mismatchService.autoImportByIds([3], { dryRun: false });
    assert.equal(mismatchReport.folders[0]?.decision, "review");
    assert.match(mismatchReport.folders[0]?.reason ?? "", /Fingerprint matches rec-other \("Different Song"\) not rec-blank \("Blank Space"\)/);
    assert.equal(mismatchReport.folders[0]?.queued, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM commands WHERE name = 'ImportUnmappedFiles'").get() as { n: number }).n, 0);

    // 2. AcoustID match -> import allowed
    const matchService = makeService(async () => ({
        status: "matched",
        fingerprint: "fp",
        duration: 232,
        cached: false,
        recordingIds: ["rec-blank"],
        candidates: [{
            acoustId: "aid-1",
            score: 0.99,
            recording: {
                id: "rec-blank",
                title: "Blank Space",
                artists: ["Taylor Swift"],
                isrcs: [],
                releaseTitles: [],
                firstReleaseDate: null,
                durationSeconds: 232,
            },
            durationDeltaSeconds: 0,
        }],
        rejected: [],
    }));
    const matchReport = await matchService.autoImportByIds([3], { dryRun: true });
    assert.equal(matchReport.folders[0]?.decision, "import");

    // 3. AcoustID no_match -> falls back to tag/length import without failing
    const noMatchService = makeService(async () => ({
        status: "no_match",
        fingerprint: "fp",
        duration: 232,
        cached: false,
        recordingIds: [],
        candidates: [],
        rejected: [],
    }));
    const fallbackReport = await noMatchService.autoImportByIds([3], { dryRun: true });
    assert.equal(fallbackReport.folders[0]?.decision, "import");

    // 4. Streaming download import path never calls the fingerprint/AcoustID path
    const candidateFromRoot = path.resolve("api/src/services/mediafiles/import-service.ts");
    const candidateFromApi = path.resolve("src/services/mediafiles/import-service.ts");
    const importServiceSource = fs.readFileSync(
        fs.existsSync(candidateFromRoot) ? candidateFromRoot : candidateFromApi,
        "utf8",
    );
    assert.equal(/verifyAudioFileRecording|identifyAudioFileByAcoustId|lookupAcoustId/.test(importServiceSource), false);
});
