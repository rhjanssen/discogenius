import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTrackProgress } from './track-progress.js';

test('repeated provider tracks require their disc occurrence and conflicting identity never falls back to title', () => {
  const tracks = [1, 2].map(volumeNum => ({ providerTrackId: '123', title: 'Intro', trackNum: 1, volumeNum, status: 'queued' }));
  assert.equal(applyTrackProgress(tracks, { currentProviderTrackId: '123', trackStatus: 'completed' }), tracks);
  assert.equal(applyTrackProgress(tracks, { currentTrack: 'Intro', trackStatus: 'completed' }), tracks);
  assert.equal(applyTrackProgress(tracks, { currentProviderTrackId: 'missing', currentTrack: 'Intro', trackStatus: 'completed' }), tracks);
  assert.deepEqual(applyTrackProgress(tracks, { currentProviderTrackId: '123', currentTrackNum: 1, currentVolumeNum: 2, trackStatus: 'completed' }).map(t => t.status), ['queued', 'completed']);
});

test('title progress preserves Unicode, allows a quality suffix, and does not regress a completed track', () => {
  const tracks = [{ title: 'Été', status: 'queued' }, { title: '東京', status: 'queued' }];
  const updated = applyTrackProgress(tracks, { currentTrack: 'Été FLAC', trackStatus: 'completed' });
  assert.deepEqual(updated.map(t => t.status), ['completed', 'queued']);
  assert.equal(applyTrackProgress(updated, { currentTrack: 'Été', trackStatus: 'downloading' }), updated);
  assert.deepEqual(applyTrackProgress(updated, { currentTrack: '東京', trackStatus: 'downloading' }).map(t => t.status), ['completed', 'downloading']);
});
