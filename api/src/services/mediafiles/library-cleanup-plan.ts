import path from "node:path";
import fs from "node:fs";
import { db, withSqliteWriteGate } from "../../database.js";
import { SUPPORTED_IMPORT_EXTENSIONS } from "./import-discovery.js";
import { isMediaRewriteTemporaryName } from "./media-file-rewrite.js";
import { inspectInventorySidecar } from "./inventory-sidecars.js";
import { cleanupFileIdentity, LibraryCleanupJournal } from "./library-cleanup-journal.js";
import type { RescanFoldersCommand } from "../commands/command-bodies.js";

type Reason = "unowned" | "unresolved_sidecar" | "review_sidecar";
export type CleanupCandidate = {file_path:string;root_path:string;source_identity:string;reason:Reason};
function protectedPath(file:string): boolean {
    return Boolean(db.prepare(`SELECT 1 FROM TrackFiles WHERE file_path=?
        UNION ALL SELECT 1 FROM MetadataFiles WHERE file_path=?
        UNION ALL SELECT 1 FROM LyricFiles WHERE file_path=?
        UNION ALL SELECT 1 FROM ExtraFiles WHERE file_path=?
        UNION ALL SELECT 1 FROM UnmappedFiles WHERE file_path=? LIMIT 1`).get(file,file,file,file,file));
}
function classify(file:string,root:string,siblings:string[]): Reason | undefined {
    if (protectedPath(file) || isMediaRewriteTemporaryName(path.basename(file))) return undefined;
    if (SUPPORTED_IMPORT_EXTENSIONS.has(path.extname(file).toLowerCase())) {
        throw new Error(`Applicable media was not registered during inventory: ${file}`);
    }
    const decision=inspectInventorySidecar(file,root,siblings);
    if (decision.status === "owned") return undefined;
    if (decision.status === "review_sidecar") return "review_sidecar";
    return decision.status === "not_sidecar" ? "unowned" : "unresolved_sidecar";
}

/** Collect during the already bounded root traversal. No additional disk walk
 * and no destructive action; a completed witnessed inventory is required below. */
export async function recordCleanupCandidate(inventoryId:number,file:string,root:string,siblings:string[],assertOwner:()=>void): Promise<void> {
    const reason=classify(file,root,siblings);
    if (!reason) return;
    const witness=cleanupFileIdentity(file,root);
    await withSqliteWriteGate(()=>{
        assertOwner();
        if (cleanupFileIdentity(file,root) !== witness || classify(file,root,siblings) !== reason) {
            throw new Error(`Cleanup candidate changed during inventory: ${file}`);
        }
        db.prepare(`INSERT INTO LibraryCleanupCandidates(inventory_command_id,file_path,root_path,source_identity,reason)
            VALUES(?,?,?,?,?) ON CONFLICT(inventory_command_id,file_path) DO UPDATE SET
            root_path=excluded.root_path,source_identity=excluded.source_identity,reason=excluded.reason`)
            .run(inventoryId,file,root,witness,reason);
    },"scan:cleanup-candidate");
}

export function previewLibraryCleanup(inventoryId:number,options:{limit?:number;afterPath?:string}={}) {
    const limit=options.limit ?? 50,afterPath=options.afterPath ?? "";
    if (!Number.isSafeInteger(inventoryId) || inventoryId<1 || !Number.isSafeInteger(limit) || limit<1 || limit>100
        || typeof afterPath !== "string" || afterPath.length>4096) throw new Error("Invalid cleanup preview selection");
    const job=db.prepare("SELECT payload FROM commands WHERE id=?").get(inventoryId) as {payload:string} | undefined;
    const body=job ? JSON.parse(job.payload) as RescanFoldersCommand : undefined;
    if (body?.rootInventory?.cleanupPlanVersion !== 1) throw new Error("Cleanup preview requires a fresh witnessed candidate inventory");
    for (const root of body.rootInventory.roots) LibraryCleanupJournal.inventoryWitness(inventoryId,root.path);
    const roots=new Set(body.rootInventory.roots.map(root=>root.path));
    const rows=db.prepare(`SELECT file_path,root_path,source_identity,reason FROM LibraryCleanupCandidates
        WHERE inventory_command_id=? AND file_path>? ORDER BY file_path LIMIT ?`).all(inventoryId,afterPath,limit+1) as CleanupCandidate[];
    const entries=rows.slice(0,limit).map(row=>{
        let reason:string=row.reason;
        const outcome=db.prepare("SELECT status,reason,prune_error FROM LibraryCleanupResults WHERE inventory_command_id=? AND file_path=?")
            .get(inventoryId,row.file_path) as {status:string;reason:string;prune_error:string|null} | undefined;
        if (!roots.has(row.root_path)) reason="outside_current_roots";
        else if (protectedPath(row.file_path)) reason="now_owned_or_reviewed";
        else if (outcome?.status === "deleted") reason=fs.existsSync(row.file_path) ? "file_changed" : "already_removed";
        else {
            try { if (cleanupFileIdentity(row.file_path,row.root_path)!==row.source_identity) reason="file_changed"; }
            catch { reason="file_unavailable"; }
        }
        return {path:row.file_path,rootPath:row.root_path,reason,eligible:reason === "unowned",
            ...(outcome ? {outcome:{status:outcome.status,reason:outcome.reason,pruneError:outcome.prune_error}} : {})};
    });
    return {inventoryCommandId:inventoryId,entries,nextCursor:rows.length>limit ? entries.at(-1)!.path : null};
}
