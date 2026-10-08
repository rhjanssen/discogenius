import type Database from "better-sqlite3";
import fs from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { parseAudioFile, deriveQuality } from "../mediafiles/audioUtils.js";
import { acquireMediaFileLocks } from "../mediafiles/media-file-lock.js";
import { resolvedPathIsInsideRoot } from "../mediafiles/path-utils.js";
import { QualityProfileRepository, decideImportedQuality, type QualityProfilePolicy, type SourceAudioFacts } from "./quality-profile-policy.js";
import type { NormalizedAudioQuality } from "./acquisition-plan-optimizer.js";
type FileCandidate = {
    id: number;
    track_id: number;
    file_path: string;
    recording_id: number;
    file_size: number | null;
    modified_at: string | null;
    length_ms: number | null;
    source_quality_snapshot: string | null;
    source_bit_depth: number | null;
    source_sample_rate: number | null;
    source_codec: string | null;
};
function normalizedQuality(tag: string): NormalizedAudioQuality | null {
    if (tag === 'HIRES_LOSSLESS')
        return 'hires-lossless';
    if (tag === 'LOSSLESS')
        return 'lossless';
    if (tag === 'DOLBY_ATMOS')
        return 'spatial';
    if (tag === 'HIGH' || tag === 'LOW')
        return 'lossy';
    return null;
}
function sameFile(before: BigIntStats, after: BigIntStats): boolean {
    return after.isFile() && after.dev === before.dev && after.ino === before.ino
        && after.size === before.size && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs;
}
export function importedQualitySatisfies(profile: QualityProfilePolicy, actual: NormalizedAudioQuality, desired: SourceAudioFacts): boolean {
    if (!profile.allowedQualities.has(desired.quality))
        return false;
    if (actual === 'spatial' || desired.quality === 'spatial')
        return actual === desired.quality;
    const expected = decideImportedQuality(profile, desired).importedQuality;
    const cutoff = decideImportedQuality(profile, { quality: profile.cutoff }).importedQuality;
    if (!expected || !cutoff || expected === 'spatial' || cutoff === 'spatial')
        return false;
    const rank = (quality: NormalizedAudioQuality) => {
        const index = profile.preferenceOrder.indexOf(quality);
        return index >= 0 ? index : ['hires-lossless', 'lossless', 'lossy'].indexOf(quality);
    };
    return rank(actual) <= rank(expected)
        || (!profile.continueUpgradesAfterCutoff && rank(actual) <= rank(cutoff));
}
function snapshot(db: Database.Database, planId: number, trackIds: readonly number[]) {
    const header = db.prepare(`SELECT plan.id,plan.plan_key,plan.policy_hash,plan.state,plan.library_id,plan.edition_id,
    library.root_path,library.enabled,library.quality_profile_id
    FROM AcquisitionPlans plan JOIN Libraries library ON library.id=plan.library_id WHERE plan.id=?`).get(planId) as {
        id: number;
        plan_key: string;
        policy_hash: string;
        state: string;
        library_id: number;
        edition_id: number;
        root_path: string;
        enabled: number;
        quality_profile_id: number;
    } | undefined;
    if (!header || header.state !== 'current' || !header.enabled)
        throw new Error('Acquisition plan is no longer executable');
    const profileRow = db.prepare('SELECT * FROM quality_profiles WHERE id=?').get(header.quality_profile_id);
    const profile = new QualityProfileRepository(db).get(header.quality_profile_id);
    const rows = db.prepare(`SELECT file.id,file.track_id,file.file_path,file.recording_id,file.file_size,file.modified_at,
    COALESCE(track.length_ms,recording.length_ms) AS length_ms,assignment.source_quality_snapshot,
    variant.bit_depth AS source_bit_depth,variant.sample_rate AS source_sample_rate,variant.codec AS source_codec
    FROM AcquisitionPlanTracks assignment JOIN Tracks track ON track.id=assignment.track_id
    JOIN Recordings recording ON recording.id=track.recording_id
    JOIN ProviderItemAudioVariants variant ON variant.id=assignment.provider_audio_variant_id
    JOIN TrackFiles file ON file.library_id=? AND file.album_edition_id=?
      AND file.track_id=track.id AND file.recording_id=recording.id AND file.file_class='audio'
    WHERE assignment.plan_id=? ORDER BY file.id`).all(header.library_id, header.edition_id, planId) as FileCandidate[];
    const requested = new Set(trackIds);
    const files = requested.size ? rows.filter(row => requested.has(row.track_id)) : rows;
    return { header, profile, files, identity: JSON.stringify({ header, profileRow, files }) };
}
/** Filesystem work happens with file admission held, never the SQLite write gate.
 * The caller rechecks snapshotCurrent inside its brief commit transaction. */
export async function withVerifiedAcquisitionFiles<T>(db: Database.Database, planId: number, trackIds: readonly number[], finish: (verified: ReadonlySet<number>, snapshotCurrent: () => boolean) => Promise<T>): Promise<T> {
    const before = snapshot(db, planId, trackIds);
    const release = await acquireMediaFileLocks(before.files.map(file => file.file_path));
    try {
        const verified = new Set<number>();
        const witnesses = new Map<number, {
            path: string;
            stat: BigIntStats;
        }>();
        let root: string | null = null;
        try {
            root = await fs.realpath(before.header.root_path);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
        }
        for (const file of before.files) {
            if (!root || verified.has(file.track_id) || !resolvedPathIsInsideRoot(file.file_path, before.header.root_path))
                continue;
            try {
                const stat = await fs.lstat(file.file_path, { bigint: true });
                if (!stat.isFile() || stat.size <= 0n || !resolvedPathIsInsideRoot(await fs.realpath(file.file_path), root))
                    continue;
                const metrics = await parseAudioFile(file.file_path);
                if (!metrics.codec || !metrics.sampleRate || !metrics.channels || !metrics.duration || metrics.duration <= 0)
                    continue;
                // Classify the probed codec, not a filename that may have the wrong suffix.
                const codec = metrics.codec.toLowerCase();
                const extension = codec.includes('flac') ? '.flac'
                    : codec.includes('alac') || codec.includes('apple lossless') ? '.alac'
                        : codec.includes('pcm') ? '.wav'
                            : /aac|mp3|mpeg|opus|vorbis|wma/.test(codec) ? '.aac' : '';
                const quality = normalizedQuality(deriveQuality(extension, metrics));
                if (!quality || (quality !== 'spatial' && metrics.channels > 2))
                    continue;
                if (file.length_ms && Math.abs(metrics.duration * 1000 - file.length_ms) > Math.max(5000, file.length_ms * 0.02))
                    continue;
                const facts = JSON.parse(file.source_quality_snapshot || '{}') as {
                    quality: NormalizedAudioQuality;
                };
                if (!importedQualitySatisfies(before.profile, quality, { quality: facts.quality,
                    bitDepth: file.source_bit_depth, sampleRate: file.source_sample_rate, codec: file.source_codec }))
                    continue;
                const after = await fs.lstat(file.file_path, { bigint: true });
                if (!sameFile(stat, after))
                    continue;
                verified.add(file.track_id);
                witnesses.set(file.track_id, { path: file.file_path, stat: after });
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw error;
            }
        }
        // Earlier tracks can change while later tracks are probed by an external
        // library manager. Our own file writers are excluded by the admission locks.
        for (const [trackId, witness] of witnesses) {
            try {
                if (!sameFile(witness.stat, await fs.lstat(witness.path, { bigint: true })))
                    verified.delete(trackId);
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw error;
                verified.delete(trackId);
            }
        }
        return await finish(verified, () => {
            try {
                return snapshot(db, planId, trackIds).identity === before.identity;
            }
            catch {
                return false;
            }
        });
    }
    finally {
        release();
    }
}
