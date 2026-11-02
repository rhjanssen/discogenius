import type Database from "better-sqlite3";
import type {LidarrTrack} from "../metadata/servarr-metadata.js";
import {collectCatalogRedirects} from "./catalog-track-reconciliation.js";
import {prepareAcquisitionPlanMutation} from "../music/acquisition-plan-ownership.js";

/** Every active-schema integer recording owner. Keep this list audited against
 * actual runtime foreign keys; no cascade may silently discard an owner. */
export const RECORDING_OWNERS = [
    ['Tracks','recording_id'], ['TrackFiles','recording_id'],
    ['ProviderTrackMatches','recording_id'], ['ProviderVideoMatches','recording_id'],
    ['RecordingArtistCredits','recording_id'], ['LibraryVideos','video_recording_id'],
    ['RecordingRelations','source_recording_id'], ['RecordingRelations','target_recording_id'],
    ['ArtistTopTracks','recording_id'], ['TrackLibraryIndex','recording_id'],
    ['CatalogRelationshipCredits','recording_id'], ['RecordingWorks','recording_id'],
] as const;

/** A merge that would pick a winner between two owners. The edition transaction
 * rolls back. Callers may continue with the next edition and leave this one. */
export function isPreservedCatalogIdentityConflict(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /^(?:UNIQUE constraint failed: (?:RecordingArtistCredits|RecordingRelations|ProviderVideoMatches|ProviderTrackMatches|LibraryVideos|ArtistTopTracks|TrackLibraryIndex|RecordingWorks)\b|Conflicting recording presentation identity\b)/.test(message);
}

/** Rebuild a journal snapshot the same way ArtworkMutationJournal recovery does,
 * after entity_id has already moved. File bytes are not touched. */
function artworkJournalSnapshot(db:Database.Database, entityId:string, coverType:string, destination:string): string {
    return JSON.stringify({
        source: db.prepare("SELECT * FROM ArtworkSources WHERE cover_entity='Video' AND entity_id=? AND cover_type=?").get(entityId,coverType) ?? null,
        links: db.prepare("SELECT * FROM ArtworkLibraryLinks WHERE file_path=? ORDER BY cover_entity,entity_id,cover_type").all(destination),
        file: db.prepare(`SELECT id,artist_id,track_file_id,file_path,relative_path,library_root,library_slot,extension,type,file_type,
            canonical_artist_mbid,canonical_release_group_mbid,canonical_release_mbid,canonical_track_mbid,canonical_recording_mbid,
            provider,provider_entity_type,provider_id,consumer FROM MetadataFiles WHERE file_path=?`).get(destination) ?? null,
    });
}

/** Move video artwork identity onto the surviving recording. Target source facts
 * win; the merged recording only fills empty preference/hash holes. Duplicate
 * library-link paths keep the target row. Artwork files are never deleted. */
function relocateRecordingArtwork(db:Database.Database, old:{id:number;mbid:string}, target:{id:number}): void {
    const toId=String(target.id);
    const fromIds=[...new Set([String(old.id),old.mbid].filter((id):id is string=>Boolean(id)&&id!==toId))];
    for(const fromId of fromIds){
        const sources=db.prepare("SELECT cover_type,source_url,preference,fulfilled_by,content_hash FROM ArtworkSources WHERE cover_entity='Video' AND entity_id=?").all(fromId) as Array<{
            cover_type:string;source_url:string;preference:string|null;fulfilled_by:string|null;content_hash:string|null;
        }>;
        for(const source of sources){
            const existing=db.prepare("SELECT 1 FROM ArtworkSources WHERE cover_entity='Video' AND entity_id=? AND cover_type=?").get(toId,source.cover_type);
            if(!existing){
                db.prepare(`INSERT INTO ArtworkSources(cover_entity,entity_id,cover_type,source_url,preference,fulfilled_by,content_hash)
                    VALUES('Video',?,?,?,?,?,?)`).run(toId,source.cover_type,source.source_url,source.preference,source.fulfilled_by,source.content_hash);
            }else{
                db.prepare(`UPDATE ArtworkSources SET preference=COALESCE(preference,?),fulfilled_by=COALESCE(fulfilled_by,?),content_hash=COALESCE(content_hash,?)
                    WHERE cover_entity='Video' AND entity_id=? AND cover_type=?`).run(source.preference,source.fulfilled_by,source.content_hash,toId,source.cover_type);
            }
        }
        db.prepare(`DELETE FROM ArtworkLibraryLinks WHERE cover_entity='Video' AND entity_id=? AND EXISTS (
            SELECT 1 FROM ArtworkLibraryLinks kept WHERE kept.cover_entity='Video' AND kept.entity_id=?
              AND kept.cover_type=ArtworkLibraryLinks.cover_type AND kept.file_path=ArtworkLibraryLinks.file_path)`).run(fromId,toId);
        db.prepare("UPDATE ArtworkLibraryLinks SET entity_id=? WHERE cover_entity='Video' AND entity_id=?").run(toId,fromId);
        db.prepare(`DELETE FROM ArtworkProxyVariants WHERE cover_entity='Video' AND entity_id=? AND EXISTS (
            SELECT 1 FROM ArtworkProxyVariants kept WHERE kept.cover_entity='Video' AND kept.entity_id=?
              AND kept.cover_type=ArtworkProxyVariants.cover_type AND kept.height=ArtworkProxyVariants.height)`).run(fromId,toId);
        db.prepare("UPDATE ArtworkProxyVariants SET entity_id=? WHERE cover_entity='Video' AND entity_id=?").run(toId,fromId);
        const journals=db.prepare("SELECT id,cover_type,destination_path FROM ArtworkMutationJournal WHERE cover_entity='Video' AND entity_id=?").all(fromId) as Array<{
            id:string;cover_type:string;destination_path:string;
        }>;
        db.prepare("UPDATE ArtworkMutationJournal SET entity_id=? WHERE cover_entity='Video' AND entity_id=?").run(toId,fromId);
        for(const journal of journals){
            db.prepare("UPDATE ArtworkMutationJournal SET database_snapshot=? WHERE id=?")
                .run(artworkJournalSnapshot(db,toId,journal.cover_type,journal.destination_path),journal.id);
        }
        db.prepare("DELETE FROM ArtworkSources WHERE cover_entity='Video' AND entity_id=?").run(fromId);
    }
}

/** Target canonical facts must have been upserted in the SAME admitted write.
 * Uniqueness/decision collisions roll back, rather than choosing a losing owner.
 * This changes database identity only; physical tags remain a retag operation. */
export function reconcileRecordingRedirects(db:Database.Database, tracks:readonly LidarrTrack[]): number {
    if(!db.inTransaction) throw new Error('Recording reconciliation requires an active transaction');
    const redirects=collectCatalogRedirects(tracks).recordings;
    return db.transaction(()=>{
        let merged=0;
        for(const [oldMbid,newMbid] of redirects){
            const old=db.prepare('SELECT id,mbid,is_video,youtube_video_id FROM Recordings WHERE mbid=?').get(oldMbid) as {id:number;mbid:string;is_video:number;youtube_video_id:string|null}|undefined;
            if(!old) continue;
            const target=db.prepare('SELECT id,mbid,is_video,youtube_video_id FROM Recordings WHERE mbid=?').get(newMbid) as typeof old;
            if(!target) throw new Error(`Missing canonical recording redirect target ${newMbid}`);
            if(old.is_video!==target.is_video || (old.youtube_video_id && target.youtube_video_id && old.youtube_video_id!==target.youtube_video_id))
                throw new Error(`Conflicting recording presentation identity for ${oldMbid}`);
            const conflictingTrack=db.prepare(`SELECT id FROM Tracks WHERE
                (recording_id=? AND recording_mbid IS NOT NULL AND recording_mbid NOT IN (?,?))
                OR (recording_mbid=? AND recording_id IS NOT NULL AND recording_id NOT IN (?,?)) LIMIT 1`)
                .get(old.id,oldMbid,newMbid,oldMbid,old.id,target.id);
            if(conflictingTrack) throw new Error(`Recording ${oldMbid} has conflicting track identity`);
            // Claimed plans and executing standalone snapshots cannot be rewritten.
            const plans=(db.prepare(`SELECT DISTINCT assignment.plan_id AS id FROM AcquisitionPlanTracks assignment
                WHERE assignment.track_id IN (SELECT id FROM Tracks WHERE recording_id=? OR recording_mbid=?)
                OR assignment.provider_track_match_id IN (SELECT id FROM ProviderTrackMatches WHERE recording_id=?)`).all(old.id,oldMbid,old.id) as {id:number}[]).map(row=>row.id);
            prepareAcquisitionPlanMutation(db,plans);
            const snapshot=db.prepare(`SELECT id FROM commands WHERE status IN ('queued','started')
                AND name IN ('DownloadAlbum','DownloadTrack','DownloadVideo','ImportDownload')
                AND (? IN (SELECT value FROM json_tree(commands.payload) WHERE type='text')
                  OR CAST(json_extract(payload,'$.canonicalRecordingId') AS TEXT)=?
                  OR CAST(json_extract(payload,'$.resolved.canonicalRecordingId') AS TEXT)=?) LIMIT 1`).get(oldMbid,String(old.id),String(old.id));
            if(snapshot) throw new Error(`Recording ${oldMbid} has an executing media snapshot`);
            // Standalone requests need their durable request key reconciled too.
            // Preserve them intact until that admission path is implemented.
            const standalone=db.prepare(`SELECT id FROM DownloadQueue WHERE plan_id IS NULL
                AND json_extract(payload,'$.canonicalRecordingMbid')=? LIMIT 1`).get(oldMbid);
            const standaloneId=db.prepare(`SELECT id FROM DownloadQueue WHERE plan_id IS NULL
                AND CAST(json_extract(payload,'$.canonicalRecordingId') AS TEXT)=? LIMIT 1`).get(String(old.id));
            if(standalone || standaloneId) throw new Error(`Recording ${oldMbid} has a standalone waiting request`);
            const contradictory=db.prepare(`SELECT id FROM TrackFiles WHERE recording_id=?
                AND canonical_recording_mbid IS NOT NULL AND canonical_recording_mbid NOT IN (?,?)
                OR canonical_recording_mbid=? AND recording_id IS NOT NULL AND recording_id NOT IN (?,?) LIMIT 1`)
                .get(old.id,oldMbid,newMbid,oldMbid,old.id,target.id);
            if(contradictory) throw new Error(`Recording ${oldMbid} has conflicting file identity`);
            // Video artwork is keyed by the recording's integer URL identity.
            // Re-key provenance in this transaction. Cache files stay on disk
            // (proxies regenerate; retirement without a source fails closed).
            relocateRecordingArtwork(db, old, target);
            // Tracks go first: match validation checks the track's recording FK.
            db.prepare(`UPDATE Tracks SET recording_mbid=?,recording_id=?,
                foreign_recording_id=CASE WHEN foreign_recording_id=? THEN ? ELSE foreign_recording_id END,
                updated_at=CURRENT_TIMESTAMP WHERE recording_id=? OR recording_mbid=?`).run(newMbid,target.id,oldMbid,newMbid,old.id,oldMbid);
            db.prepare("UPDATE TrackFiles SET canonical_recording_mbid=?,needs_rename=1 WHERE recording_id=?").run(newMbid,old.id);
            db.prepare("UPDATE TrackFiles SET recording_id=?,canonical_recording_mbid=?,needs_rename=1 WHERE canonical_recording_mbid=?")
                .run(target.id,newMbid,oldMbid);
            // Recording credits are derived catalogue facts (MusicBrainz or the
            // release-group fallback), never user decisions, and are rebuilt on
            // refresh. The canonical target's credits win as a whole; the merged
            // recording's credits only fill a target that has none. Mixing the
            // two sets per ordinal would produce a credit list neither source has.
            const targetHasCredits=db.prepare('SELECT 1 FROM RecordingArtistCredits WHERE recording_id=? LIMIT 1').get(target.id);
            if(targetHasCredits) db.prepare('DELETE FROM RecordingArtistCredits WHERE recording_id=?').run(old.id);
            // RecordingWorks is keyed by (recording_id, work_mbid). The target's
            // row for a shared work wins; the rest of the source works move.
            db.prepare(`DELETE FROM RecordingWorks WHERE recording_id=? AND work_mbid IN (
                SELECT work_mbid FROM RecordingWorks WHERE recording_id=?)`).run(old.id, target.id);
            for(const [table,column] of RECORDING_OWNERS){
                if(table==='Tracks') continue;
                db.prepare(`UPDATE "${table}" SET "${column}"=? WHERE "${column}"=?`).run(target.id,old.id);
            }
            for(const table of ['TrackFiles','MetadataFiles','LyricFiles','ExtraFiles']){
                db.prepare(`UPDATE "${table}" SET canonical_recording_mbid=?,needs_rename=1 WHERE canonical_recording_mbid=?`).run(newMbid,oldMbid);
            }
            db.prepare('UPDATE RecordingRelations SET source_foreign_recording_id=? WHERE source_foreign_recording_id=?').run(newMbid,oldMbid);
            db.prepare('UPDATE RecordingRelations SET target_foreign_recording_id=? WHERE target_foreign_recording_id=?').run(newMbid,oldMbid);
            if(old.youtube_video_id && !target.youtube_video_id){
                db.prepare('UPDATE Recordings SET youtube_video_id=NULL WHERE id=?').run(old.id);
                db.prepare('UPDATE Recordings SET youtube_video_id=? WHERE id=?').run(old.youtube_video_id,target.id);
            }
            // Canonical target facts win; retain permitted supplemental holes.
            db.prepare(`UPDATE Recordings SET cover_image_id=COALESCE(cover_image_id,(SELECT cover_image_id FROM Recordings WHERE id=?)),
                cover_image_url=COALESCE(cover_image_url,(SELECT cover_image_url FROM Recordings WHERE id=?)),
                copyright=COALESCE(copyright,(SELECT copyright FROM Recordings WHERE id=?)) WHERE id=?`).run(old.id,old.id,old.id,target.id);
            prepareAcquisitionPlanMutation(db,plans); // recanonicalize durable selected keys after owner transfer
            for(const id of plans) db.prepare("UPDATE AcquisitionPlans SET state='stale',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
            db.prepare('DELETE FROM Recordings WHERE id=?').run(old.id);
            merged++;
        }
        return merged;
    })();
}
