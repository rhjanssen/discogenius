import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import * as mm from "music-metadata";
import { db, withSqliteWriteGate } from "../../database.js";
import { Config } from "../config/config.js";
import { SUPPORTED_IMPORT_EXTENSIONS } from "../mediafiles/import-discovery.js";
import { isMediaRewriteTemporaryName } from "../mediafiles/media-file-rewrite.js";
import { persistRootReviewCandidates } from "../mediafiles/library-scan-root-review.js";
import { reconcileInventorySidecar } from "../mediafiles/inventory-sidecars.js";
import { recordCleanupCandidate } from "../mediafiles/library-cleanup-plan.js";
import { CommandQueueManager } from "./command-queue-manager.js";
import { CommandContinuation } from "./command-continuation.js";
import type { RootInventoryCheckpoint } from "./command-bodies.js";
import type { CommandModelOf } from "./command-model.js";
import type { CommandHandlerContext } from "./handlers/handler-context.js";

const excludedDirectories = new Set([".zfs", ".git", ".vs", ".appledouble", "$recycle.bin", "system volume information", "@eadir"]);

function within(directory: string, root: string): boolean {
    const relative = path.relative(root, directory);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function directoryIdentity(directory: string): { dev: string; ino: string } {
    const stats = fs.lstatSync(directory, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`Inventory directory changed: ${directory}`);
    return { dev: String(stats.dev), ino: String(stats.ino) };
}

function assertDirectory(directory: string, root: string, expected?: { dev: string; ino: string },
    expectedRoot?: { dev: string; ino: string } | null) {
    // Check before reading, including empty directories. realpath alone allows
    // a replacement link to another directory inside the same library root.
    let ancestor = directory;
    const identity = directoryIdentity(directory);
    let rootIdentity = identity;
    while (path.relative(root, ancestor) !== "") {
        const parent = path.dirname(ancestor);
        if (parent === ancestor || !within(parent, root)) throw new Error(`Inventory directory escaped its library root: ${directory}`);
        rootIdentity = directoryIdentity(parent);
        ancestor = parent;
    }
    if (expectedRoot && (rootIdentity.dev !== expectedRoot.dev || rootIdentity.ino !== expectedRoot.ino)) {
        throw new Error(`Inventory directory replaced during scan: ${root}`);
    }
    if (!within(fs.realpathSync(directory), fs.realpathSync(root))) {
        throw new Error(`Inventory directory escaped its library root: ${directory}`);
    }
    if (expected && (identity.dev !== expected.dev || identity.ino !== expected.ino)) {
        throw new Error(`Inventory directory replaced during scan: ${directory}`);
    }
    return identity;
}

/** Complete filesystem coverage after artist reconciliation. Only previously
 * unowned media is parsed; unchanged library/review files need no native probe.
 * This is an inventory, never authorization to delete unsupported files. */
export async function runRootInventoryWorkUnit(job: CommandModelOf<"RescanFolders">,
    ctx: CommandHandlerContext): Promise<RootInventoryCheckpoint> {
    const owner = job.worker_id;
    if (!owner) throw new Error("Root inventory execution ownership changed");
    const assertOwner = () => {
        if (!CommandQueueManager.isExecutionOwner(job.id, owner)) throw new Error("Root inventory execution ownership changed");
        if (CommandQueueManager.get(job.id)?.payload.cancelRequested) throw new Error("Root inventory cancellation requested");
    };
    assertOwner();
    const roots = [
        { key: "music" as const, path: Config.getMusicPath() },
        { key: "spatial" as const, path: Config.getSpatialPath() },
        { key: "videos" as const, path: Config.getVideoPath() },
    ].filter(root => Boolean(root.path)).map(root => ({ ...root, path: path.resolve(root.path) }));
    if (new Set(roots.map(root => root.path)).size !== roots.length) throw new Error("Library inventory roots must have distinct paths");
    let state = job.payload.rootInventory;
    const persist = async (resetCandidates=false) => withSqliteWriteGate(() => db.transaction(() => {
        assertOwner();
        if (resetCandidates) db.prepare("DELETE FROM LibraryCleanupCandidates WHERE inventory_command_id=?").run(job.id);
        if (!CommandQueueManager.updateState(job.id, { workerId: owner, payloadPatch: { rootInventory: state } })) {
            throw new Error("Root inventory execution ownership changed");
        }
    })(), "scan:root-inventory-checkpoint");
    if (!state) {
        const rootIdentities = roots.map(root => {
            try { return directoryIdentity(root.path); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
                throw error;
            }
        });
        state = { version: 1, cleanupPlanVersion: 1, roots, rootIdentities, pending: roots.map((_, root) => ({ root, directory: roots[root].path })),
            current: null, directories: 0, files: 0, reviewFiles: 0,
            missingRoots: roots.filter((_, index) => !rootIdentities[index]).map(root => root.path), complete: false };
        await persist(true);
    }
    if (state.version !== 1 || JSON.stringify(state.roots) !== JSON.stringify(roots)
        || !Array.isArray(state.pending) || !Array.isArray(state.missingRoots) || typeof state.complete !== "boolean"
        || (state.complete && (state.pending.length > 0 || state.current !== null))
        || [state.directories, state.files, state.reviewFiles, state.sidecarFiles ?? 0].some(n => !Number.isSafeInteger(n) || n < 0)) {
        throw new Error("Invalid or changed root inventory checkpoint");
    }
    const validateDirectory = (entry: { root: number; directory: string }) => {
        if (!Number.isSafeInteger(entry.root) || !roots[entry.root] || !within(entry.directory, roots[entry.root].path)) {
            throw new Error("Root inventory directory is outside its library root");
        }
    };
    state.pending.forEach(validateDirectory);
    if (state.current) {
        validateDirectory(state.current);
        if (!Array.isArray(state.current.files) || state.current.files.some(name => typeof name !== "string"
            || name === "." || name === ".." || path.basename(name) !== name)
            || !Number.isSafeInteger(state.current.cursor) || state.current.cursor < 0 || state.current.cursor > state.current.files.length) {
            throw new Error("Invalid root inventory file cursor");
        }
    }
    const assertRoot = (index: number) => {
        const identity = state.rootIdentities?.[index];
        if (identity) assertDirectory(roots[index].path, roots[index].path, identity);
    };
    if (state.rootIdentities) {
        if (state.rootIdentities.length !== roots.length) throw new Error("Invalid root inventory identities");
        roots.forEach((_, index) => assertRoot(index));
    }
    if (state.complete) return state;
    const owned = db.prepare(`SELECT 1 FROM TrackFiles WHERE file_path = ?
        UNION ALL SELECT 1 FROM MetadataFiles WHERE file_path = ?
        UNION ALL SELECT 1 FROM LyricFiles WHERE file_path = ?
        UNION ALL SELECT 1 FROM ExtraFiles WHERE file_path = ? LIMIT 1`);
    const reviewed = db.prepare("SELECT 1 FROM UnmappedFiles WHERE file_path = ?");
    const started = performance.now();
    let processed = 0;
    while (processed < 100 && performance.now() - started < 15_000) {
        assertOwner();
        if (!state.current) {
            const next = state.pending.pop();
            if (!next) { state.complete = true; break; }
            const root = roots[next.root];
            let identity: { dev: string; ino: string };
            try { identity = assertDirectory(next.directory, root.path, undefined, state.rootIdentities?.[next.root]); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                if (next.directory !== root.path) throw new Error(`Inventory directory disappeared during scan: ${next.directory}`, { cause: error });
                if (!state.missingRoots.includes(root.path)) state.missingRoots.push(root.path);
                processed++;
                continue;
            }
            const entries = fs.readdirSync(next.directory, { withFileTypes: true });
            assertDirectory(next.directory, root.path, identity, state.rootIdentities?.[next.root]);
            const files: string[] = [];
            for (const entry of entries) {
                if (entry.isDirectory() && !excludedDirectories.has(entry.name.toLowerCase())) {
                    const directory = path.join(next.directory, entry.name);
                    if (!roots.some(other => other.path === directory)) state.pending.push({ root: next.root, directory });
                } else if (entry.isFile()) files.push(entry.name);
            }
            state.current = { ...next, files, cursor: 0, identity };
            state.directories++;
            processed++;
        }
        const current = state.current;
        const root = roots[current.root];
        assertDirectory(current.directory, root.path, current.identity, state.rootIdentities?.[current.root]);
        if (current.cursor === current.files.length) { state.current = null; continue; }
        const name = current.files[current.cursor];
        const file = path.join(current.directory, name);
        const ext = path.extname(name).toLowerCase();
        if (SUPPORTED_IMPORT_EXTENSIONS.has(ext) && !isMediaRewriteTemporaryName(name)
            && !owned.get(file, file, file, file) && !reviewed.get(file)) {
            const before = fs.lstatSync(file);
            if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Inventory file changed: ${file}`);
            let metadata: mm.IAudioMetadata | undefined;
            try { metadata = await mm.parseFile(file, { skipCovers: true }); } catch { /* Invalid media remains reviewable. */ }
            const after = fs.lstatSync(file);
            if (!after.isFile() || after.isSymbolicLink() || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
                throw new Error(`Inventory file changed during inspection: ${file}`);
            }
            await persistRootReviewCandidates([{ group: {
                id: Buffer.from(current.directory).toString("base64"), path: current.directory, rootPath: root.path,
                libraryRoot: root.key, files: [{ path: file, name, size: after.size, extension: ext, metadata }],
                sidecars: [], commonTags: {}, status: "manual_required",
            }, matches: [] }]);
            if (reviewed.get(file)) state.reviewFiles++;
        } else if (!SUPPORTED_IMPORT_EXTENSIONS.has(ext) && !isMediaRewriteTemporaryName(name)
            && !reviewed.get(file)) {
            if (await reconcileInventorySidecar(file,root.path,current.files.map(sibling => path.join(current.directory,sibling)))) {
                state.sidecarFiles = (state.sidecarFiles ?? 0) + 1;
            }
        }
        if (state.cleanupPlanVersion === 1) {
            await recordCleanupCandidate(job.id,file,root.path,current.files.map(sibling => path.join(current.directory,sibling)),assertOwner);
        }
        state.files++;
        current.cursor++;
        processed++;
        await ctx.yieldToEventLoop();
    }
    await persist();
    ctx.updateCommandDescription(job, { progress: state.complete ? 95 : 90,
        description: `Checking library inventory - ${state.files} files checked, ${state.reviewFiles} added for review, ${state.sidecarFiles ?? 0} sidecars linked` });
    if (!state.complete) throw new CommandContinuation({});
    return state;
}
