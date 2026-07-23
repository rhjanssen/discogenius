import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isLivePerformanceAudio,
  isLivePerformanceTitle,
  livePerformanceTitleSql,
  mainVideoMayFollowAudioRelationSql,
  relatedAudioIsLiveSql,
} from "./live-performance-markers.js";

test("isLivePerformanceTitle matches generic live / unplugged / performance markers", () => {
  assert.equal(isLivePerformanceTitle("Pompeii (Live)"), true);
  assert.equal(isLivePerformanceTitle("Pompeii (MTV Unplugged)"), true);
  assert.equal(isLivePerformanceTitle("Come as You Are (Unplugged)"), true);
  assert.equal(isLivePerformanceTitle("Song (Live Performance)"), true);
  assert.equal(isLivePerformanceTitle("Back to Black"), false);
  assert.equal(isLivePerformanceTitle("Olive Garden Theme"), false);
  assert.equal(isLivePerformanceTitle("Alive"), false);
});

test("isLivePerformanceTitle does not grow TV-show venue deny lists", () => {
  assert.equal(
    isLivePerformanceTitle("Stronger Than Me (Later With Jools Holland / Nov 2003)"),
    false,
    "show names alone are not live markers — use live-album-only membership",
  );
  assert.equal(isLivePerformanceTitle("Teach Me Tonight (Hootenanny / Dec 2004)"), false);
  assert.equal(isLivePerformanceTitle("Song (Porchester Hall)"), false);
});

test("isLivePerformanceAudio accepts album title or Live secondary", () => {
  assert.equal(
    isLivePerformanceAudio({ trackTitle: "Pompeii", albumTitle: "MTV Unplugged – Live in London" }),
    true,
  );
  assert.equal(
    isLivePerformanceAudio({ trackTitle: "Pompeii", albumSecondaryTypes: '["Live"]' }),
    true,
  );
  assert.equal(
    isLivePerformanceAudio({ trackTitle: "Pompeii", albumTitle: "Bad Blood", albumSecondaryTypes: "[]" }),
    false,
  );
});

test("SQL helpers emit shared live-marker predicates", () => {
  const titleSql = livePerformanceTitleSql("audio.title");
  assert.match(titleSql, /unplugged/);
  assert.match(titleSql, /GLOB/);
  assert.doesNotMatch(titleSql, /jools|hootenanny|porchester|pete mitchell/i);

  const related = relatedAudioIsLiveSql({
    trackTitleExpr: "audio.title",
    recordingIdExpr: "audio.id",
    recordingMbidExpr: "audio.mbid",
  });
  assert.match(related, /secondary_types/);

  const mayFollow = mainVideoMayFollowAudioRelationSql({
    videoVariantExpr: "video.video_variant",
    trackTitleExpr: "audio.title",
    albumTitleExpr: "album.title",
    albumSecondaryExpr: "album.secondary_types",
  });
  assert.match(mayFollow, /NOT IN \('video', 'official'\)/);
  assert.doesNotMatch(mayFollow, /jools|hootenanny/i);
});
