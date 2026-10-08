import type Database from "better-sqlite3";
import fs from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { parseAudioFile, deriveQuality } from "../mediafiles/audioUtils.js";
import { acquireMediaFileLocks } from "../mediafiles/media-file-lock.js";
import { resolvedPathIsInsideRoot } from "../mediafiles/path-utils.js";
import { QualityProfileRepository, decideImportedQuality, type QualityProfilePolicy, type SourceAudioFacts, type ImportQualityOptions } from "./quality-profile-policy.js";
import { Config } from "../config/config.js";
import type { NormalizedAudioQuality } from "./acquisition-plan-optimizer.js";
import { observedFactsFromFile, fileSatisfiesOffer, type AudioFacts } from "../providers/audio-facts.js";
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
    source_bitrate: number | null;
    desired_variant_id: number;
    desired_item_id: number;
    desired_provider: string;
    desired_provider_id: string;
    provider_item_id: number | null;
    source_audio_variant_id: number | null;
    provider: string | null;
    provider_entity_type: string | null;
    provider_id: string | null;
    codec: string | null;
    bit_depth: number | null;
    sample_rate: number | null;
    bitrate: number | null;
    channels: number | null;
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
export function importedQualitySatisfies(profile: QualityProfilePolicy, actual: NormalizedAudioQuality, desired: SourceAudioFacts, options: ImportQualityOptions = {}): boolean {
    if (!profile.allowedQualities.has(desired.quality))
        return false;
    if (actual === 'spatial' || desired.quality === 'spatial')
        return actual === desired.quality;
    const expected = decideImportedQuality(profile, desired, options).importedQuality;
    const cutoff = decideImportedQuality(profile, { quality: profile.cutoff }, options).importedQuality;
    if (!expected || !cutoff || expected === 'spatial' || cutoff === 'spatial')
        return false;
    const rank = (quality: NormalizedAudioQuality) => {
        const index = profile.preferenceOrder.indexOf(quality);
        return index >= 0 ? index : ['hires-lossless', 'lossless', 'lossy'].indexOf(quality);
    };
    return rank(actual) <= rank(expected)
        || (!profile.continueUpgradesAfterCutoff && rank(actual) <= rank(cutoff));
}

/** Use the same delivered-fidelity comparison as planning. Estimates cannot
 * disqualify an unchanged, measured delivery of this exact native variant. */
export function importedFidelitySatisfies(profile: QualityProfilePolicy, actualTier: NormalizedAudioQuality,
    actual: AudioFacts, desired: SourceAudioFacts, sameMeasuredDelivery = false, options: ImportQualityOptions = {}): boolean {
    if (!importedQualitySatisfies(profile, actualTier, desired, options)) return false;
    if (actualTier === 'spatial') return actual.immersiveFormat === 'dolby-atmos' && actual.objectAudio === true;
    const cutoff = decideImportedQuality(profile, { quality: profile.cutoff }, options).importedQuality;
    if (!profile.continueUpgradesAfterCutoff && cutoff
        && importedQualitySatisfies({ ...profile, continueUpgradesAfterCutoff: true }, actualTier, { quality: profile.cutoff }, options)) return true;
    const decision = decideImportedQuality(profile, desired, options);
    if (sameMeasuredDelivery && actualTier === decision.importedQuality) return true;
    const output = decision.output;
    const preserve = !output || output.codec === 'preserve';
    const expected = observedFactsFromFile({
        codec: preserve ? desired.codec : output.codec,
        bit_depth: output?.bitDepth ?? desired.bitDepth,
        sample_rate: output?.sampleRate ?? desired.sampleRate,
        bitrate: (output?.bitrate ?? desired.bitrate ?? 0) / 1000 || null,
    });
    expected.lossless = decision.importedQuality !== 'lossy';
    expected.confidence = 'expected';
    expected.evidenceSource = 'provider-catalog';
    return fileSatisfiesOffer(actual, expected);
}

function isSameMeasuredDelivery(file: FileCandidate, actual: AudioFacts, size: bigint): boolean {
    if (file.source_audio_variant_id !== file.desired_variant_id || file.provider_item_id !== file.desired_item_id
        || file.provider !== file.desired_provider || file.provider_entity_type !== 'track'
        || file.provider_id !== file.desired_provider_id || file.file_size == null || BigInt(file.file_size) !== size) return false;
    const stored = observedFactsFromFile({ codec: file.codec, bit_depth: file.bit_depth,
        sample_rate: file.sample_rate, bitrate: file.bitrate, channel_count: file.channels });
    if (!stored.codec || stored.codec !== actual.codec || stored.channelCount !== actual.channelCount) return false;
    if (actual.lossless) return stored.bitDepth != null && stored.sampleRateHz != null
        && stored.bitDepth === actual.bitDepth && stored.sampleRateHz === actual.sampleRateHz;
    return stored.bitrateKbps != null && actual.bitrateKbps != null
        && Math.abs(stored.bitrateKbps - actual.bitrateKbps) <= 1;
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
    const qualityOptions = { conformToTarget: Config.getQualityConfig().downconvert_existing_files === true };
    const rows = db.prepare(`SELECT file.id,file.track_id,file.file_path,file.recording_id,file.file_size,file.modified_at,
    COALESCE(track.length_ms,recording.length_ms) AS length_ms,assignment.source_quality_snapshot,
    variant.bit_depth AS source_bit_depth,variant.sample_rate AS source_sample_rate,variant.codec AS source_codec,
    variant.bitrate AS source_bitrate,variant.id AS desired_variant_id,item.id AS desired_item_id,
    item.provider AS desired_provider,item.provider_id AS desired_provider_id,
    file.provider_item_id,file.source_audio_variant_id,file.provider,file.provider_entity_type,file.provider_id,
    file.codec,file.bit_depth,file.sample_rate,file.bitrate,file.channels
    FROM AcquisitionPlanTracks assignment JOIN Tracks track ON track.id=assignment.track_id
    JOIN Recordings recording ON recording.id=track.recording_id
    JOIN ProviderItemAudioVariants variant ON variant.id=assignment.provider_audio_variant_id
    JOIN ProviderTrackMatches match ON match.id=assignment.provider_track_match_id
    JOIN ProviderItems item ON item.id=match.provider_track_item_id AND item.entity_type='track'
    JOIN ProviderEditionMembers member ON member.id=match.provider_edition_member_id AND member.member_item_id=item.id
    JOIN ProviderItems parent ON parent.id=member.provider_edition_item_id AND parent.entity_type='release' AND parent.provider=item.provider
    JOIN TrackFiles file ON file.library_id=? AND file.album_edition_id=?
      AND file.track_id=track.id AND file.recording_id=recording.id AND file.file_class='audio'
    WHERE assignment.plan_id=? AND (variant.provider_item_id=item.id OR variant.provider_item_id=parent.id)
    ORDER BY file.id`).all(header.library_id, header.edition_id, planId) as FileCandidate[];
    const requested = new Set(trackIds);
    const files = requested.size ? rows.filter(row => requested.has(row.track_id)) : rows;
    return { header, profile, files, qualityOptions, identity: JSON.stringify({ header, profileRow, files, qualityOptions }) };
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
                // The common classifier uses the measured codec, without a
                // filename fallback for acquisition completion.
                const quality = normalizedQuality(deriveQuality('', metrics));
                if (!quality || (quality !== 'spatial' && metrics.channels > 2))
                    continue;
                if (file.length_ms && Math.abs(metrics.duration * 1000 - file.length_ms) > Math.max(5000, file.length_ms * 0.02))
                    continue;
                const facts = JSON.parse(file.source_quality_snapshot || '{}') as {
                    quality: NormalizedAudioQuality;
                };
                const actual = observedFactsFromFile({ codec: metrics.codec, codec_profile: metrics.codecProfile, bit_depth: metrics.bitDepth,
                    sample_rate: metrics.sampleRate, bitrate: metrics.bitrate == null ? null : metrics.bitrate / 1000,
                    channel_count: metrics.channels });
                if (!importedFidelitySatisfies(before.profile, quality, actual, { quality: facts.quality,
                    bitDepth: file.source_bit_depth, sampleRate: file.source_sample_rate, codec: file.source_codec,
                    bitrate: file.source_bitrate == null ? null : file.source_bitrate * 1000 },
                    isSameMeasuredDelivery(file, actual, stat.size), before.qualityOptions))
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
