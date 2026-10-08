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
] as const;

/** Target canonical facts must have been upserted in the SAME admitted write.
 * Uniqueness/decision collisions roll back, rather than choosing a losing owner.
 * This changes database identity only; physical tags remain a retag operation. */
export function reconcileRecordingRedirects(db:Database.Database, tracks:readonly LidarrTrack[]): number {
    if(!db.inTransaction) throw new Error('Recording reconciliation requires an active transaction');
    const redirects=collectCatalogRedirects(tracks).recordings;
    return db.transaction(()=>{
        let merged=0;
        for(const [oldMbid,newMbid] of redirects){
            const old=db.prepare('SELECT id,is_video,youtube_video_id FROM Recordings WHERE mbid=?').get(oldMbid) as {id:number;is_video:number;youtube_video_id:string|null}|undefined;
            if(!old) continue;
            const target=db.prepare('SELECT id,is_video,youtube_video_id FROM Recordings WHERE mbid=?').get(newMbid) as typeof old;
            if(!target) throw new Error(`Missing canonical recording redirect target ${newMbid}`);
            if(old.is_video!==target.is_video || (old.youtube_video_id && target.youtube_video_id && old.youtube_video_id!==target.youtube_video_id))
                throw new Error(`Conflicting recording presentation identity for ${oldMbid}`);
            const conflictingTrack=db.prepare(`SELECT id FROM Tracks WHERE
                (recording_id=? AND recording_mbid IS NOT NULL AND recording_mbid NOT IN (?,?))
                OR (recording_mbid=? AND recording_id IS NOT NULL AND recording_id NOT IN (?,?)) LIMIT 1`)
                .get(old.id,oldMbid,newMbid,oldMbid,old.id,target.id);
            if(conflictingTrack) throw new Error(`Recording ${oldMbid} has conflicting track identity`);
            // Video artwork is keyed by the integer URL identity, and may have
            // on-disk proxies or a replacement journal. It needs its own file
            // relocation workflow; never delete that identity out from under it.
            for(const table of ['ArtworkSources','ArtworkLibraryLinks','ArtworkMutationJournal']) {
                const artwork=db.prepare(`SELECT 1 FROM "${table}" WHERE cover_entity='Video' AND entity_id IN (?,?) LIMIT 1`)
                    .get(String(old.id),oldMbid);
                if(artwork) throw new Error(`Recording ${oldMbid} has artwork requiring identity relocation`);
            }
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
            // Tracks go first: match validation checks the track's recording FK.
            db.prepare(`UPDATE Tracks SET recording_mbid=?,recording_id=?,
                foreign_recording_id=CASE WHEN foreign_recording_id=? THEN ? ELSE foreign_recording_id END,
                updated_at=CURRENT_TIMESTAMP WHERE recording_id=? OR recording_mbid=?`).run(newMbid,target.id,oldMbid,newMbid,old.id,oldMbid);
            db.prepare("UPDATE TrackFiles SET canonical_recording_mbid=?,needs_rename=1 WHERE recording_id=?").run(newMbid,old.id);
            db.prepare("UPDATE TrackFiles SET recording_id=?,canonical_recording_mbid=?,needs_rename=1 WHERE canonical_recording_mbid=?")
                .run(target.id,newMbid,oldMbid);
            // Identical credits are already represented by the canonical target.
            // Differing credits at the same ordinal still trigger rollback.
            db.prepare(`DELETE FROM RecordingArtistCredits WHERE recording_id=? AND ordinal IN (
                SELECT source.ordinal FROM RecordingArtistCredits source
                JOIN RecordingArtistCredits destination ON destination.recording_id=? AND destination.ordinal=source.ordinal
                WHERE source.recording_id=? AND source.artist_id=destination.artist_id
                  AND source.credited_name=destination.credited_name AND source.join_phrase=destination.join_phrase
                  AND source.role IS destination.role
            )`).run(old.id,target.id,old.id);
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
