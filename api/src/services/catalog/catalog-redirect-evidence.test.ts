import assert from "node:assert/strict";
import test from "node:test";
import {collectCatalogRedirects,normalizeEditionTracks} from "./catalog-track-reconciliation.js";
import {mapMbTrackToLidarr} from "./musicbrainz-ws-mapping.js";
import type {LidarrTrack} from "../metadata/servarr-metadata.js";
const track = (id:string, recording:string, position=1):LidarrTrack => ({Id:id,RecordingId:recording,TrackName:'Same title',TrackNumber:String(position),TrackPosition:position,MediumNumber:1,DurationMs:1000});

test('catalogue redirects preserve separate track and recording namespaces',()=>{
    const mapped=mapMbTrackToLidarr({id:'current-track',oldIds:['old-track'],recording:{id:'current-recording',oldIds:['old-recording']}},1);
    assert.deepEqual(mapped.OldIds,['old-track']);
    assert.deepEqual(mapped.OldRecordingIds,['old-recording']);
    const evidence=collectCatalogRedirects([mapped]);
    assert.deepEqual([...evidence.tracks],[['old-track','current-track']]);
    assert.deepEqual([...evidence.recordings],[['old-recording','current-recording']]);
});

test('same recording on several editions agrees on one recording redirect target',()=>{
    const a={...track('a','recording'),OldRecordingIds:['old']};
    const b={...track('b','recording'),OldRecordingIds:['old']};
    assert.equal(collectCatalogRedirects([a,b]).recordings.get('old'),'recording');
    assert.equal(collectCatalogRedirects([a,b]).tracks.size,0,'same title/recording/position does not manufacture a track redirect');
});

test('conflicting redirects across editions are rejected before reconciliation',()=>{
    const a={...track('a','r1'),OldIds:['old-track'],OldRecordingIds:['old-recording']};
    assert.throws(()=>collectCatalogRedirects([a,{...track('b','r2'),OldIds:['old-track']}]),/Conflicting catalogue OldIds/);
    assert.throws(()=>collectCatalogRedirects([a,{...track('b','r2'),OldRecordingIds:['old-recording']}]),/Conflicting catalogue OldRecordingIds/);
});

test('redirect source still present in the current catalogue is contradictory',()=>{
    assert.throws(()=>collectCatalogRedirects([{...track('a','r1'),OldIds:['b']},track('b','r2')]),/Invalid catalogue OldIds/);
    assert.throws(()=>collectCatalogRedirects([{...track('a','r1'),OldRecordingIds:['r2']},track('b','r2')]),/Invalid catalogue OldRecordingIds/);
});

test('malformed redirect evidence is not silently converted to an empty list',()=>{
    for(const aliases of ['old',{},[null],[''],[' old'],['a']]){
        assert.throws(()=>normalizeEditionTracks('edition',[{...track('a','recording'),OldIds:aliases} as LidarrTrack]),/Invalid catalogue OldIds/);
    }
});
