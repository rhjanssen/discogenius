import fs from "fs";
import path from "path";

const caseSensitivityCache = new Map<string, boolean>();
const caseSensitivityOverrides = new Map<string, boolean>();

export function setCaseSensitivityOverride(folderPath: string, isInsensitive: boolean | null): void {
    const resolved = path.resolve(folderPath);
    if (isInsensitive === null) {
        caseSensitivityOverrides.delete(resolved);
    } else {
        caseSensitivityOverrides.set(resolved, isInsensitive);
    }
}

export function clearCaseSensitivityCache(): void {
    caseSensitivityCache.clear();
    caseSensitivityOverrides.clear();
}

function swapAsciiCase(str: string): string {
    let result = "";
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code >= 65 && code <= 90) {
            result += str[i].toLowerCase();
        } else if (code >= 97 && code <= 122) {
            result += str[i].toUpperCase();
        } else {
            result += str[i];
        }
    }
    return result;
}

export function isCaseInsensitivePath(targetPath: string | null | undefined): boolean {
    if (!targetPath) return process.platform === "win32" || process.platform === "darwin";

    const resolved = path.resolve(String(targetPath));

    for (const [overridePath, isInsensitive] of caseSensitivityOverrides) {
        if (resolved === overridePath || resolved.startsWith(`${overridePath}${path.sep}`) || resolved.startsWith(`${overridePath}/`)) {
            return isInsensitive;
        }
    }

    if (process.platform === "win32") {
        return true;
    }

    // Find nearest existing directory
    let current = resolved;
    while (current && !fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }

    if (!current || !fs.existsSync(current)) {
        return process.platform === "darwin";
    }

    try {
        const stat = fs.statSync(current);
        const dir = stat.isDirectory() ? current : path.dirname(current);

        if (caseSensitivityCache.has(dir)) {
            return caseSensitivityCache.get(dir)!;
        }

        let isInsensitive = false;
        const entries = fs.readdirSync(dir);
        const entryWithLetter = entries.find((e) => /[a-zA-Z]/.test(e));
        if (entryWithLetter) {
            const swapped = swapAsciiCase(entryWithLetter);
            if (entries.includes(swapped)) {
                isInsensitive = false;
            } else {
                isInsensitive = fs.existsSync(path.join(dir, swapped));
            }
        } else {
            const probeName = `.case_probe_${process.pid}_${Date.now()}`;
            const probeSwapped = `.CASE_PROBE_${process.pid}_${Date.now()}`;
            const probePath = path.join(dir, probeName);
            try {
                fs.mkdirSync(probePath);
                try {
                    isInsensitive = fs.existsSync(path.join(dir, probeSwapped));
                } finally {
                    try { fs.rmdirSync(probePath); } catch { /* ignore cleanup error */ }
                }
            } catch {
                isInsensitive = process.platform === "darwin";
            }
        }

        caseSensitivityCache.set(dir, isInsensitive);
        return isInsensitive;
    } catch {
        return process.platform === "darwin";
    }
}

/** Case-insensitive mounts report the destination as occupied when it is this
 * same file. A direct rename cannot change only the case, so callers hop
 * through a temporary name. Different files are never accepted here. */
export function pathsDifferOnlyByCase(left: string, right: string): boolean {
    const source = path.resolve(left).split(path.sep);
    const expected = path.resolve(right).split(path.sep);
    if (source.length !== expected.length || source.length === 0) return false;
    let differs = false;
    for (let index = 0; index < source.length; index++) {
        if (source[index] === expected[index]) continue;
        if (source[index].toLowerCase() !== expected[index].toLowerCase()) return false;
        differs = true;
    }
    return differs;
}

export function sameDirectoryEntry(left: string, right: string): boolean {
    try {
        const source = fs.lstatSync(left);
        const expected = fs.lstatSync(right);
        return source.dev === expected.dev && source.ino === expected.ino;
    } catch {
        return false;
    }
}

export function renameToCanonicalCase(source: string, expected: string): void {
    if (!pathsDifferOnlyByCase(source, expected) || !sameDirectoryEntry(source, expected)) {
        throw new Error("Case rename requires the same file under a different case");
    }
    const fromParts = path.resolve(source).split(path.sep);
    const toParts = path.resolve(expected).split(path.sep);
    const current = fromParts.slice();
    for (let index = 1; index < current.length; index++) {
        if (current[index] === toParts[index]) continue;
        const parent = current.slice(0, index).join(path.sep) || path.sep;
        try {
            const diskEntries = fs.readdirSync(parent);
            if (diskEntries.includes(toParts[index])) {
                current[index] = toParts[index];
                continue;
            }
        } catch {
            // Proceed with rename if readdir fails
        }
        const from = current.slice(0, index + 1).join(path.sep);
        const temporary = path.join(parent, `.discogenius-case-${process.pid}-${index}`);
        if (fs.existsSync(temporary)) throw new Error(`Case rename temporary path is occupied: ${temporary}`);
        fs.renameSync(from, temporary);
        try {
            fs.renameSync(temporary, path.join(parent, toParts[index]));
        } catch (error) {
            try { fs.renameSync(temporary, from); } catch { /* the original error is the one to surface */ }
            throw error;
        }
        current[index] = toParts[index];
    }
}

export function normalizeComparablePath(inputPath: string | null | undefined, caseInsensitive?: boolean): string {
    const normalized = String(inputPath || "")
        .replace(/[\\/]+/g, "/")
        .replace(/\/+$/, "");
    const insensitive = caseInsensitive ?? (process.platform === "win32");
    return insensitive ? normalized.toLowerCase() : normalized;
}

export function normalizeResolvedPath(inputPath: string | null | undefined, caseInsensitive?: boolean): string {
    const resolved = path.resolve(String(inputPath || ""));
    const insensitive = caseInsensitive ?? (process.platform === "win32" || isCaseInsensitivePath(resolved));
    return insensitive ? resolved.toLowerCase() : resolved;
}

/**
 * True when a candidate path is the root itself or one of its descendants.
 *
 * `startsWith(root)` is not sufficient (`/music-other` is not inside `/music`),
 * and comparing unresolved paths permits `..` to escape. Keep this helper at
 * the persistence boundary so every TrackFiles/sidecar writer applies the same
 * platform-aware containment rule.
 */
export function resolvedPathIsInsideRoot(
    candidatePath: string | null | undefined,
    rootPath: string | null | undefined,
): boolean {
    if (!String(candidatePath || "").trim() || !String(rootPath || "").trim()) {
        return false;
    }

    const candidate = normalizeResolvedPath(candidatePath);
    const root = normalizeResolvedPath(rootPath);
    const relative = path.relative(root, candidate);
    return relative === "" || (
        relative !== ".."
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative)
    );
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

/**
 * `{TIDAL-25701976}` / `{apple-music-xyz}` tokens Discogenius writes into
 * library filenames. The token is a (provider, provider_id) pair, so scan can
 * resolve it without guessing from a bare numeric id.
 */
export function parseProviderFilenameToken(stem: string): { provider: string; providerId: string } | null {
    const match = String(stem || "").match(/\{([A-Za-z][A-Za-z0-9-]*)-([^}]+)\}/);
    if (!match) return null;
    return { provider: match[1].toLowerCase(), providerId: match[2] };
}
