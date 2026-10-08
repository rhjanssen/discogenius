import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { OptimizedAcquisitionPlan } from "./acquisition-plan-optimizer.js";

export function acquisitionPlanSourceOrder(plan: Pick<OptimizedAcquisitionPlan,'sourceIds'|'preferredSourceId'|'tracks'>): number[] {
  const counts = new Map<number,number>();
  for (const track of plan.tracks) counts.set(track.providerEditionMatchId,(counts.get(track.providerEditionMatchId)??0)+1);
  return [...plan.sourceIds].sort((left,right)=>(left===plan.preferredSourceId?0:1)-(right===plan.preferredSourceId?0:1)
    || (counts.get(right)??0)-(counts.get(left)??0) || left-right);
}

/** Match/member row IDs are execution bindings, not durable user choices. */
export function resourceAcquisitionPlanKey(db: Database.Database, plan: Pick<OptimizedAcquisitionPlan,
  'provider'|'composition'|'qualityTier'|'explicitContent'|'sourceIds'|'preferredSourceId'|'tracks'>): string {
  const source = db.prepare(`SELECT item.provider,item.entity_type,item.provider_id
    FROM ProviderEditionMatches match JOIN ProviderItems item ON item.id=match.provider_edition_item_id
    WHERE match.id=?`);
  const assignment = db.prepare(`SELECT track.mbid AS track_mbid,track.recording_mbid,
      item.provider,item.entity_type,item.provider_id,
      parent.provider_id AS edition_provider_id, member.medium_position,member.position,
      variant_item.entity_type AS variant_entity_type,variant_item.provider_id AS variant_provider_id,variant.variant_key
    FROM ProviderTrackMatches match
    JOIN ProviderItems item ON item.id=match.provider_track_item_id
    JOIN ProviderEditionMembers member ON member.id=match.provider_edition_member_id
    JOIN ProviderItems parent ON parent.id=member.provider_edition_item_id
    JOIN Tracks track ON track.id=?
    JOIN ProviderItemAudioVariants variant ON variant.id=?
    JOIN ProviderItems variant_item ON variant_item.id=variant.provider_item_id
    WHERE match.id=? AND member.id=? AND match.provider_edition_match_id=?
      AND (variant.provider_item_id=item.id OR variant.provider_item_id=parent.id)
      AND item.provider=? AND parent.provider=? AND variant_item.provider=?`);
  const primaryId = acquisitionPlanSourceOrder(plan)[0];
  const sources = plan.sourceIds.map(id => {
    const row = source.get(id) as {provider:string;entity_type:string;provider_id:string} | undefined;
    if (!row || row.provider !== plan.provider || row.entity_type !== 'release') throw new Error(`Invalid plan source identity ${id}`);
    return JSON.stringify([row.provider,row.entity_type,row.provider_id,id===primaryId?'primary':'supplement']);
  }).sort();
  const tracks = plan.tracks.map(track => {
    const row = assignment.get(track.trackId,track.providerAudioVariantId,track.providerTrackMatchId,
      track.providerEditionMemberId,track.providerEditionMatchId,
      plan.provider,plan.provider,plan.provider);
    if (!row) throw new Error(`Missing plan assignment identity ${track.trackId}`);
    return JSON.stringify([row,track.sourceQuality]);
  }).sort();
  return crypto.createHash('sha256').update(JSON.stringify({provider:plan.provider,composition:plan.composition,
    quality:plan.qualityTier,explicit:plan.explicitContent,sources,tracks})).digest('hex');
}

/** Reconstruct an intact persisted choice from facts, without parsing old keys. */
export function persistedResourceAcquisitionPlanKey(db: Database.Database, planId: number): string | null {
  const plan = db.prepare("SELECT provider,composition,quality_tier,explicit_content,coverage FROM AcquisitionPlans WHERE id=? AND state IN ('current','stale')")
    .get(planId) as {provider:string;composition:OptimizedAcquisitionPlan['composition'];quality_tier:OptimizedAcquisitionPlan['qualityTier'];explicit_content:OptimizedAcquisitionPlan['explicitContent'];coverage:number}|undefined;
  if (!plan) return null;
  const sources = db.prepare("SELECT provider_edition_match_id,role FROM AcquisitionPlanSources WHERE plan_id=? ORDER BY sort_order,id")
    .all(planId) as Array<{provider_edition_match_id:number;role:string}>;
  const tracks = db.prepare(`SELECT assignment.track_id AS trackId,source.provider_edition_match_id AS providerEditionMatchId,
    assignment.provider_track_match_id AS providerTrackMatchId,match.provider_edition_member_id AS providerEditionMemberId,
    assignment.provider_audio_variant_id AS providerAudioVariantId,
    COALESCE(json_extract(assignment.source_quality_snapshot,'$.quality'),variant.quality_class) AS sourceQuality
    FROM AcquisitionPlanTracks assignment JOIN AcquisitionPlanSources source ON source.id=assignment.source_id
    JOIN ProviderTrackMatches match ON match.id=assignment.provider_track_match_id
    JOIN ProviderItemAudioVariants variant ON variant.id=assignment.provider_audio_variant_id WHERE assignment.plan_id=?`)
    .all(planId) as OptimizedAcquisitionPlan['tracks'];
  if (sources.length===0 || tracks.length===0 || tracks.length!==plan.coverage
    || tracks.some(track=>!Number.isSafeInteger(track.providerEditionMemberId) || track.providerEditionMemberId<=0)) return null;
  return resourceAcquisitionPlanKey(db,{provider:plan.provider,composition:plan.composition,
    qualityTier:plan.quality_tier,explicitContent:plan.explicit_content,
    sourceIds:sources.map(row=>row.provider_edition_match_id),
    preferredSourceId:sources.find(row=>row.role==='primary')?.provider_edition_match_id??null,tracks});
}
