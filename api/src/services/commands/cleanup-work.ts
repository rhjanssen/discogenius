import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { db, withSqliteWriteGate } from "../../database.js";
import { previewLibraryCleanup, type CleanupCandidate } from "../mediafiles/library-cleanup-plan.js";
import { LibraryCleanupJournal } from "../mediafiles/library-cleanup-journal.js";
import { FileMutationJournal } from "../mediafiles/file-mutation-journal.js";
import { CommandQueueManager } from "./command-queue-manager.js";
import { CommandContinuation } from "./command-continuation.js";
import type { CommandModelOf } from "./command-model.js";
import type { CommandHandlerContext } from "./handlers/handler-context.js";

type DirectoryWitness={path:string;dev:string;ino:string};
type Stats=NonNullable<CommandModelOf<"CleanupLibrary">["payload"]["cleanupStats"]>;
function assertOwner(job:CommandModelOf<"CleanupLibrary">): void {
    if (!job.worker_id || !db.prepare("SELECT 1 FROM commands WHERE id=? AND status='started' AND worker_id=?")
        .get(job.id,job.worker_id)) throw new Error("Cleanup execution ownership changed");
    if (CommandQueueManager.get(job.id)?.payload.cancelRequested) throw new Error("Cleanup cancellation requested");
}
function directoryWitnesses(file:string,root:string): DirectoryWitness[] {
    const result:DirectoryWitness[]=[];
    for (let directory=path.dirname(file);path.relative(root,directory)!=="";directory=path.dirname(directory)) {
        const relative=path.relative(root,directory);
        if (relative===".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Cleanup directory escaped its root");
        const stat=fs.lstatSync(directory,{bigint:true});
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Cleanup directory is linked or unavailable");
        result.push({path:directory,dev:String(stat.dev),ino:String(stat.ino)});
    }
    return result;
}

export async function runCleanupWorkUnit(job:CommandModelOf<"CleanupLibrary">,ctx:CommandHandlerContext): Promise<void> {
    assertOwner(job);
    const inventoryId=job.payload.inventoryCommandId;
    if (!Number.isSafeInteger(inventoryId) || inventoryId<1 || (job.payload.pruneEmptyFolders!==undefined
        && typeof job.payload.pruneEmptyFolders!=="boolean")) throw new Error("Invalid cleanup request");
    previewLibraryCleanup(inventoryId,{limit:1});
    if (FileMutationJournal.hasPending()) throw new Error("Recover pending file mutations before continuing cleanup");
    let cursor=job.payload.cleanupCursor ?? "";
    let stats:Stats=job.payload.cleanupStats ?? {deleted:0,protected:0,refused:0,alreadyRemoved:0,pruned:0};
    const checkpoint=(nextCursor:string,nextStats:Stats)=>{
        assertOwner(job);
        if (!CommandQueueManager.updateState<"CleanupLibrary">(job.id,{workerId:job.worker_id!,payloadPatch:{cleanupCursor:nextCursor,cleanupStats:nextStats}})) {
            throw new Error("Cleanup checkpoint ownership changed");
        }
    };
    const preserve=async(candidate:CleanupCandidate,reason:string)=>{
        const protectedFile=["review_sidecar","now_owned_or_reviewed"].includes(reason),already=reason==="already_removed";
        const next={...stats,protected:stats.protected+(protectedFile ? 1 : 0),alreadyRemoved:stats.alreadyRemoved+(already ? 1 : 0),
            refused:stats.refused+(!protectedFile && !already ? 1 : 0)};
        await withSqliteWriteGate(()=>db.transaction(()=>{
            if (!already) db.prepare(`INSERT INTO LibraryCleanupResults(inventory_command_id,file_path,cleanup_command_id,status,reason)
                VALUES(?,?,?,?,?) ON CONFLICT(inventory_command_id,file_path) DO UPDATE SET
                cleanup_command_id=excluded.cleanup_command_id,status=excluded.status,reason=excluded.reason
                WHERE LibraryCleanupResults.status<>'deleted'`).run(inventoryId,candidate.file_path,job.id,protectedFile ? "protected" : "refused",reason);
            checkpoint(candidate.file_path,next);
        })(),"cleanup:preserved-outcome");
        cursor=candidate.file_path;stats=next;
    };
    const prune=async()=>{
        const pending=db.prepare(`SELECT file_path,directory_witnesses FROM LibraryCleanupResults
            WHERE cleanup_command_id=? AND prune_done=0 ORDER BY file_path LIMIT 25`).all(job.id) as Array<{file_path:string;directory_witnesses:string}>;
        for (const item of pending) {
            assertOwner(job);previewLibraryCleanup(inventoryId,{limit:1});
            const candidate=db.prepare("SELECT root_path FROM LibraryCleanupCandidates WHERE inventory_command_id=? AND file_path=?")
                .get(inventoryId,item.file_path) as {root_path:string};
            const witnesses=JSON.parse(item.directory_witnesses) as DirectoryWitness[];
            let removed=0,error:string|null=null;
            try {
                for (let index=0;index<witnesses.length;index++) {
                    const witness=witnesses[index];
                    assertOwner(job);LibraryCleanupJournal.inventoryWitness(inventoryId,candidate.root_path);
                    // Check the complete remaining ancestor chain, not just the
                    // final directory, before pruning through a replaced parent.
                    for (const ancestor of witnesses.slice(index)) {
                        let stat;
                        try {stat=fs.lstatSync(ancestor.path,{bigint:true});} catch(e) {if((e as NodeJS.ErrnoException).code==="ENOENT") continue;throw e;}
                        if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.dev)!==ancestor.dev || String(stat.ino)!==ancestor.ino) {
                            throw new Error(`Cleanup directory changed: ${ancestor.path}`);
                        }
                    }
                    try {fs.rmdirSync(witness.path);removed++;}
                    catch(e) {const code=(e as NodeJS.ErrnoException).code;if(code==="ENOENT")continue;if(code==="ENOTEMPTY" || code==="EEXIST")break;throw e;}
                }
            } catch(e) {error=e instanceof Error ? e.message : String(e);}
            const next={...stats,pruned:stats.pruned+removed,refused:stats.refused+(error ? 1 : 0)};
            await withSqliteWriteGate(()=>db.transaction(()=>{
                db.prepare("UPDATE LibraryCleanupResults SET prune_done=1,pruned=?,prune_error=? WHERE inventory_command_id=? AND file_path=?")
                    .run(removed,error,inventoryId,item.file_path);
                checkpoint(cursor,next);
            })(),"cleanup:prune-outcome");
            stats=next;await ctx.yieldToEventLoop();
        }
    };
    await prune();
    const started=performance.now();let processed=0;
    while (processed<25 && performance.now()-started<5000) {
        assertOwner(job);
        const preview=previewLibraryCleanup(inventoryId,{limit:1,afterPath:cursor}).entries[0];
        if (!preview) break;
        const candidate=db.prepare("SELECT * FROM LibraryCleanupCandidates WHERE inventory_command_id=? AND file_path=?")
            .get(inventoryId,preview.path) as CleanupCandidate;
        if (preview.eligible) {
            let intent:string|undefined,committed=false;
            try {
                const witnesses=job.payload.pruneEmptyFolders ? directoryWitnesses(candidate.file_path,candidate.root_path) : [];
                intent=await LibraryCleanupJournal.prepare({inventoryCommandId:inventoryId,filePath:candidate.file_path,
                    rootPath:candidate.root_path,expectedSourceIdentity:candidate.source_identity,assertOwner:()=>assertOwner(job)});
                assertOwner(job);LibraryCleanupJournal.stage(intent);
                const next={...stats,deleted:stats.deleted+1};
                await LibraryCleanupJournal.commit(intent,()=>{
                    db.prepare(`INSERT INTO LibraryCleanupResults(inventory_command_id,file_path,cleanup_command_id,status,reason,directory_witnesses,prune_done)
                        VALUES(?,?,?,'deleted','removed',?,?) ON CONFLICT(inventory_command_id,file_path) DO UPDATE SET
                        cleanup_command_id=excluded.cleanup_command_id,status='deleted',reason='removed',directory_witnesses=excluded.directory_witnesses,
                        prune_done=excluded.prune_done,pruned=0,prune_error=NULL
                        WHERE LibraryCleanupResults.status<>'deleted'`).run(inventoryId,candidate.file_path,job.id,JSON.stringify(witnesses),witnesses.length ? 0 : 1);
                    checkpoint(candidate.file_path,next);
                });
                committed=true;
                cursor=candidate.file_path;stats=next;
                await LibraryCleanupJournal.recoverOne(intent);
            } catch(error) {
                // Uncommitted operations restore the original; committed ones
                // retain their atomically recorded result and finish disposal.
                if (intent) await LibraryCleanupJournal.recoverOne(intent);
                if (committed) throw error;
                await preserve(candidate,error instanceof Error ? error.message : String(error));
            }
            await prune();
        } else {
            await preserve(candidate,preview.reason);
        }
        processed++;await ctx.yieldToEventLoop();
    }
    ctx.updateCommandDescription(job,{description:`${stats.deleted} files removed, ${stats.protected} preserved, ${stats.refused} need review; ${stats.pruned} empty folders removed`});
    if (previewLibraryCleanup(inventoryId,{limit:1,afterPath:cursor}).entries.length) throw new CommandContinuation({});
    if (stats.refused) throw new Error(`Cleanup preserved ${stats.refused} unresolved or changed paths; inspect the cleanup preview`);
}
