import * as mm from 'music-metadata';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'path';
import axios from 'axios';
import { type Readable } from 'stream';
import { Config } from '../config/config.js';
import { execFile, spawn, type ChildProcessByStdio } from 'child_process';
import fs from 'fs';
import { generateFingerprint } from './fingerprint.js';
import { resolveAcoustIdClientId } from '../config/provider-client-config.js';
import {
    clearMediaTagsWithTagLib,
    replaceMediaCoverWithTagLib,
    writeMediaTagsWithTagLib,
} from './media-tag-io.js';
const IS_WINDOWS = process.platform === "win32";
const DEFAULT_FFMPEG_BINARY = IS_WINDOWS ? "ffmpeg.exe" : "ffmpeg";
const DEFAULT_FFPROBE_BINARY = IS_WINDOWS ? "ffprobe.exe" : "ffprobe";
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mkv", ".mov", ".avi", ".ts", ".webm"]);
const VIDEO_THUMBNAIL_EMBED_EXTENSIONS = new Set([".mp4", ".m4v", ".mov"]);
export const AUDIO_COVER_EMBED_EXTENSIONS = new Set([".m4a", ".m4b", ".m4p", ".mp4", ".flac", ".mp3", ".ogg", ".oga", ".opus"]);
const MUTAGEN_MP4_EXTENSIONS = new Set([".m4a", ".m4b", ".m4p", ".mp4", ".m4v"]);
const SPATIAL_AUDIO_EXTENSIONS = new Set([".ec3", ".ac4"]);
const SPATIAL_AUDIO_CODEC_PREFIXES = ["eac3", "ec3", "ac4"];
const FFMPEG_AUDIO_CONTAINER_EXTENSIONS = new Set([".m4a", ".mp4", ".m4v", ".mov", ".ec3", ".ac4"]);
const MP4_METADATA_REWRITE_EXTENSIONS = new Set([".m4a", ".mp4", ".m4v"]);

function isSpatialAudioCodec(codec: string | null | undefined): boolean {
    const normalizedCodec = String(codec ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");

    return SPATIAL_AUDIO_CODEC_PREFIXES.some((prefix) => normalizedCodec === prefix || normalizedCodec.startsWith(prefix));
}

function resolveFfmpegBinary(): string {
    const override = process.env.FFMPEG_PATH;
    if (!override) return DEFAULT_FFMPEG_BINARY;
    try {
        const stat = fs.statSync(override);
        if (stat.isDirectory()) {
            return path.join(override, DEFAULT_FFMPEG_BINARY);
        }
    } catch {
        // fall through to using override as-is
    }
    return override;
}

export { resolveFfmpegBinary };

function resolveFfprobeBinary(): string {
    const override = process.env.FFMPEG_PATH;
    if (!override) return DEFAULT_FFPROBE_BINARY;
    try {
        const stat = fs.statSync(override);
        if (stat.isDirectory()) {
            return path.join(override, DEFAULT_FFPROBE_BINARY);
        }
    } catch {
        // fall through to using override as-is
    }

    const parsed = path.parse(override);
    if (/^ffmpeg$/i.test(parsed.name)) {
        return path.join(parsed.dir, `${IS_WINDOWS ? "ffprobe.exe" : "ffprobe"}`);
    }

    return override;
}

export function getMetadataRewriteContainerArgs(filePath: string): string[] {
    const extension = path.extname(filePath).toLowerCase();
    if (!MP4_METADATA_REWRITE_EXTENSIONS.has(extension)) {
        return [];
    }

    return ['-movflags', 'use_metadata_tags', '-f', 'mp4'];
}

export async function readFormatTags(filePath: string): Promise<Record<string, string>> {
    const ffprobeBin = resolveFfprobeBinary();

    return new Promise((resolve) => {
        execFile(
            ffprobeBin,
            ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', filePath],
            { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
            (error, stdout) => {
                if (error || !stdout) {
                    resolve({});
                    return;
                }

                try {
                    const parsed = JSON.parse(stdout);
                    const rawTags = parsed?.format?.tags;
                    if (!rawTags || typeof rawTags !== 'object') {
                        resolve({});
                        return;
                    }

                    const tags: Record<string, string> = {};
                    for (const [key, value] of Object.entries(rawTags)) {
                        if (typeof value === 'string' && value.length > 0) {
                            tags[key] = value;
                        }
                    }
                    resolve(tags);
                } catch {
                    resolve({});
                }
            },
        );
    });
}

/**
 * Read a media file's duration (seconds) with ffprobe. Used as a fallback when
 * music-metadata can't parse the container/codec — notably TIDAL Dolby Atmos
 * MP4s (E-AC-3/JOC) — so unmapped-file discovery still gets a duration. Returns
 * null if ffprobe is unavailable (e.g. a bare-metal host without ffmpeg) or the
 * probe fails.
 */
export async function probeMediaDuration(filePath: string): Promise<number | null> {
    const ffprobeBin = resolveFfprobeBinary();

    return new Promise((resolve) => {
        execFile(
            ffprobeBin,
            ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath],
            { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
            (error, stdout) => {
                if (error || !stdout) {
                    resolve(null);
                    return;
                }
                try {
                    const parsed = JSON.parse(stdout);
                    const duration = Number(parsed?.format?.duration);
                    resolve(Number.isFinite(duration) && duration > 0 ? duration : null);
                } catch {
                    resolve(null);
                }
            },
        );
    });
}

export interface AudioMetrics {
    bitrate?: number;
    sampleRate?: number;
    bitDepth?: number;
    /** Audio stream codec (AAC, Opus, FLAC, …). */
    codec?: string;
    /**
     * Video stream codec when the file has a video track (h264, hevc, av1, …).
     * Kept separate from `codec` so audio tooltips/matching stay accurate.
     * Persisted on TrackFiles.video_codec via the import/organize upsert path.
     */
    videoCodec?: string;
    channels?: number;
    duration?: number;
    width?: number;
    height?: number;
    fingerprint?: string; // Add fingerprint to metrics
}

export function shouldProbeAudioMetrics(
    filePath: string,
    metrics: { sampleRate?: number | null; channels?: number | null; codec?: string | null },
): boolean {
    const extension = path.extname(filePath).toLowerCase();
    const sampleRate = Number(metrics.sampleRate || 0);
    return FFMPEG_AUDIO_CONTAINER_EXTENSIONS.has(extension)
        || isSpatialAudioCodec(metrics.codec)
        || metrics.channels == null
        || (sampleRate > 0 && sampleRate < 8_000);
}

export function mergeProbedAudioMetrics(metrics: AudioMetrics, probe: Partial<AudioMetrics>): AudioMetrics {
    return {
        ...metrics,
        ...probe,
        codec: probe.codec || metrics.codec,
        sampleRate: probe.sampleRate || metrics.sampleRate,
        bitDepth: probe.bitDepth || metrics.bitDepth,
        bitrate: probe.bitrate || metrics.bitrate,
        duration: probe.duration || metrics.duration,
        channels: probe.channels || metrics.channels,
    };
}

/** Probe the first audio stream without parsing tags or cover art again. */
export async function probeAudioStreamMetrics(filePath: string): Promise<Partial<AudioMetrics>> {
    const ffprobeBin = resolveFfprobeBinary();
    return new Promise((resolve) => {
        execFile(
            ffprobeBin,
            [
                '-v', 'error',
                '-select_streams', 'a:0',
                '-show_entries', 'stream=codec_name,sample_rate,channels,bits_per_sample,bits_per_raw_sample,bit_rate,duration',
                '-of', 'json',
                filePath,
            ],
            { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
            (error, stdout) => {
                if (error || !stdout) {
                    resolve({});
                    return;
                }

                try {
                    const data = JSON.parse(stdout);
                    const stream = Array.isArray(data?.streams) ? data.streams[0] : null;
                    const rawBitDepth = Number(stream?.bits_per_raw_sample || 0);
                    const sampleBitDepth = Number(stream?.bits_per_sample || 0);
                    resolve({
                        codec: stream?.codec_name || undefined,
                        sampleRate: stream?.sample_rate == null ? undefined : Number(stream.sample_rate),
                        channels: stream?.channels == null ? undefined : Number(stream.channels),
                        bitDepth: rawBitDepth > 0 ? rawBitDepth : sampleBitDepth > 0 ? sampleBitDepth : undefined,
                        bitrate: stream?.bit_rate == null ? undefined : Number(stream.bit_rate),
                        duration: stream?.duration == null ? undefined : Number(stream.duration),
                    });
                } catch {
                    resolve({});
                }
            },
        );
    });
}

export interface BrowserCompatibleAudioSource {
    fileType?: string | null;
    quality?: string | null;
    codec?: string | null;
    extension?: string | null;
}

export async function calculateFingerprint(filePath: string): Promise<string | null> {
    try {
        const result = await generateFingerprint(filePath);
        return result.fingerprint;
    } catch (error) {
        console.warn(`Failed to calculate fingerprint for ${filePath}:`, error);
        return null;
    }
}

export async function parseAudioFile(filePath: string): Promise<AudioMetrics> {
    try {
        const metadata = await mm.parseFile(filePath);
        const format = metadata.format;
        const metrics: AudioMetrics = {
            bitrate: format.bitrate,
            sampleRate: format.sampleRate,
            bitDepth: format.bitsPerSample,
            codec: format.codec,
            channels: format.numberOfChannels,
            duration: format.duration
        };

        const extension = path.extname(filePath).toLowerCase();
        if (shouldProbeAudioMetrics(filePath, metrics)) {
            Object.assign(metrics, mergeProbedAudioMetrics(metrics, await probeAudioStreamMetrics(filePath)));
        }

        if (!VIDEO_EXTENSIONS.has(extension)) {
            return metrics;
        }

        const ffprobeBin = resolveFfprobeBinary();
        const videoProbe = await new Promise<Partial<AudioMetrics>>((resolve) => {
            execFile(
                ffprobeBin,
                ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name', '-of', 'json', filePath],
                { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
                (error, stdout) => {
                    if (error || !stdout) {
                        resolve({});
                        return;
                    }

                    try {
                        const data = JSON.parse(stdout);
                        const stream = Array.isArray(data?.streams) ? data.streams[0] : null;
                        const videoCodec = typeof stream?.codec_name === "string" && stream.codec_name
                            ? String(stream.codec_name)
                            : undefined;
                        resolve({
                            width: typeof stream?.width === "number" ? stream.width : undefined,
                            height: typeof stream?.height === "number" ? stream.height : undefined,
                            // Keep audio `codec`; surface the video FourCC separately.
                            videoCodec,
                            // Legacy fallback: only fill `codec` from video when no audio codec exists.
                            codec: metrics.codec || videoCodec,
                        });
                    } catch {
                        resolve({});
                    }
                },
            );
        });

        return {
            ...metrics,
            ...videoProbe,
            codec: metrics.codec || videoProbe.codec,
            videoCodec: videoProbe.videoCodec,
        };
    } catch (error) {
        console.warn(`Failed to parse metadata for ${filePath}`, error);
        return {};
    }
}

export function deriveQuality(ext: string, metrics: AudioMetrics): string {
    const extension = ext.replace('.', '').toLowerCase();
    const { sampleRate, bitDepth, bitrate, codec } = metrics;
    const codecName = codec?.toLowerCase() || '';

    // provider spatial formats currently arrive as Dolby container codecs.
    if (isSpatialAudioCodec(codecName)) {
        return 'DOLBY_ATMOS';
    }

    // Lossless formats
    if (['flac', 'wav', 'alac', 'aif', 'aiff'].includes(extension) || (extension === 'm4a' && codecName === 'alac')) {
        if ((sampleRate && sampleRate > 48000) || (bitDepth && bitDepth > 16)) {
            return 'HIRES_LOSSLESS';
        }
        return 'LOSSLESS';
    }

    // Compressed formats
    if (['mp3', 'aac', 'ogg', 'opus', 'omm', 'wma', 'mp2'].includes(extension) || (extension === 'm4a' && codecName !== 'alac')) {
        const opus = codecName.includes('opus') || extension === 'opus';
        const lowBitrate = opus ? 128000 : 192000;
        if (bitrate && bitrate < lowBitrate) {
            return 'LOW';
        }
        return 'HIGH';
    }

    // An unrecognised container is not evidence of lossless audio. Claiming
    // LOSSLESS here made the file look like it already met a lossless cutoff,
    // which silently suppressed every allowed upgrade for it. UNKNOWN
    // normalizes to no tier, which ranks below any cutoff and stays upgradable.
    return 'UNKNOWN';
}

export function requiresBrowserCompatibleAudioStream(source: BrowserCompatibleAudioSource): boolean {
    const fileType = String(source.fileType ?? '').trim().toLowerCase();
    if (fileType && fileType !== 'track') {
        return false;
    }

    const quality = String(source.quality ?? '').trim().toUpperCase();
    if (quality === 'DOLBY_ATMOS') {
        return true;
    }

    const codec = String(source.codec ?? '').trim().toLowerCase();
    if (isSpatialAudioCodec(codec)) {
        return true;
    }

    const extension = String(source.extension ?? '').trim().toLowerCase().replace(/^\./, '');
    if (SPATIAL_AUDIO_EXTENSIONS.has(`.${extension}`) || SPATIAL_AUDIO_EXTENSIONS.has(extension)) {
        return true;
    }

    // Chromium can fail a ranged FLAC/ALAC play (MEDIA_ERR_SRC_NOT_SUPPORTED)
    // and the UI then falls back to a provider preview. Transcode those to a
    // progressive AAC stream the same way spatial files already do.
    if (extension === 'flac' || extension === 'wav' || extension === 'aiff' || extension === 'aif') {
        return true;
    }
    if (codec === 'flac' || codec === 'alac' || codec === 'pcm') {
        return true;
    }
    return false;
}

export function deriveVideoQuality(metrics: AudioMetrics): string | null {
    const height = metrics.height ?? 0;
    const width = metrics.width ?? 0;

    if (!height && !width) {
        return null;
    }

    // Prefer the longer edge so ultrawide 4K masters (e.g. 3832×1592) count as
    // UHD instead of FHD. Fall back to a 16:9 height estimate when only width
    // is known.
    const effectiveHeight = height > 0 ? height : Math.round(width * 9 / 16);
    const longerEdge = Math.max(width, height, effectiveHeight);
    if (longerEdge >= 2160) return "UHD";
    if (effectiveHeight >= 1080 || width >= 1900) return "FHD";
    if (effectiveHeight >= 720 || width >= 1200) return "HD";
    return "SD";
}

export async function lookupAcoustId(fingerprint: string, duration: number): Promise<string | null> {
    const apiKey = resolveAcoustIdClientId({
        env: process.env,
        appConfig: Config.getAppConfig(),
    });
    if (!apiKey) return null;

    try {
        const url = `https://api.acoustid.org/v2/lookup?client=${apiKey}&meta=recordings&duration=${Math.floor(duration)}&fingerprint=${fingerprint}`;
        const response = await axios.get(url);
        if (response.data && response.data.results && response.data.results.length > 0) {
            return response.data.results[0].id;
        }
    } catch (e) {
        console.warn('AcoustID lookup failed', e);
    }
    return null;
}

export function buildMetadataWriteArgs(
    filePath: string,
    tags: Record<string, string>,
    removeKeys: string[] = [],
    tempPath = filePath + '.tmp' + path.extname(filePath),
    attachedPictureVideoStreamIndexes: number[] = [],
): string[] {
    const removalArgs = Array.from(new Set(removeKeys.map((key) => key.trim()).filter(Boolean)))
        .flatMap((key) => ['-metadata', `${key}=`]);
    const metadataArgs = Object.entries(tags)
        .filter(([, value]) => typeof value === 'string' && value.length > 0)
        .flatMap(([key, value]) => ['-metadata', `${key}=${value}`]);
    const attachedPictureArgs = attachedPictureVideoStreamIndexes
        .filter((index) => Number.isInteger(index) && index >= 0)
        .flatMap((index) => [`-disposition:v:${index}`, 'attached_pic']);
    return [
        '-y',
        '-i', filePath,
        // Preserve every stream, including MP4 attached-picture thumbnails.
        // ffmpeg's default stream selection keeps only one video stream and
        // silently discarded the thumbnail when VideoTagService ran afterward.
        '-map', '0',
        '-map_metadata', '0',
        ...removalArgs,
        ...metadataArgs,
        '-c', 'copy',
        ...attachedPictureArgs,
        ...getMetadataRewriteContainerArgs(filePath),
        tempPath
    ];
}

export async function writeMetadata(filePath: string, tags: Record<string, string>, removeKeys: string[] = []): Promise<boolean> {
    const tagLibResult = await writeMediaTagsWithTagLib(filePath, tags, removeKeys);
    if (tagLibResult.success) {
        return true;
    }
    if (tagLibResult.handled) {
        console.warn(`[MediaTags] TagLib write failed for ${filePath}; using compatibility backend: ${tagLibResult.error || "unknown error"}`);
    }
    if (MUTAGEN_MP4_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        return writeMp4MetadataWithMutagen(filePath, tags, removeKeys);
    }
    const tempPath = filePath + '.tmp' + path.extname(filePath);
    const attachedPictures = await getAttachedPictureVideoStreamIndexes(filePath);
    const args = buildMetadataWriteArgs(filePath, tags, removeKeys, tempPath, attachedPictures);

    return new Promise((resolve) => {
        const ffmpegBin = resolveFfmpegBinary();
        let settled = false;
        const finish = (value: boolean) => {
            if (settled) {
                return;
            }

            settled = true;
            if (!value && fs.existsSync(tempPath)) {
                fs.rmSync(tempPath, { force: true });
            }
            resolve(value);
        };

        const child = spawn(ffmpegBin, args, {
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true,
        });

        const killTimer = setTimeout(() => {
            console.error(`Metadata write timed out for ${filePath}`);
            child.kill("SIGKILL");
            finish(false);
        }, 30_000);
        const originalFinish = finish;
        const finishWithTimer = (value: boolean) => {
            clearTimeout(killTimer);
            originalFinish(value);
        };

        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('error', (error) => {
            console.error(`Failed to launch metadata write for ${filePath}`, error);
            finishWithTimer(false);
        });

        child.on('close', (code) => {
            if (code !== 0) {
                console.error(`Failed to write metadata for ${filePath}: ${stderr.trim() || `ffmpeg exited with code ${code}`}`);
                finishWithTimer(false);
                return;
            }

            try {
                if (!fs.existsSync(tempPath)) {
                    console.error(`Metadata write failed silently: Temp file ${tempPath} missing.`);
                    finishWithTimer(false);
                    return;
                }
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                fs.renameSync(tempPath, filePath);
                finishWithTimer(true);
            } catch (e) {
                console.error(`Failed to rename temp file ${tempPath}`, e);
                finishWithTimer(false);
            }
        });
    });
}

/**
 * Strip all metadata tags from an audio file (equivalent of scrubbing all existing tags).
 * Uses ffmpeg with `-map_metadata -1` to remove all existing tags before a clean rewrite.
 */
export async function removeAllTags(filePath: string): Promise<boolean> {
    const tagLibResult = await clearMediaTagsWithTagLib(filePath);
    if (tagLibResult.success) {
        return true;
    }
    if (tagLibResult.handled) {
        console.warn(`[MediaTags] TagLib clear failed for ${filePath}; using compatibility backend: ${tagLibResult.error || "unknown error"}`);
    }
    if (MUTAGEN_MP4_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        return runMutagenBridge(['clear', filePath], filePath);
    }
    const tempPath = filePath + '.scrub' + path.extname(filePath);
    const attachedPictures = await getAttachedPictureVideoStreamIndexes(filePath);
    const dispositionArgs = attachedPictures.flatMap((index) => [`-disposition:v:${index}`, 'attached_pic']);
    const args = [
        '-y', '-i', filePath, '-map', '0', '-map_metadata', '-1', '-c', 'copy',
        ...dispositionArgs,
        ...getMetadataRewriteContainerArgs(filePath),
        tempPath,
    ];

    return new Promise((resolve) => {
        const ffmpegBin = resolveFfmpegBinary();
        let settled = false;
        const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            if (!value && fs.existsSync(tempPath)) {
                fs.rmSync(tempPath, { force: true });
            }
            resolve(value);
        };

        const child = spawn(ffmpegBin, args, {
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true,
        });

        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on('error', () => finish(false));
        child.on('close', (code) => {
            if (code !== 0) {
                console.error(`Failed to scrub tags from ${filePath}: ${stderr.trim() || `exit ${code}`}`);
                finish(false);
                return;
            }
            try {
                if (!fs.existsSync(tempPath)) { finish(false); return; }
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                fs.renameSync(tempPath, filePath);
                finish(true);
            } catch {
                finish(false);
            }
        });
    });
}

export async function hasEmbeddedVideoThumbnail(filePath: string): Promise<boolean> {
    const extension = path.extname(filePath).toLowerCase();
    if (!VIDEO_THUMBNAIL_EMBED_EXTENSIONS.has(extension)) {
        return false;
    }

    return (await getAttachedPictureVideoStreamIndexes(filePath)).length > 0;
}

async function getAttachedPictureVideoStreamIndexes(filePath: string): Promise<number[]> {
    return new Promise((resolve) => {
        const ffprobeBin = resolveFfprobeBinary();
        execFile(
            ffprobeBin,
            getVideoThumbnailProbeArgs(filePath),
            { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
            (error, stdout) => {
                if (error || !stdout) {
                    resolve([]);
                    return;
                }

                try {
                    const data = JSON.parse(stdout);
                    const streams: Array<{ disposition?: { attached_pic?: number } }> = Array.isArray(data?.streams)
                        ? data.streams
                        : [];
                    resolve(streams.reduce((indexes: number[], stream, videoStreamIndex: number) => {
                        if (stream?.disposition?.attached_pic === 1) {
                            indexes.push(videoStreamIndex);
                        }
                        return indexes;
                    }, []));
                } catch {
                    resolve([]);
                }
            },
        );
    });
}

export function getVideoThumbnailProbeArgs(filePath: string): string[] {
    return ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream_disposition=attached_pic', '-of', 'json', filePath];
}

function resolveMutagenBridge(): { python: string; script: string } | null {
    const scriptCandidates = [
        path.resolve(process.cwd(), 'src/services/mediafiles/mutagen-cover-bridge.py'),
        path.resolve(process.cwd(), 'api/src/services/mediafiles/mutagen-cover-bridge.py'),
    ];
    const script = scriptCandidates.find((candidate) => fs.existsSync(candidate));
    if (!script) return null;

    const configuredPython = String(process.env.DISCOGENIUS_MEDIA_TAGS_PYTHON || '').trim();
    const bundledPython = '/usr/local/bin/python3';
    const python = configuredPython
        || (fs.existsSync(bundledPython) ? bundledPython : (IS_WINDOWS ? 'python.exe' : 'python3'));
    return { python, script };
}

function runMutagenBridge(args: string[], targetPath: string): Promise<boolean> {
    const bridge = resolveMutagenBridge();
    if (!bridge) return Promise.resolve(false);
    return new Promise((resolve) => {
        execFile(
            bridge.python,
            [bridge.script, ...args],
            { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
            (error, _stdout, stderr) => {
                if (error) {
                    console.warn(`[MediaTags] Mutagen update failed for ${targetPath}: ${String(stderr || error.message).trim()}`);
                    resolve(false);
                    return;
                }
                resolve(true);
            },
        );
    });
}

async function writeMp4MetadataWithMutagen(
    filePath: string,
    tags: Record<string, string>,
    removeKeys: string[],
): Promise<boolean> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discogenius-mp4-tags-'));
    const payloadPath = path.join(tempDir, 'tags.json');
    try {
        fs.writeFileSync(payloadPath, JSON.stringify({ tags, removeKeys }), 'utf-8');
        return await runMutagenBridge(['metadata', filePath, payloadPath], filePath);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

/**
 * Replace embedded audio artwork in place while preserving every existing tag.
 * Mutagen is used because ffmpeg's MP4 `use_metadata_tags` mode cannot retain
 * both MusicBrainz mdta atoms and a `covr` attached-picture atom.
 */
export async function embedAudioCover(filePath: string, coverPath: string): Promise<boolean> {
    const extension = path.extname(filePath).toLowerCase();
    if (!AUDIO_COVER_EMBED_EXTENSIONS.has(extension) || !fs.existsSync(filePath) || !fs.existsSync(coverPath)) {
        return false;
    }

    const tagLibResult = await replaceMediaCoverWithTagLib(filePath, coverPath);
    if (tagLibResult.success) {
        return true;
    }
    if (tagLibResult.handled) {
        console.warn(`[MediaTags] TagLib cover write failed for ${filePath}; using compatibility backend: ${tagLibResult.error || "unknown error"}`);
    }
    return runMutagenBridge(['cover', filePath, coverPath], filePath);
}

/**
 * Read the raw bytes of the cover art stored in an MP4/M4A container's `covr`
 * atom (moov→udta→meta→ilst→covr→data), straight from the box tree. This mirrors
 * how TagLib reads Atmos/spatial MP4 files: the picture lives in a container-level
 * atom, so the exotic EC-3/AC-4 audio codec is irrelevant (and is exactly why
 * music-metadata, which parses the audio stream, misses these covers). Returns
 * null when there is no covr atom or the file cannot be parsed.
 */
function readMp4CoverAtomBytes(filePath: string): Buffer | null {
    let fd: number | null = null;
    try {
        fd = fs.openSync(filePath, 'r');
        const stat = fs.fstatSync(fd);
        const header = Buffer.alloc(16);

        const readAtomHeader = (position: number, rangeEnd: number): { size: number; type: string; headerSize: number } | null => {
            if (position + 8 > rangeEnd) return null;
            const read = fs.readSync(fd!, header, 0, 16, position);
            if (read < 8) return null;
            let size = header.readUInt32BE(0);
            const type = header.toString('latin1', 4, 8);
            let headerSize = 8;
            if (size === 1) {
                if (read < 16) return null;
                size = Number(header.readBigUInt64BE(8));
                headerSize = 16;
            } else if (size === 0) {
                size = rangeEnd - position;
            }
            if (!Number.isFinite(size) || size < headerSize || position + size > rangeEnd) return null;
            return { size, type, headerSize };
        };

        // Descend only the atoms on the path to covr; never blindly read a `data`
        // atom unless its parent is `covr` (every ilst tag entry has its own data).
        const NAVIGABLE = new Set(['moov', 'udta', 'meta', 'ilst']);
        let cover: Buffer | null = null;

        const walk = (start: number, end: number, insideCovr: boolean): void => {
            let position = start;
            while (position + 8 <= end && !cover) {
                const atom = readAtomHeader(position, end);
                if (!atom) break;
                const payloadStart = position + atom.headerSize + (atom.type === 'meta' ? 4 : 0);
                const payloadEnd = position + atom.size;
                if (atom.type === 'data' && insideCovr) {
                    // `data` atom: 4 bytes version+type, 4 bytes locale, then payload.
                    const dataStart = position + atom.headerSize + 8;
                    const length = payloadEnd - dataStart;
                    if (length > 0 && length <= 32 * 1024 * 1024) {
                        const buffer = Buffer.alloc(length);
                        fs.readSync(fd!, buffer, 0, length, dataStart);
                        cover = buffer;
                    }
                } else if (atom.type === 'covr') {
                    walk(payloadStart, payloadEnd, true);
                } else if (NAVIGABLE.has(atom.type)) {
                    walk(payloadStart, payloadEnd, false);
                }
                position += atom.size;
            }
        };

        walk(0, stat.size, false);
        return cover;
    } catch {
        return null;
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch { /* ignore */ }
        }
    }
}

/**
 * Bytes of the picture currently embedded in an audio file, or null when there
 * is none. No subprocess: MP4/M4A covers come from the container's covr atom
 * (codec-independent), everything else from music-metadata's single parse.
 *
 * `preread` lets a caller that already parsed the file hand over the picture it
 * found so we don't re-read: pass the Buffer when present, `null` when the parse
 * found none (skips a redundant re-parse), or omit it entirely for a
 * self-contained read (the apply/backfill paths).
 */
async function readEmbeddedAudioCoverBytes(filePath: string, preread?: Buffer | Uint8Array | null): Promise<Buffer | null> {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    if (preread && preread.length > 0) {
        return Buffer.isBuffer(preread) ? preread : Buffer.from(preread);
    }

    const extension = path.extname(filePath).toLowerCase();
    if (MUTAGEN_MP4_EXTENSIONS.has(extension)) {
        const covr = readMp4CoverAtomBytes(filePath);
        if (covr && covr.length > 0) {
            return covr;
        }
    }

    // No caller-supplied picture (preread === undefined) → parse once ourselves.
    // A caller that passed `null` already told us its parse found no picture, so
    // for non-MP4 files there is nothing more to read.
    if (preread === undefined) {
        try {
            const metadata = await mm.parseFile(filePath, { skipCovers: false, duration: false });
            const picture = metadata.common?.picture?.[0]?.data;
            if (picture && picture.length > 0) {
                return Buffer.isBuffer(picture) ? picture : Buffer.from(picture);
            }
        } catch {
            // Unreadable audio stream (e.g. some Atmos MP4s) → treat as no cover;
            // the covr-atom path above already handled MP4 containers.
        }
    }
    return null;
}

export type CoverImageInfo = {
    /** Pixel width, when readable from the JPEG/PNG header. */
    width: number | null;
    /** Pixel height, when readable from the JPEG/PNG header. */
    height: number | null;
    /** Encoded byte size. */
    bytes: number;
};

export type EmbeddedCoverComparison = {
    /** True when the embedded cover is byte-identical to coverPath. */
    matches: boolean;
    /** The cover currently embedded in the file, or null when there is none. */
    current: CoverImageInfo | null;
    /** The target cover at coverPath, or null when it is unreadable/unsupported. */
    target: CoverImageInfo | null;
};

/** Read pixel dimensions straight from a JPEG or PNG header buffer (no decode,
 * no ffprobe round-trip). Returns null when the format is unrecognised. */
export function readImageDimensionsFromBuffer(buffer: Buffer): { width: number; height: number } | null {
    if (buffer.length < 24) return null;

    // PNG: 8-byte signature, then IHDR (width @ 16, height @ 20), big-endian.
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }

    // JPEG: walk marker segments to the Start-Of-Frame that carries dimensions.
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < buffer.length) {
            if (buffer[offset] !== 0xff) { offset += 1; continue; }
            const marker = buffer[offset + 1];
            // SOF0-SOF15 carry frame dimensions; C4/C8/CC are not frame headers.
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
            }
            if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
                offset += 2;
                continue;
            }
            const segmentLength = buffer.readUInt16BE(offset + 2);
            if (segmentLength < 2) return null;
            offset += 2 + segmentLength;
        }
    }

    return null;
}

function describeCoverBuffer(buffer: Buffer): CoverImageInfo {
    const dimensions = readImageDimensionsFromBuffer(buffer);
    return {
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
        bytes: buffer.length,
    };
}

/**
 * Single source of truth for the retag cover comparison: reads the currently
 * embedded cover (covr atom for MP4, music-metadata otherwise — no subprocess),
 * compares it byte-for-byte with coverPath, and returns pixel size + byte size
 * for both so the preview can show a real diff. The apply path consumes only
 * `.matches`; the preview also surfaces `.current` / `.target`.
 *
 * `currentCover` lets a caller that already parsed the file pass the embedded
 * picture it found (Buffer, or `null` when its parse found none) to avoid a
 * re-read; omit it for a self-contained comparison.
 */
export async function compareEmbeddedAudioCover(
    filePath: string,
    coverPath: string,
    currentCover?: Buffer | Uint8Array | null,
): Promise<EmbeddedCoverComparison> {
    const extension = path.extname(filePath).toLowerCase();
    if (!AUDIO_COVER_EMBED_EXTENSIONS.has(extension) || !fs.existsSync(coverPath)) {
        return { matches: false, current: null, target: null };
    }

    const currentBytes = await readEmbeddedAudioCoverBytes(filePath, currentCover);
    let targetBytes: Buffer | null = null;
    try {
        targetBytes = fs.readFileSync(coverPath);
    } catch {
        targetBytes = null;
    }

    const current = currentBytes && currentBytes.length > 0 ? describeCoverBuffer(currentBytes) : null;
    const target = targetBytes && targetBytes.length > 0 ? describeCoverBuffer(targetBytes) : null;

    const hash = (buffer: Buffer): string => crypto.createHash('sha256').update(buffer).digest('hex');
    const matches = Boolean(currentBytes && targetBytes && hash(currentBytes) === hash(targetBytes));

    return { matches, current, target };
}

export async function embedVideoThumbnail(videoPath: string, thumbnailPath: string): Promise<boolean> {
    const extension = path.extname(videoPath).toLowerCase();
    if (!VIDEO_THUMBNAIL_EMBED_EXTENSIONS.has(extension)) {
        return false;
    }

    if (!fs.existsSync(videoPath) || !fs.existsSync(thumbnailPath)) {
        return false;
    }

    if (await hasEmbeddedVideoThumbnail(videoPath)) {
        return true;
    }

    const tempPath = videoPath + '.tmp' + extension;
    const args = [
        '-y',
        '-i', videoPath,
        '-i', thumbnailPath,
        '-map', '0',
        '-map', '1:v:0',
        '-map_metadata', '0',
        '-c', 'copy',
        '-c:v:1', 'mjpeg',
        '-disposition:v:1', 'attached_pic',
        tempPath,
    ];

    return new Promise((resolve) => {
        const ffmpegBin = resolveFfmpegBinary();
        let settled = false;
        const finish = (value: boolean) => {
            if (settled) {
                return;
            }

            settled = true;
            if (!value && fs.existsSync(tempPath)) {
                fs.rmSync(tempPath, { force: true });
            }
            resolve(value);
        };

        const child = spawn(ffmpegBin, args, {
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true,
        });

        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('error', (error) => {
            console.error(`Failed to launch video thumbnail embed for ${videoPath}`, error);
            finish(false);
        });

        child.on('close', (code) => {
            if (code !== 0) {
                console.error(`Failed to embed thumbnail for ${videoPath}: ${stderr.trim() || `ffmpeg exited with code ${code}`}`);
                finish(false);
                return;
            }

            try {
                if (!fs.existsSync(tempPath)) {
                    console.error(`Video thumbnail embed failed silently: Temp file ${tempPath} missing.`);
                    finish(false);
                    return;
                }
                if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
                fs.renameSync(tempPath, videoPath);
                finish(true);
            } catch (error) {
                console.error(`Failed to finalize embedded thumbnail for ${videoPath}`, error);
                finish(false);
            }
        });
    });
}

export interface VideoTagSet {
    title?: string;
    artist?: string[];
    album_artist?: string;
    album?: string;
    date?: string;
    comment?: string;
    copyright?: string;
}

export async function writeVideoTags(filePath: string, tags: VideoTagSet): Promise<void> {
    const extension = path.extname(filePath).toLowerCase();
    if (![".mp4", ".m4v", ".mov"].includes(extension)) {
        console.warn(`[writeVideoTags] Unsupported extension "${extension}" for ${filePath}; skipping.`);
        return;
    }

    const ffmpegTags: Record<string, string> = {};
    if (tags.title) ffmpegTags["title"] = tags.title;
    if (tags.artist?.length) ffmpegTags["artist"] = tags.artist.join(", ");
    if (tags.album_artist) ffmpegTags["album_artist"] = tags.album_artist;
    if (tags.album) ffmpegTags["album"] = tags.album;
    if (tags.date) ffmpegTags["date"] = tags.date;
    if (tags.comment) ffmpegTags["comment"] = tags.comment;
    if (tags.copyright) ffmpegTags["copyright"] = tags.copyright;

    if (Object.keys(ffmpegTags).length === 0) {
        return;
    }

    const success = await writeMetadata(filePath, ffmpegTags);
    if (!success) {
        throw new Error(`writeMetadata failed for ${filePath}`);
    }
}

export async function convertToMp4(inputPath: string, outputPath: string): Promise<boolean> {
    const args = [
        '-y',
        '-i', inputPath,
        '-c:v', 'copy', // Copy video stream (Tidal uses h264/h265 usually)
        '-c:a', 'aac',  // Convert audio to AAC for max browser compatibility
        '-strict', 'experimental',
        outputPath
    ];

    return new Promise((resolve) => {
        const ffmpegBin = resolveFfmpegBinary();
        execFile(ffmpegBin, args, { windowsHide: true }, (error) => {
            if (error) {
                console.error(`MP4 Conversion failed for ${inputPath}:`, error);
                resolve(false);
                return;
            }
            resolve(true);
        });
    });
}

export function spawnBrowserCompatibleAudioTranscode(
    inputPath: string,
    options: { bitrate?: string } = {},
): ChildProcessByStdio<null, Readable, Readable> {
    const ffmpegBin = resolveFfmpegBinary();
    const args = [
        '-v', 'error',
        '-i', inputPath,
        '-map_metadata', '0',
        '-vn',
        '-c:a', 'aac',
        '-b:a', options.bitrate || '256k',
        '-ac', '2',
        '-movflags', 'frag_keyframe+empty_moov',
        '-f', 'mp4',
        'pipe:1',
    ];

    return spawn(ffmpegBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
}
