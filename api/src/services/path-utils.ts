import path from "path";

export function normalizeComparablePath(inputPath: string | null | undefined): string {
    const normalized = String(inputPath || "")
        .replace(/[\\/]+/g, "/")
        .replace(/\/+$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function normalizeResolvedPath(inputPath: string | null | undefined): string {
    const resolved = path.resolve(String(inputPath || ""));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}