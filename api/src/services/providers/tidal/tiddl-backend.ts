import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { DownloadBackend, DownloadRequest, DownloadProgress } from "../../download/download-backend.js";
import { checkCommandAvailability, checkWritablePath, rollupHealthStatus, BackendCapabilitySnapshot } from "../../../utils/health.js";
import { Config, CONFIG_DIR } from "../../config/config.js";

export const TIDDL_CONFIG_DIR = path.join(CONFIG_DIR, ".tiddl");
export const TIDDL_AUTH_FILE = path.join(TIDDL_CONFIG_DIR, "auth.json");

function stripAnsi(text: string): string {
    return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

export function getTiddlCapabilitySnapshot(): BackendCapabilitySnapshot {
    const configDirCheck = checkWritablePath("tiddl.config", TIDDL_CONFIG_DIR, {
        kind: "dir",
        displayName: "tiddl config directory",
    });
    
    const binary = process.env.TIDDL_BIN || "tiddl";
    const commandCheck = checkCommandAvailability(
        "tiddl.command",
        binary,
        "tiddl",
    );
    
    const authExists = fs.existsSync(TIDDL_AUTH_FILE);
    const authCheck = authExists
        ? {
            scope: "tiddl.auth",
            status: "ok" as const,
            message: "tiddl authentication is present",
            details: { path: TIDDL_AUTH_FILE },
        }
        : {
            scope: "tiddl.auth",
            status: "warning" as const,
            message: "tiddl authentication is not present",
            details: { path: TIDDL_AUTH_FILE },
        };
        
    const checks = [configDirCheck, commandCheck, authCheck];
    const status = rollupHealthStatus(checks);
    const available = !checks.some((check) => check.status === "error");
    const ready = available && authExists;
    
    return {
        name: "tiddl",
        status,
        available,
        ready,
        capabilities: {
            audio: true,
            video: true,
            spatialAudio: true,
            highResAudio: true,
        },
        checks,
        notes: !authExists ? ["Authenticate with tiddl before downloading."] : [],
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
        const url = `https://tidal.com/browse/${request.entityType}/${request.providerId}`;
        const args: string[] = ["download"];
        
        args.push("--path", request.downloadPath);
        
        // Map quality to tiddl options (low, normal, high, max)
        if (request.entityType !== "video" && request.quality) {
            const mappedQuality = request.quality.toLowerCase();
            args.push("-q", mappedQuality);
        }
        
        // Enable dolby atmos if spatial capability or spatial quality is requested
        const isSpatial = request.quality?.toLowerCase().includes("atmos") || request.quality?.toLowerCase().includes("spatial");
        if (isSpatial) {
            args.push("--dolby-atmos", "only");
        }
        
        if (request.entityType === "video") {
            args.push("--videos", "only");
        }
        
        args.push("url", url);
        
        const binary = process.env.TIDDL_BIN || "tiddl";
        const cp = spawn(binary, args, {
            env: {
                ...process.env,
                FORCE_COLOR: "1",
                TERM: "xterm-256color",
            }
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
        
        return new Promise<void>((resolve, reject) => {
            let lastPercent = 0;
            let hasProcessingError = false;
            
            cp.stdout?.on("data", (data: any) => {
                const lines = data.toString().split(/\r?\n|\r/g);
                for (const line of lines) {
                    if (!line.trim()) continue;
                    
                    const cleanLine = stripAnsi(line).trim();
                    if (!cleanLine) continue;
                    
                    // Parse errors
                    if (cleanLine.includes("Error:") && !cleanLine.includes("not a MP4 file") && !cleanLine.includes("no longer available")) {
                        hasProcessingError = true;
                    }
                    
                    if (cleanLine.includes("Total Progress")) {
                        const match = cleanLine.match(/(\d+)\/(\d+)/);
                        if (match) {
                            const current = parseInt(match[1], 10);
                            const total = parseInt(match[2], 10);
                            lastPercent = Math.round((current / total) * 100);
                            options.onProgress({
                                progress: lastPercent,
                                currentFileNum: current,
                                totalFiles: total,
                                state: 'downloading',
                                statusMessage: cleanLine,
                            });
                        }
                    } else if (cleanLine.includes("Exists") || cleanLine.includes("Downloaded") || cleanLine.includes("Total downloads")) {
                        options.onProgress({
                            progress: lastPercent,
                            statusMessage: cleanLine,
                            state: 'downloading',
                        });
                    }
                }
            });
            
            cp.stderr?.on("data", (data: any) => {
                const str = data.toString();
                if (str.includes("Error:") || str.includes("Exception:")) {
                    hasProcessingError = true;
                }
            });
            
            cp.on("close", (code: any) => {
                if (code === 0 && !hasProcessingError) {
                    resolve();
                } else {
                    reject(new Error(`tiddl process exited with code ${code}`));
                }
            });
            
            cp.on("error", (err: any) => {
                reject(err);
            });
        });
    }
}
