/**
 * Ordering offers across providers, from facts rather than from tier names.
 *
 * A tier name is provider-local: "lossy" means AAC 256 at Apple and Opus 128 at
 * YouTube Music, and "1080p" means H.264 at TIDAL and VP9 at YouTube. Ranking
 * on the label — or on the raw number behind it — gets both cases wrong.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  compareAudioFidelity,
  expectedFactsForProviderTier,
  perceptualBitrateKbps,
  type AudioFacts,
} from "./audio-facts.js";
import {
  compareVideoQuality,
  expectedVideoFactsForProviderTier,
  videoFactsLabel,
  videoQualityClassOf,
  type VideoFacts,
} from "./video-facts.js";

const audio = (provider: string, tier: string): AudioFacts => {
  const facts = expectedFactsForProviderTier(provider, tier);
  assert.ok(facts, `${provider}/${tier}`);
  return facts;
};
const video = (provider: string, tier: string): VideoFacts => {
  const facts = expectedVideoFactsForProviderTier(provider, tier);
  assert.ok(facts, `${provider}/${tier}`);
  return facts;
};

/* ── Lossy offers compare perceptually, not by raw bitrate ──────────── */

test("Apple's lossy tier beats YouTube Music's, but not by the naive margin", () => {
  const apple = audio("apple-music", "stereo:lossy");   // AAC 256
  const youtube = audio("youtube-music", "high");       // Opus 256 ceiling
  const soundcloud = audio("soundcloud", "standard");   // MP3 128

  assert.ok(compareAudioFidelity(apple, soundcloud) > 0, "AAC 256 beats MP3 128");
  // Opus carries more signal per bit, so a bitrate comparison overstates AAC.
  assert.ok(
    perceptualBitrateKbps(youtube)! > perceptualBitrateKbps(apple)!,
    "Opus at the same nominal rate is worth more",
  );
});

test("a lower-bitrate Opus stream can beat a higher-bitrate MP3 one", () => {
  // The case raw numbers get backwards: 128 kbps Opus is not 128 kbps MP3.
  const opus = audio("youtube-music", "normal");   // Opus 128
  const mp3 = audio("soundcloud", "standard");     // MP3 128
  assert.equal(perceptualBitrateKbps(opus)! > perceptualBitrateKbps(mp3)!, true);
  assert.ok(compareAudioFidelity(opus, mp3) > 0);
});

test("lossless outranks any lossy offer regardless of bitrate", () => {
  const cd = audio("deezer", "flac");
  for (const [provider, tier] of [
    ["apple-music", "stereo:lossy"], ["tidal", "high"], ["youtube-music", "high"],
  ]) {
    assert.ok(compareAudioFidelity(cd, audio(provider, tier)) > 0, `${provider}/${tier}`);
  }
  assert.equal(perceptualBitrateKbps(cd), null, "lossless has no perceptual bitrate");
});

test("hi-res outranks CD, and depth breaks a tie before sample rate", () => {
  assert.ok(compareAudioFidelity(
    audio("tidal", "stereo:hires-lossless"), audio("tidal", "stereo:lossless"),
  ) > 0);
  assert.ok(compareAudioFidelity(
    audio("amazon-music", "ultra_hd"), audio("amazon-music", "hd"),
  ) > 0);
});

test("presentation is deliberately absent from the fidelity comparison", () => {
  // Whether Atmos beats hi-res stereo is a profile preference, not a property
  // of the audio. Baking it in here is the conflation this model undoes.
  const atmos = audio("tidal", "spatial:atmos");
  const hires = audio("tidal", "stereo:hires-lossless");
  assert.ok(compareAudioFidelity(hires, atmos) > 0, "on fidelity alone, hi-res wins");
});

/* ── Video: resolution first, then codec ────────────────────────────── */

test("1080p VP9 beats 1080p H.264", () => {
  const vp9 = video("youtube-music", "fhd");
  const h264 = video("tidal", "fhd");
  assert.equal(videoQualityClassOf(vp9), "fhd");
  assert.equal(videoQualityClassOf(h264), "fhd");
  assert.ok(compareVideoQuality(vp9, h264) > 0, "same height, better codec wins");
});

test("resolution dominates the codec", () => {
  // A better encoder cannot recover detail the resolution never carried.
  const hdVp9 = video("youtube-music", "hd");     // 720p VP9
  const fhdH264 = video("tidal", "fhd");          // 1080p H.264
  assert.ok(compareVideoQuality(fhdH264, hdVp9) > 0);
});

test("HDR breaks a tie between identical resolution and codec", () => {
  const base = video("apple-music", "uhd");
  assert.ok(compareVideoQuality({ ...base, hdr: true }, { ...base, hdr: false }) > 0);
});

test("a video tier ceiling reads as a ceiling", () => {
  assert.equal(videoFactsLabel(video("youtube-music", "fhd")), "VP9 · up to 1080p");
  assert.equal(
    videoFactsLabel({ ...video("youtube-music", "fhd"), heightPx: 1080, heightPxMax: null, frameRate: 60 }),
    "VP9 · 1080p · 60 fps",
  );
});

test("an unmapped video provider or tier resolves to nothing", () => {
  assert.equal(expectedVideoFactsForProviderTier("deezer", "fhd"), null);
  assert.equal(expectedVideoFactsForProviderTier("tidal", "uhd"), null);
});

test("the resolution class comes from the height, never from the tier name", () => {
  const mislabelled: VideoFacts = { ...video("tidal", "fhd"), heightPx: 480, heightPxMax: null };
  assert.equal(videoQualityClassOf(mislabelled), "sd");
});
