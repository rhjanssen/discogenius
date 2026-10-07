import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, withSqliteWriteGate } from "../../database.js";
import { Config } from "../config/config.js";
import { scanConfigRevision } from "../commands/scan-config-revision.js";
import type { RescanFoldersCommand, RootInventoryCheckpoint, ScanWorkCheckpoint } from "../commands/command-bodies.js";
import { SUPPORTED_IMPORT_EXTENSIONS } from "./import-discovery.js";
import { isMediaRewriteTemporaryName } from "./media-file-rewrite.js";

type RootIdentity = { dev: string; ino: string };
type Intent = { id: string; inventory_command_id: number; source_path: string; staged_path: string;
    root_path: string; root_identity: string; source_identity: string; review_id: number | null;
    review_snapshot: string | null; phase: "prepared" | "committed" };

function rootIdentity(root: string): RootIdentity {
    const stat = fs.lstatSync(root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Cleanup root is unavailable or linked");
    return { dev: String(stat.dev), ino: String(stat.ino) };
}
function fileIdentity(file: string, root: string): string {
    const relative = path.relative(root, file);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Cleanup path escaped its library root");
    }
    let directory = path.dirname(file);
    while (true) {
        rootIdentity(directory);
        if (path.relative(root, directory) === "") break;
        const parent = path.dirname(directory);
        if (parent === directory) throw new Error("Cleanup ancestor escaped its library root");
        directory = parent;
    }
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Cleanup requires a regular file");
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs].join(":");
}
function owned(file: string): boolean {
    return Boolean(db.prepare(`SELECT 1 FROM TrackFiles WHERE file_path=?
        UNION ALL SELECT 1 FROM MetadataFiles WHERE file_path=?
        UNION ALL SELECT 1 FROM LyricFiles WHERE file_path=?
        UNION ALL SELECT 1 FROM ExtraFiles WHERE file_path=? LIMIT 1`).get(file,file,file,file));
}
function review(file: string): Record<string, unknown> | undefined {
    return db.prepare("SELECT * FROM UnmappedFiles WHERE file_path=?").get(file) as Record<string, unknown> | undefined;
}

/** Operational intents survive history removal. They do not manufacture a
 * managed-file claim for junk. A future cleanup planner must settle applicable
 * sidecar ownership before asking this journal to remove remaining paths. */
export class LibraryCleanupJournal {
    static hasPending(): boolean { return Boolean(db.prepare("SELECT 1 FROM LibraryCleanupJournal LIMIT 1").get()); }
    private static get(id: string): Intent {
        const intent = db.prepare("SELECT * FROM LibraryCleanupJournal WHERE id=?").get(id) as Intent | undefined;
        if (!intent) throw new Error("Cleanup intent is missing");
        return intent;
    }
    private static assertRoot(intent: Intent): void {
        if (JSON.stringify(rootIdentity(intent.root_path)) !== intent.root_identity) throw new Error("Cleanup root was replaced");
    }
    private static assertClaims(intent: Intent): void {
        const reviewed = review(intent.source_path);
        if (owned(intent.source_path) || (intent.review_id === null ? Boolean(reviewed)
            : !reviewed || reviewed.id !== intent.review_id || JSON.stringify(reviewed) !== intent.review_snapshot)) {
            throw new Error("Cleanup ownership changed; preserving the file");
        }
    }
    private static inventoryWitness(inventoryCommandId: number, root: string): string {
        const command = db.prepare("SELECT name,status,payload FROM commands WHERE id=?").get(inventoryCommandId) as
            {name:string;status:string;payload:string} | undefined;
        const body = command ? JSON.parse(command.payload) as RescanFoldersCommand &
            {rootInventory?:RootInventoryCheckpoint;scanWork?:ScanWorkCheckpoint} : undefined;
        const inventory = body?.rootInventory, work = body?.scanWork;
        const roots = [{key:"music",path:path.resolve(Config.getMusicPath())},
            {key:"spatial",path:path.resolve(Config.getSpatialPath())},{key:"videos",path:path.resolve(Config.getVideoPath())}];
        const index = roots.findIndex(entry => entry.path === root);
        if (!command || command.name !== "RescanFolders" || command.status !== "completed" || body?.artistId
            || body?.artistIds?.length || !work?.cleanupDone || work.cursor !== work.artistIds.length
            || work.configRevision !== scanConfigRevision() || (body?.addNewArtists && !work.discovery)
            || !inventory?.complete || inventory.pending.length || inventory.current || inventory.missingRoots.length
            || JSON.stringify(inventory.roots) !== JSON.stringify(roots) || index < 0
            || !inventory.rootIdentities || inventory.rootIdentities.length !== roots.length
            || inventory.rootIdentities.some(witness => !witness)) throw new Error("Cleanup requires a complete current library inventory");
        roots.forEach((entry,i) => {
            if (JSON.stringify(rootIdentity(entry.path)) !== JSON.stringify(inventory.rootIdentities![i])) {
                throw new Error("Cleanup root was replaced after inventory");
            }
        });
        return JSON.stringify(rootIdentity(root));
    }
    static async prepare(options: { inventoryCommandId: number; filePath: string; rootPath: string; discardReviewId?: number }): Promise<string> {
        const source = path.resolve(options.filePath), root = path.resolve(options.rootPath);
        const reserved = new Set([".zfs",".git",".vs",".appledouble","$recycle.bin","system volume information","@eadir"]);
        if (isMediaRewriteTemporaryName(path.basename(source)) || path.relative(root,source).split(path.sep)
            .slice(0,-1).some(part=>reserved.has(part.toLowerCase()))) throw new Error("Cleanup cannot remove reserved or active rewrite paths");
        const rootWitness = this.inventoryWitness(options.inventoryCommandId,root);
        const reviewed = review(source);
        if (options.discardReviewId !== undefined && (!Number.isSafeInteger(options.discardReviewId) || options.discardReviewId < 1
            || reviewed?.id !== options.discardReviewId)) throw new Error("Explicit review disposition does not match the file");
        if (options.discardReviewId === undefined && SUPPORTED_IMPORT_EXTENSIONS.has(path.extname(source).toLowerCase())) {
            throw new Error("Applicable media must be identified or registered for review before cleanup");
        }
        const id = randomUUID();
        const intent: Intent = {id,inventory_command_id:options.inventoryCommandId,source_path:source,
            staged_path:path.join(path.dirname(source),`.discogenius-cleanup-${id}${path.extname(source)}`),root_path:root,
            root_identity:rootWitness,source_identity:fileIdentity(source,root),
            review_id:options.discardReviewId ?? null,review_snapshot:options.discardReviewId ? JSON.stringify(reviewed) : null,phase:"prepared"};
        await withSqliteWriteGate(() => {
            this.assertRoot(intent); this.assertClaims(intent);
            this.inventoryWitness(intent.inventory_command_id,root);
            if (this.hasPending() || db.prepare("SELECT 1 FROM FileMutationJournal LIMIT 1").get()) throw new Error("Recover pending file mutations before cleanup");
            if (fileIdentity(source,root) !== intent.source_identity) throw new Error("Cleanup file changed before intent");
            db.prepare(`INSERT INTO LibraryCleanupJournal
                (id,inventory_command_id,source_path,staged_path,root_path,root_identity,source_identity,review_id,review_snapshot)
                VALUES (?,?,?,?,?,?,?,?,?)`).run(id,intent.inventory_command_id,source,intent.staged_path,root,
                    intent.root_identity,intent.source_identity,intent.review_id,intent.review_snapshot);
        },"cleanup:intent");
        return id;
    }
    static stage(id: string): string {
        const intent = this.get(id); this.assertRoot(intent); this.assertClaims(intent);
        this.inventoryWitness(intent.inventory_command_id,intent.root_path);
        if (intent.phase !== "prepared" || fileIdentity(intent.source_path,intent.root_path) !== intent.source_identity
            || fs.existsSync(intent.staged_path)) throw new Error("Cleanup file changed before staging");
        // Same directory/device; publish without ever replacing an external file.
        fs.linkSync(intent.source_path,intent.staged_path);
        fs.unlinkSync(intent.source_path);
        return intent.staged_path;
    }
    static async commit(id: string): Promise<void> {
        await withSqliteWriteGate(() => db.transaction(() => {
            const intent=this.get(id); this.assertRoot(intent); this.assertClaims(intent);
            this.inventoryWitness(intent.inventory_command_id,intent.root_path);
            if (intent.phase !== "prepared" || fs.existsSync(intent.source_path)
                || fileIdentity(intent.staged_path,intent.root_path) !== intent.source_identity) throw new Error("Cleanup staged file changed before commit");
            if (intent.review_id !== null) db.prepare("DELETE FROM UnmappedFiles WHERE id=? AND file_path=?").run(intent.review_id,intent.source_path);
            db.prepare("UPDATE LibraryCleanupJournal SET phase='committed' WHERE id=?").run(id);
        })(),"cleanup:commit");
    }
    static async recoverOne(id: string): Promise<void> {
        try {
            const intent=this.get(id); this.assertRoot(intent);
            const sourceExists=fs.existsSync(intent.source_path), stagedExists=fs.existsSync(intent.staged_path);
            if (stagedExists && fileIdentity(intent.staged_path,intent.root_path) !== intent.source_identity) throw new Error("Cleanup staged bytes changed");
            if (intent.phase === "prepared") {
                if (sourceExists && fileIdentity(intent.source_path,intent.root_path) !== intent.source_identity) throw new Error("Cleanup source was replaced; cannot restore");
                if (!sourceExists && !stagedExists) throw new Error("Both cleanup paths are missing");
                if (stagedExists) {
                    if (!sourceExists) fs.linkSync(intent.staged_path,intent.source_path);
                    fs.unlinkSync(intent.staged_path);
                }
            } else if (stagedExists) fs.unlinkSync(intent.staged_path);
            await withSqliteWriteGate(() => db.prepare("DELETE FROM LibraryCleanupJournal WHERE id=?").run(id),"cleanup:settled");
        } catch (error) {
            try {
                await withSqliteWriteGate(() => db.prepare("UPDATE LibraryCleanupJournal SET recovery_error=? WHERE id=?")
                    .run(error instanceof Error ? error.message : String(error),id),"cleanup:recovery-error");
            } catch {
                // Keep the original failure; the unsettled intent still blocks disk jobs.
            }
            throw error;
        }
    }
    static async recoverPending(): Promise<string[]> {
        const errors:string[]=[];
        for (const {id} of db.prepare("SELECT id FROM LibraryCleanupJournal ORDER BY created_at,id").all() as Array<{id:string}>) {
            try { await this.recoverOne(id); } catch(error) { errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`); }
        }
        return errors;
    }
}
