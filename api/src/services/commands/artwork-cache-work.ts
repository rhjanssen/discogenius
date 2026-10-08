import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { db } from "../../database.js";
import { getMediaCoverFolder } from "../metadata/media-cover-service.js";
import { artworkDirectoryIdentity, nextArtworkOrigins, retireLegacyArtworkOrigin, recoverPreparedArtworkRetirements } from "../metadata/media-cover-cache-retirement.js";
import { ensureArtworkFolderInventory, nextInventoriedArtworkFolders, validateArtworkFolderInventory } from "./artwork-cache-inventory.js";
import type { CommandModelOf } from "./command-model.js";
import { CommandContinuation } from "./command-continuation.js";
import { CommandQueueManager } from "./command-queue-manager.js";
import type { SchedulerMaintenanceHandlerContext } from "./scheduler-maintenance-handlers.js";

export async function runArtworkCacheWork(job: CommandModelOf<"ConfigPrune">, ctx: SchedulerMaintenanceHandlerContext): Promise<void> {
  const root = path.dirname(getMediaCoverFolder("__root_probe__","Artist"));
  if (!fs.existsSync(root)) {
    if (job.payload.artworkCacheWork || db.prepare("SELECT 1 FROM ArtworkCacheRetirement WHERE phase='prepared' LIMIT 1").get()) {
      throw new Error("Artwork cache disappeared during cleanup; recovery evidence was preserved");
    }
    ctx.updateCommandDescription({progress:100,description:"Artwork cache is empty"});return;
  }
  const state = {...(job.payload.artworkCacheWork ?? {version:1 as const,root,rootIdentity:artworkDirectoryIdentity(root),family:0,after:""})};
  if (state.version!==1 || state.root!==root || state.rootIdentity!==artworkDirectoryIdentity(root)
    || !Number.isInteger(state.family) || state.family<0 || state.family>4 || typeof state.after!=="string") throw new Error("Artwork cache checkpoint changed; start a fresh cleanup");
  const started = performance.now();
  if (await recoverPreparedArtworkRetirements(root,async()=>{
    if (performance.now()-started>=25_000) throw new CommandContinuation({artworkCacheWork:state});
    if (CommandQueueManager.get(job.id)?.payload.cancelRequested) throw new Error("Artwork cleanup cancelled during recovery");
    ctx.updateCommandDescription({description:"Recovering interrupted artwork cache cleanup"});
    await ctx.yieldToEventLoop?.();
  })) throw new CommandContinuation({artworkCacheWork:state});
  const families = ["Album","Edition","Video","Artist"] as const;
  const directories = ["Albums","AlbumEditions","Videos",""];
  let settled = 0;
  let folders: string[] = [];
  while (state.family<4 && settled<25 && performance.now()-started<25_000) {
    if (CommandQueueManager.get(job.id)?.payload.cancelRequested) throw new Error("Artwork cleanup cancelled at a safe boundary");
    const directory = path.join(root,directories[state.family]);
    try {artworkDirectoryIdentity(directory);} catch (error) {
      if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;
      state.family++;state.after="";delete state.current;folders=[];continue;
    }
    await ensureArtworkFolderInventory({commandId:job.id,family:state.family,directory,
      excluded:state.family===3 ? directories.slice(0,3) : [],
      checkpoint:async count=>{
        if (CommandQueueManager.get(job.id)?.payload.cancelRequested) throw new Error("Artwork cleanup cancelled during inventory");
        ctx.updateCommandDescription({description:`Indexing artwork cache folders - ${count} found`});
        await ctx.yieldToEventLoop?.();
      }});
    if (performance.now()-started>=25_000) break;
    if (!state.current) {
      if (!folders.length) folders = nextInventoriedArtworkFolders(job.id,state.family,state.after);
      if (!folders.length) {state.family++;state.after="";folders=[];continue;}
      const name = folders.shift()!;
      if (state.family===3 && directories.slice(0,3).includes(name)) {state.after=name;continue;}
      state.current={name,after:""};
    }
    const current=state.current;
    if (path.basename(current.name)!==current.name || path.basename(current.after)!==current.after) throw new Error("Invalid artwork folder checkpoint");
    const folder = path.join(directory,current.name);
    artworkDirectoryIdentity(folder);
    const prefix=`${folder}${path.sep}`;
    const pending=db.prepare(`SELECT source_path FROM ArtworkCacheRetirement WHERE command_id=? AND phase='prepared'
      AND source_path>=? AND source_path<? LIMIT 25`).all(job.id,prefix,`${prefix}\uffff`) as Array<{source_path:string}>;
    for (const item of pending) {
      const filename=path.basename(item.source_path);
      await retireLegacyArtworkOrigin(job.id,{coverEntity:families[state.family],entityId:current.name,coverType:path.parse(filename).name},filename);
      settled++;
      await ctx.yieldToEventLoop?.();
      if (settled>=25 || performance.now()-started>=25_000) break;
    }
    if (settled>=25 || performance.now()-started>=25_000) break;
    const origins=await nextArtworkOrigins(folder,current.after);
    if (!origins.length) {state.after=current.name;delete state.current;state.directories=(state.directories??0)+1;settled++;continue;}
    for (const filename of origins) {
      await retireLegacyArtworkOrigin(job.id,{coverEntity:families[state.family],entityId:current.name,coverType:path.parse(filename).name},filename);
      current.after=filename;settled++;
      const counts=summary(job.id);
      ctx.updateCommandDescription({description:`Cleaning artwork cache - ${counts.retired} originals removed, ${counts.protected} protected`});
      await ctx.yieldToEventLoop?.();
      if (settled>=25 || performance.now()-started>=25_000) break;
    }
  }
  const counts=summary(job.id);
  if (state.family<4) throw new CommandContinuation({artworkCacheWork:state});
  for(let family=0;family<4;family++) {
    await validateArtworkFolderInventory({commandId:job.id,family,directory:path.join(root,directories[family]),
      excluded:family===3 ? directories.slice(0,3) : [],checkpoint:async()=>{
        if (CommandQueueManager.get(job.id)?.payload.cancelRequested) throw new Error("Artwork cleanup cancelled before completion");
        await ctx.yieldToEventLoop?.();
      }});
  }
  if (db.prepare("SELECT 1 FROM ArtworkCacheRetirement WHERE phase='prepared' LIMIT 1").get()) {
    throw new Error("Artwork cleanup has unresolved retirement evidence; recovery is required");
  }
  // A sweep is not equivalent to a completely clean cache when owners/sources
  // still need repair. Preserve actionable diagnostics rather than green success.
  if (counts.protected) {
    const reasons=db.prepare(`SELECT source_path,reason FROM ArtworkCacheRetirement
      WHERE command_id=? AND phase='protected' ORDER BY source_path LIMIT 5`).all(job.id);
    throw new Error(`Artwork cleanup removed ${counts.retired} originals (${counts.bytes} bytes); ${counts.protected} protected: ${JSON.stringify(reasons)}`);
  }
  ctx.updateCommandDescription({progress:100,description:`Artwork cache cleaned - ${counts.retired} originals removed (${counts.bytes} bytes)`});
}

function summary(commandId: number) {
  return (db.prepare("SELECT retired,protected,bytes FROM ArtworkCacheRuns WHERE command_id=?").get(commandId)
    ?? {retired:0,protected:0,bytes:0}) as {retired:number;protected:number;bytes:number};
}
