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

/**
 * SQL that puts a stored path column into the same shape as
 * `normalizeComparablePath`.
 *
 * Path columns are written with the platform separator — `Artist\Album\x.flac`
 * on Windows — while every comparison value in the codebase is normalized to
 * forward slashes first. Comparing one against the other silently matches
 * nothing on Windows: a folder-level `cover.jpg` looked unowned, so a scoped
 * deletion released extras it did not own. Both sides must be normalized, and
 * this is the one place that says how.
 *
 * `LOWER()` mirrors the platform-dependent lowercasing in
 * `normalizeComparablePath`. Both it and SQLite's `LIKE` fold ASCII only, so a
 * caller that needs exactness still confirms the match in JS; this expression
 * exists to make the SQL prefix filter a correct superset rather than a filter
 * that quietly excludes everything.
 */
export function comparablePathColumnSql(column: string): string {
    const separatorNormalized = `REPLACE(${column}, '\\', '/')`;
    return process.platform === "win32"
        ? `LOWER(${separatorNormalized})`
        : separatorNormalized;
}