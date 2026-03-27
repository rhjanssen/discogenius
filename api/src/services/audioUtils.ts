import * as mm from 'music-metadata';
import path from 'path';
import axios from 'axios';
import { type Readable } from 'stream';
import { Config } from './config.js';
import { exec, spawn, type ChildProcessByStdio } from 'child_process';
import fs from 'fs';
import { generateFingerprint } from './fingerprint.js';
import { resolveAcoustIdClientId } from './provider-client-config.js';
const IS_WINDOWS = process.platform === "win32";
const DEFAULT_FFMPEG_BINARY = IS_WINDOWS ? "ffmpeg.exe" : "ffmpeg";
const DEFAULT_FFPROBE_BINARY = IS_WINDOWS ? "ffprobe.exe" : "ffprobe";
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mkv", ".mov", ".avi", ".ts", ".webm"]);
const VIDEO_THUMBNAIL_EMBED_EXTENSIONS = new Set([".mp4", ".m4v", ".mov"]);
const ATMOS_AUDIO_EXTENSIONS = new Set([".ec3", ".ac4"]);
const ATMOS_AUDIO_CODEC_PREFIXES = ["eac3", "ec3", "ac4"];

function isAtmosAudioCodec(codec: string | null | undefined): boolean {
    const normalizedCodec = String(codec ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");

    return ATMOS_AUDIO_CODEC_PREFIXES.some((prefix) => normalizedCodec === prefix || normalizedCodec.startsWith(prefix));
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

export interface AudioMetrics {
    bitrate?: number;
    sampleRate?: number;
    bitDepth?: number;
    codec?: string;
    channels?: number;
    duration?: number;
    width?: number;
    height?: number;
    fingerprint?: string; // Add fingerprint to metrics
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
        if (!VIDEO_EXTENSIONS.has(extension)) {
            return metrics;
        }

        const ffprobeBin = resolveFfprobeBinary();
        const videoProbe = await new Promise<Partial<AudioMetrics>>((resolve) => {
            exec(
                `"${ffprobeBin}" -v error -select_streams v:0 -show_entries stream=width,height,codec_name -of json "${filePath}"`,
                (error, stdout) => {
                    if (error || !stdout) {
                        resolve({});
                        return;
                    }

                    try {
                        const data = JSON.parse(stdout);
                        const stream = Array.isArray(data?.streams) ? data.streams[0] : null;
                        resolve({
                            width: typeof stream?.width === "number" ? stream.width : undefined,
                            height: typeof stream?.height === "number" ? stream.height : undefined,
                            codec: metrics.codec || stream?.codec_name || undefined,
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

    // Dolby Atmos
    if (isAtmosAudioCodec(codecName)) {
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
    if (['mp3', 'aac', 'ogg', 'opus', 'omm'].includes(extension) || (extension === 'm4a' && codecName !== 'alac')) {
        if (bitrate && bitrate < 192000) {
            return 'LOW';
        }
        return 'HIGH';
    }

    return 'LOSSLESS'; // Default fallback
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
    if (isAtmosAudioCodec(codec)) {
        return true;
    }

    const extension = String(source.extension ?? '').trim().toLowerCase();
    return ATMOS_AUDIO_EXTENSIONS.has(extension);
}

export function deriveVideoQuality(metrics: AudioMetrics): string | null {
    const height = metrics.height ?? 0;
    const width = metrics.width ?? 0;

    if (!height && !width) {
        return null;
    }

    if (height >= 1000 || width >= 1900) {
        return "MP4_1080P";
    }
    if (height >= 700 || width >= 1200) {
        return "MP4_720P";
    }
    if (height >= 470 || width >= 840) {
        return "MP4_480P";
    }
    return "MP4_360P";
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

export async function writeMetadata(filePath: string, tags: Record<string, string>): Promise<boolean> {
    const metadataArgs = Object.entries(tags)
        .filter(([, value]) => typeof value === 'string' && value.length > 0)
        .flatMap(([key, value]) => ['-metadata', `${key}=${value}`]);
    const tempPath = filePath + '.tmp' + path.extname(filePath);

    const args = [
        '-y',
        '-i', filePath,
        '-map_metadata', '0',
        ...metadataArgs,
        '-c', 'copy',
        tempPath
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
            console.error(`Failed to launch metadata write for ${filePath}`, error);
            finish(false);
        });

        child.on('close', (code) => {
            if (code !== 0) {
                console.error(`Failed to write metadata for ${filePath}: ${stderr.trim() || `ffmpeg exited with code ${code}`}`);
                finish(false);
                return;
            }

            try {
                if (!fs.existsSync(tempPath)) {
                    console.error(`Metadata write failed silently: Temp file ${tempPath} missing.`);
                    finish(false);
                    return;
                }
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                fs.renameSync(tempPath, filePath);
                finish(true);
            } catch (e) {
                console.error(`Failed to rename temp file ${tempPath}`, e);
                finish(false);
            }
        });
    });
}

async function hasEmbeddedVideoThumbnail(filePath: string): Promise<boolean> {
    const extension = path.extname(filePath).toLowerCase();
    if (!VIDEO_THUMBNAIL_EMBED_EXTENSIONS.has(extension)) {
        return false;
    }

    return new Promise((resolve) => {
        const ffprobeBin = resolveFfprobeBinary();
        exec(
            `"${ffprobeBin}" -v error -select_streams v -show_entries stream=disposition -of json "${filePath}"`,
            (error, stdout) => {
                if (error || !stdout) {
                    resolve(false);
                    return;
                }

                try {
                    const data = JSON.parse(stdout);
                    const streams = Array.isArray(data?.streams) ? data.streams : [];
                    resolve(streams.some((stream: any) => stream?.disposition?.attached_pic === 1));
                } catch {
                    resolve(false);
                }
            },
        );
    });
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
        '-i', `"${inputPath}"`,
        '-c:v', 'copy', // Copy video stream (Tidal uses h264/h265 usually)
        '-c:a', 'aac',  // Convert audio to AAC for max browser compatibility
        '-strict', 'experimental',
        `"${outputPath}"`
    ];

    return new Promise((resolve) => {
        const ffmpegBin = resolveFfmpegBinary();
        exec(`"${ffmpegBin}" ${args.join(' ')}`, (error) => {
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
