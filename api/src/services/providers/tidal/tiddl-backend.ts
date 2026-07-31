import { spawn } from "child_process";
import { DownloadBackend, DownloadRequest, DownloadProgress } from "../../download/download-backend.js";
import {
    buildTiddlEnv,
    capTiddlTrackQuality,
    getTiddlBinary,
    getTiddlProgressWrapperScript,
    getTiddlPythonBinary,
    mapAudioQualityToTiddl,
    mapVideoQualityToTiddl,
    syncTiddlSettings,
} from "./tiddl.js";
import { isSpatialAudioQuality } from "../../../utils/spatial-audio.js";

export { TIDDL_CONFIG_DIR, TIDDL_AUTH_FILE, getTiddlCapabilitySnapshot } from "./tiddl.js";

function stripAnsi(text: string): string {
    return text
        // OSC sequences (Rich emits OSC-8 hyperlinks around file paths),
        // terminated by BEL or ST.
        // eslint-disable-next-line no-control-regex
        .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
        // CSI and other escape sequences.
        // eslint-disable-next-line no-control-regex
        .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

const TIDDL_PROGRESS_PREFIX = "DISCOGENIUS_TIDDL_PROGRESS ";

export type TiddlProgressEvent = {
    event?: string;
    title?: string;
    providerTrackId?: string | number | null;
    trackNumber?: number | null;
    volumeNumber?: number | null;
    trackStatus?: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped' | null;
    bytesDownloaded?: number | null;
    bytesTotal?: number | null;
    bytesPerSecond?: number | null;
    percent?: number | null;
    total?: number | null;
    completed?: number | null;
};

export function parseTiddlProgressEvent(line: string): TiddlProgressEvent | null {
    // ffmpeg/tiddl share the wrapper's stderr, so \r-redraw noise can end up
    // glued in front of a progress line — locate the prefix anywhere.
    const prefixIndex = line.indexOf(TIDDL_PROGRESS_PREFIX);
    if (prefixIndex < 0) {
        return null;
    }

    try {
        const parsed = JSON.parse(line.slice(prefixIndex + TIDDL_PROGRESS_PREFIX.length));
        return parsed && typeof parsed === "object" ? parsed as TiddlProgressEvent : null;
    } catch {
        return null;
    }
}

/** A progress line that got split mid-JSON: never surface it as status text. */
function looksLikeProgressFragment(line: string): boolean {
    return line.includes(TIDDL_PROGRESS_PREFIX)
        || line.includes('"bytesDownloaded"')
        || line.includes('"bytesTotal"');
}

/**
 * Rich traceback box borders / headers — never store these as errorDetail.
 * Released capture used `errorDetail ||= line`, so "╭── Traceback ──╮" won forever.
 */
export function looksLikeTiddlTraceChrome(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return true;
    return /^[╭╰│─┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬\s]+$/.test(trimmed)
        || /^╭.*(?:Traceback|─)/i.test(trimmed)
        || /^╰/.test(trimmed)
        || /^│\s*$/.test(trimmed)
        || /^Traceback \(most recent call last\):/.test(trimmed);
}

/** Strip an optional Rich left-border glyph so exception text still matches. */
function stripRichBorderPrefix(line: string): string {
    return line.replace(/^[│║]\s*/, "").trim();
}

/** Actionable Python / tiddl exception or Error: lines. */
export function looksLikeTiddlExceptionLine(line: string): boolean {
    const body = stripRichBorderPrefix(line);
    if (!body || looksLikeTiddlTraceChrome(body)) return false;
    return /(?:^|\s)Error:/.test(body)
        || /\bException:/.test(body)
        || /\bAPI Error\b/.test(body)
        || /^[A-Za-z_][\w.]*Error\b/.test(body)
        || /^[A-Za-z_][\w.]*Exception\b/.test(body);
}

const TIDDL_ERROR_DETAIL_MAX = 500;
const TIDDL_ERROR_FALLBACK_LINES = 8;
const TIDDL_CAPTURED_LINES_MAX = 200;

/**
 * Prefer the first real Error:/exception line; otherwise the last N useful
 * (non-chrome, non-progress) stderr/stdout lines joined with " | ".
 */
export function extractTiddlErrorDetail(
    lines: string[],
    options?: { maxLength?: number; lastUsefulLines?: number },
): string {
    const maxLength = options?.maxLength ?? TIDDL_ERROR_DETAIL_MAX;
    const lastUsefulLines = options?.lastUsefulLines ?? TIDDL_ERROR_FALLBACK_LINES;
    const cleaned = lines
        .map((line) => stripRichBorderPrefix(stripAnsi(line).trim()))
        .filter((line) => line && !looksLikeProgressFragment(line) && !looksLikeTiddlTraceChrome(line));

    const firstException = cleaned.find((line) => looksLikeTiddlExceptionLine(line));
    if (firstException) {
        return firstException.slice(0, maxLength);
    }

    return cleaned.slice(-lastUsefulLines).join(" | ").slice(0, maxLength);
}

function clampPercent(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return undefined;
    }
    return Math.max(0, Math.min(100, Math.round(value)));
}

function formatByteRate(bytesPerSecond: number): string {
    const units = ["B/s", "KB/s", "MB/s", "GB/s"];
    let value = bytesPerSecond;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export function tiddlProgressEventToDownloadProgress(
    event: TiddlProgressEvent,
    lastPercent: number,
): DownloadProgress | null {
    const title = typeof event.title === "string" && event.title.trim() ? event.title.trim() : undefined;
    if (!title) {
        return null;
    }

    const percent = clampPercent(event.percent);
    const bytesTotal = typeof event.bytesTotal === "number" && Number.isFinite(event.bytesTotal) && event.bytesTotal > 0
        ? Math.round(event.bytesTotal)
        : undefined;
    const bytesDownloaded = typeof event.bytesDownloaded === "number" && Number.isFinite(event.bytesDownloaded) && event.bytesDownloaded >= 0
        ? Math.round(event.bytesDownloaded)
        : undefined;
    const bytesLeft = bytesTotal !== undefined && bytesDownloaded !== undefined
        ? Math.max(0, bytesTotal - bytesDownloaded)
        : undefined;
    const speed = typeof event.bytesPerSecond === "number" && Number.isFinite(event.bytesPerSecond) && event.bytesPerSecond >= 0
        ? formatByteRate(event.bytesPerSecond)
        : undefined;
    const eventStatus = event.trackStatus === "skipped" || event.trackStatus === "completed" || event.trackStatus === "error"
        ? event.trackStatus
        : undefined;
    const trackStatus = eventStatus ?? (event.event === "track_done" ? "completed" : "downloading");
    const providerTrackId = event.providerTrackId == null ? undefined : String(event.providerTrackId).trim() || undefined;
    const currentTrackNum = typeof event.trackNumber === "number" && Number.isFinite(event.trackNumber)
        ? Math.round(event.trackNumber)
        : undefined;
    const currentVolumeNum = typeof event.volumeNumber === "number" && Number.isFinite(event.volumeNumber)
        ? Math.round(event.volumeNumber)
        : undefined;

    return {
        progress: lastPercent,
        currentTrack: title,
        currentProviderTrackId: providerTrackId,
        currentTrackNum,
        currentVolumeNum,
        trackProgress: event.event === "track_start" ? undefined : percent,
        trackStatus,
        statusMessage: event.event === "track_done"
            ? `${trackStatus === "skipped" ? "Skipped" : "Downloaded"} ${title}`
            : `Downloading ${title}`,
        state: "downloading",
        speed,
        size: bytesTotal,
        sizeleft: bytesLeft,
    };
}

export class TiddlBackend implements DownloadBackend {
    readonly id = "tiddl";
    readonly supportedProviders = ["tidal"];
    readonly capabilities: Array<"stereo" | "spatial" | "video"> = ["stereo", "spatial", "video"];

    async download(
        request: DownloadRequest,
        options: { signal?: AbortSignal; onProgress: (progress: DownloadProgress) => void }
    ): Promise<void> {
        // Slot selections can combine multiple provider releases ("id1;id2") when
        // no single release covers the target tracklist. Download them in order
        // into the same workspace; the import step matches files per track.
        const providerIds = String(request.providerId || "")
            .split(";")
            .map((id) => id.trim())
            .filter(Boolean);
        if (providerIds.length === 0) {
            throw new Error("tiddl download requested without a provider ID");
        }

        syncTiddlSettings();

        for (let index = 0; index < providerIds.length; index++) {
            if (options.signal?.aborted) {
                throw new Error("Download aborted");
            }
            await this.downloadOne(providerIds[index], request, options, {
                completed: index,
                total: providerIds.length,
            });
        }
    }

    private downloadOne(
        providerId: string,
        request: DownloadRequest,
        options: { signal?: AbortSignal; onProgress: (progress: DownloadProgress) => void },
        span: { completed: number; total: number },
    ): Promise<void> {
        const url = `https://tidal.com/browse/${request.entityType}/${providerId}`;
        // Per-job CLI args (these override the global config.toml). Scan path is
        // pinned to this job's own workspace so skip_existing only matches files
        // from THIS job — never another concurrent job's downloads.
        const args: string[] = [
            "download",
            "--path", request.downloadPath,
            "--scan-path", request.downloadPath,
        ];

        if (request.entityType === "video") {
            // Per-job video quality (Apple-parity). Config.toml is the default,
            // but -vq makes the Discogenius setting authoritative for this job.
            // Pass the app setting only — never catalog tags like MP4_480P.
            args.push("--videos", "only", "-vq", mapVideoQualityToTiddl());
        } else {
            const isSpatial = isSpatialAudioQuality(request.quality);
            args.push("-q", capTiddlTrackQuality(mapAudioQualityToTiddl(request.quality), isSpatial));
            // Spatial and stereo are independent media classes. A stereo job
            // requests the provider's separate stereo stream; it must never
            // accept an Atmos file as ordinary stereo completion.
            args.push("--dolby-atmos", isSpatial ? "only" : "none");
            // Audio jobs never pull music videos bundled with the album/artist.
            args.push("--videos", "none");
        }

        args.push("url", url);

        const wrapperScript = getTiddlProgressWrapperScript();
        const command = wrapperScript ? getTiddlPythonBinary() : getTiddlBinary();
        const commandArgs = wrapperScript ? [wrapperScript, ...args] : args;
        const cp = spawn(command, commandArgs, { 
            env: buildTiddlEnv(),
            shell: process.platform === "win32"
        });

        if (options.signal) {
            if (options.signal.aborted) {
                cp.kill();
            } else {
                options.signal.addEventListener("abort", () => {
                    cp.kill();
                });
            }
        }

        const toOverallPercent = (subFraction: number): number => {
            const bounded = Math.min(1, Math.max(0, subFraction));
            return Math.round(((span.completed + bounded) / span.total) * 100);
        };

        return new Promise<void>((resolve, reject) => {
            let lastPercent = toOverallPercent(0);
            let hasProcessingError = false;
            let stdoutBuffer = "";
            let stderrBuffer = "";
            // Non-chrome lines kept for failure summarization — never store
            // Rich box chrome as errorDetail (that used to hide the real exception).
            const capturedLines: string[] = [];
            // Item counts from wrapper queue_total/queue_progress events drive
            // the album-level percent, mirroring how imports report progress.
            // tiddl's own "Total Progress" panel is a Rich Live table that
            // never prints to a piped stdout.
            let queueTotal = 0;
            let queueCompleted = 0;

            const rememberLine = (cleanLine: string) => {
                if (
                    !cleanLine
                    || looksLikeProgressFragment(cleanLine)
                    || looksLikeTiddlTraceChrome(cleanLine)
                ) {
                    return;
                }
                capturedLines.push(cleanLine);
                if (capturedLines.length > TIDDL_CAPTURED_LINES_MAX) {
                    capturedLines.splice(0, capturedLines.length - TIDDL_CAPTURED_LINES_MAX);
                }
            };

            const handleLine = (line: string, _source: "stdout" | "stderr") => {
                const cleanLine = stripAnsi(line).trim();
                if (!cleanLine) return;

                const progressEvent = parseTiddlProgressEvent(cleanLine);
                if (progressEvent) {
                    if (progressEvent.event === "queue_total" || progressEvent.event === "queue_progress") {
                        if (typeof progressEvent.total === "number" && progressEvent.total > 0) {
                            queueTotal = Math.round(progressEvent.total);
                        }
                        if (typeof progressEvent.completed === "number" && progressEvent.completed >= 0) {
                            queueCompleted = Math.round(progressEvent.completed);
                        }
                        if (queueTotal > 0) {
                            lastPercent = toOverallPercent(Math.min(queueCompleted, queueTotal) / queueTotal);
                            options.onProgress({
                                progress: lastPercent,
                                currentFileNum: Math.min(queueCompleted + 1, queueTotal),
                                totalFiles: queueTotal,
                                state: "downloading",
                            });
                        }
                        return;
                    }

                    const progress = tiddlProgressEventToDownloadProgress(progressEvent, lastPercent);
                    if (progress) {
                        options.onProgress(progress);
                    }
                    return;
                }

                if (looksLikeProgressFragment(cleanLine)) {
                    return;
                }

                rememberLine(cleanLine);

                // "not a MP4 file" is a tiddl-handled fallback; "no longer
                // available" tracks are skipped rather than fatal.
                if (
                    looksLikeTiddlExceptionLine(cleanLine)
                    && !cleanLine.includes("not a MP4 file")
                    && !cleanLine.includes("no longer available")
                ) {
                    hasProcessingError = true;
                }

                if (cleanLine.includes("Total Progress")) {
                    const match = cleanLine.match(/(\d+)\/(\d+)/);
                    if (match) {
                        const current = parseInt(match[1], 10);
                        const total = parseInt(match[2], 10);
                        lastPercent = toOverallPercent(total > 0 ? current / total : 0);
                        options.onProgress({
                            progress: lastPercent,
                            currentFileNum: current,
                            totalFiles: total,
                            state: "downloading",
                            statusMessage: cleanLine,
                        });
                    }
                } else if (cleanLine.includes("Exists") || cleanLine.includes("Downloaded") || cleanLine.includes("Total downloads")) {
                    options.onProgress({
                        progress: lastPercent,
                        statusMessage: cleanLine,
                        state: "downloading",
                    });
                }
            };

            const consumeLines = (chunk: Buffer, source: "stdout" | "stderr") => {
                const raw = (source === "stdout" ? stdoutBuffer : stderrBuffer) + chunk.toString();
                const lines = raw.split(/\r?\n|\r/g);
                const remainder = lines.pop() ?? "";
                if (source === "stdout") {
                    stdoutBuffer = remainder;
                } else {
                    stderrBuffer = remainder;
                }

                for (const line of lines) {
                    handleLine(line, source);
                }
            };

            cp.stdout?.on("data", (data: Buffer) => {
                consumeLines(data, "stdout");
            });

            cp.stderr?.on("data", (data: Buffer) => {
                consumeLines(data, "stderr");
            });

            cp.on("close", (code: number | null) => {
                if (stdoutBuffer) {
                    handleLine(stdoutBuffer, "stdout");
                }
                if (stderrBuffer) {
                    handleLine(stderrBuffer, "stderr");
                }

                if (code === 0 && !hasProcessingError) {
                    options.onProgress({
                        progress: toOverallPercent(1),
                        state: "downloading",
                        statusMessage: `Finished ${request.entityType} ${providerId}`,
                    });
                    resolve();
                } else {
                    const errorDetail = extractTiddlErrorDetail(capturedLines);
                    reject(new Error(
                        `tiddl exited with code ${code}${errorDetail ? `: ${errorDetail}` : ""}`,
                    ));
                }
            });

            cp.on("error", (err: Error) => {
                reject(err);
            });
        });
    }
}
