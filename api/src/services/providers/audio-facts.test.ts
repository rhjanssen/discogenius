/**
 * Facts, not badges.
 *
 * Two properties matter most here, and both are about not overstating what we
 * know: a tier's ceiling must never render as a measurement, and a Dolby Atmos
 * claim must never assert a channel layout it does not make.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  audioFactsLabel,
  expectedFactsForProviderTier,
  fidelityClassOf,
  mergeAudioFacts,
  presentationClassOf,
  type AudioFacts,
} from "./audio-facts.js";

const facts = (provider: string, tier: string): AudioFacts => {
  const resolved = expectedFactsForProviderTier(provider, tier);
  assert.ok(resolved, `${provider}/${tier} must be mapped`);
  return resolved;
};

/* ── Provider tiers say what their specifications say ───────────────── */

test("TIDAL tiers carry FLAC, and AAC for the lossy ones", () => {
  const lossless = facts("tidal", "stereo:lossless");
  assert.equal(lossless.codec, "flac");
  assert.equal(lossless.bitDepth, 16);
  assert.equal(lossless.sampleRateHz, 44100);
  assert.equal(fidelityClassOf(lossless), "lossless");

  const hires = facts("tidal", "stereo:hires-lossless");
  assert.equal(hires.codec, "flac");
  assert.equal(hires.bitDepth, 24);
  assert.equal(hires.sampleRateHz, null, "the tier states a range, not a rate");
  assert.equal(hires.sampleRateHzMax, 192000);
  assert.equal(fidelityClassOf(hires), "hires-lossless");

  assert.equal(facts("tidal", "high").codec, "aac");
  assert.equal(facts("tidal", "high").bitrateKbpsMax, 320);
});

test("Apple Music is ALAC where TIDAL is FLAC, and AAC 256 where TIDAL is 320", () => {
  assert.equal(facts("apple-music", "stereo:lossless").codec, "alac");
  assert.equal(facts("apple-music", "stereo:hires-lossless").codec, "alac");
  const lossy = facts("apple-music", "stereo:lossy");
  assert.equal(lossy.codec, "aac");
  assert.equal(lossy.bitrateKbps, 256, "Apple publishes an exact 256, not a ceiling");
});

test("Deezer has no hi-res and no immersive tier", () => {
  assert.equal(facts("deezer", "stereo:lossless").codec, "flac");
  assert.equal(expectedFactsForProviderTier("deezer", "stereo:hires-lossless"), null);
  assert.equal(expectedFactsForProviderTier("deezer", "spatial:atmos"), null);
});

test("Amazon Music HD is CD FLAC and Ultra HD is hi-res FLAC", () => {
  assert.equal(fidelityClassOf(facts("amazon-music", "hd")), "lossless");
  const ultra = facts("amazon-music", "ultra_hd");
  assert.equal(ultra.codec, "flac");
  assert.equal(ultra.bitDepth, 24);
  assert.equal(ultra.sampleRateHzMax, 192000);
  assert.equal(fidelityClassOf(ultra), "hires-lossless");
});

test("the lossy-only providers carry their real codecs, not a generic tag", () => {
  assert.equal(facts("spotify", "high").codec, "vorbis");
  assert.equal(facts("youtube-music", "high").codec, "opus");
  assert.equal(facts("soundcloud", "standard").codec, "mp3");
  for (const [provider, tier] of [["spotify", "high"], ["youtube-music", "high"], ["soundcloud", "standard"]]) {
    assert.equal(fidelityClassOf(facts(provider, tier)), "lossy", provider);
  }
});

test("an unmapped provider or tier resolves to nothing rather than a guess", () => {
  assert.equal(expectedFactsForProviderTier("bandcamp", "stereo:lossless"), null);
  assert.equal(expectedFactsForProviderTier("tidal", "stereo:invented"), null);
  assert.equal(expectedFactsForProviderTier(null, "stereo:lossless"), null);
  assert.equal(expectedFactsForProviderTier("tidal", ""), null);
});

/* ── Fidelity and presentation are separate axes ────────────────────── */

test("Dolby Atmos is a presentation, never a fidelity tier", () => {
  const atmos = facts("tidal", "spatial:atmos");
  assert.equal(presentationClassOf(atmos), "immersive");
  assert.equal(fidelityClassOf(atmos), "lossy", "E-AC-3 is a lossy codec");
  // Which is the whole point: a profile can now rank Atmos above 24-bit stereo
  // without claiming Atmos is higher fidelity than hi-res FLAC.
  assert.equal(presentationClassOf(facts("tidal", "stereo:hires-lossless")), "stereo");
  assert.equal(fidelityClassOf(facts("tidal", "stereo:hires-lossless")), "hires-lossless");
});

test("presentation defaults to stereo, and multichannel needs a channel count", () => {
  const cd = facts("deezer", "flac");
  assert.equal(presentationClassOf(cd), "stereo");
  assert.equal(presentationClassOf({ ...cd, channelCount: 6 }), "multichannel");
  assert.equal(presentationClassOf({ ...cd, channelCount: null }), "stereo");
});

test("a ceiling still counts as hi-res, because that is what the tier offers", () => {
  const ceilingOnly: AudioFacts = {
    ...facts("deezer", "flac"), bitDepth: null, sampleRateHz: null,
    bitDepthMax: 24, sampleRateHzMax: 96000,
  };
  assert.equal(fidelityClassOf(ceilingOnly), "hires-lossless");
});

test("fidelity is unknown when losslessness is unknown", () => {
  assert.equal(fidelityClassOf({ ...facts("deezer", "flac"), lossless: null }), null);
});

/* ── Labels never overstate the evidence ────────────────────────────── */

test("a ceiling reads as a ceiling", () => {
  assert.equal(
    audioFactsLabel(facts("tidal", "stereo:hires-lossless")),
    "FLAC · 24-bit · up to 192 kHz",
  );
  assert.equal(audioFactsLabel(facts("tidal", "stereo:lossless")), "FLAC · 16-bit · 44.1 kHz");
  assert.equal(audioFactsLabel(facts("apple-music", "stereo:lossy")), "AAC · 256 kbps");
  assert.equal(audioFactsLabel(facts("tidal", "high")), "AAC · up to 320 kbps");
});

test("an Atmos claim names the format, not a speaker layout", () => {
  // The delivery codec is E-AC-3 with Joint Object Coding; JOC codes objects
  // over a bed, and Apple's HLS signals CHANNELS="16/JOC" — an object count.
  // Rendering that as "5.1" states a layout the claim does not make.
  const claim = facts("apple-music", "atmos");
  assert.equal(audioFactsLabel(claim), "Dolby Digital Plus · Dolby Atmos");
  assert.equal(claim.channelLayout, null);
  assert.equal(claim.channelCount, null);
});

test("a measured Atmos file reads as what was measured", () => {
  const measured = mergeAudioFacts(facts("apple-music", "atmos"), {
    confidence: "observed",
    evidenceSource: "file-probe",
    codec: "eac3",
    codecProfile: "joc",
    bitrateKbps: 768,
    sampleRateHz: 48000,
  });
  assert.equal(audioFactsLabel(measured), "E-AC-3 JOC · Dolby Atmos · 48 kHz · 768 kbps");
});

/* ── Measurements settle ceilings ───────────────────────────────────── */

test("an observation replaces the ceiling it settles", () => {
  const measured = mergeAudioFacts(facts("tidal", "stereo:hires-lossless"), {
    confidence: "observed",
    evidenceSource: "file-probe",
    sampleRateHz: 96000,
    channelLayout: "2.0",
    bitrateKbps: 2814,
  });
  assert.equal(measured.sampleRateHzMax, null, "no longer 'up to'");
  assert.equal(measured.confidence, "observed");
  assert.equal(audioFactsLabel(measured), "FLAC · 2.0 · 24-bit · 96 kHz · 2814 kbps");
});

test("merging does not mutate the shared expectation table", () => {
  const first = facts("tidal", "stereo:hires-lossless");
  mergeAudioFacts(first, { confidence: "observed", sampleRateHz: 96000 });
  assert.equal(facts("tidal", "stereo:hires-lossless").sampleRateHzMax, 192000);
  assert.equal(facts("tidal", "stereo:hires-lossless").confidence, "expected");
});

test("an absent observed field leaves the expectation standing", () => {
  const merged = mergeAudioFacts(facts("tidal", "stereo:lossless"), { bitrateKbps: 1000 });
  assert.equal(merged.codec, "flac");
  assert.equal(merged.bitDepth, 16);
  assert.equal(merged.confidence, "expected", "a bare number is not an observation");
});

test("360 Reality Audio is MPEG-H 3D Audio, not MQA", () => {
  // Object-based MPEG-H (ISO/IEC 23008-3). MQA is an unrelated
  // lossy-in-a-lossless-container scheme and has nothing to do with 360RA.
  const facts360 = facts("amazon-music", "360ra");
  assert.equal(facts360.codec, "mpegh");
  assert.equal(facts360.codecProfile, "3d-audio");
  assert.equal(facts360.immersiveFormat, "sony-360ra");
  assert.equal(facts360.objectAudio, true);
  assert.equal(presentationClassOf(facts360), "immersive");
  assert.equal(audioFactsLabel(facts360), "MPEG-H 3D Audio · 360 Reality Audio");
});
