/**
 * Facts, not badges — and expectations, not ceilings.
 *
 * A provider tags an album `lossless` and nothing finer, so each tier maps to
 * the quality we expect to actually receive, read through the downloader we use
 * for that provider. The two cases that shape the whole model are Apple
 * Lossless (technically up to 24/48, overwhelmingly CD in practice) and YouTube
 * Music (published as "AAC or Opus", but yt-dlp prefers Opus).
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

/* ── A tier maps to what we expect to receive ───────────────────────── */

test("TIDAL tiers are the streams tiddl actually requests", () => {
  // tiddl asks TIDAL for a playback quality and gets that stream back; it does
  // not fetch lossless and re-encode, so these are real alternatives.
  assert.equal(facts("tidal", "low").bitrateKbps, 96);
  assert.equal(facts("tidal", "high").bitrateKbps, 320);
  const lossless = facts("tidal", "stereo:lossless");
  assert.equal(lossless.codec, "flac");
  assert.equal(lossless.bitDepth, 16);
  assert.equal(lossless.sampleRateHz, 44100);
  assert.equal(fidelityClassOf(facts("tidal", "stereo:hires-lossless")), "hires-lossless");
});

test("Apple Lossless is expected at CD, not at its theoretical ceiling", () => {
  // Apple Lossless can reach 24-bit/48 kHz, but the catalogue is overwhelmingly
  // CD. Recording the ceiling would file nearly all of it as hi-res and push it
  // into MAX profiles it does not belong in.
  const lossless = facts("apple-music", "stereo:lossless");
  assert.equal(lossless.codec, "alac");
  assert.equal(lossless.bitDepth, 16);
  assert.equal(lossless.sampleRateHz, 44100);
  assert.equal(fidelityClassOf(lossless), "lossless", "not hi-res");
  assert.equal(fidelityClassOf(facts("apple-music", "stereo:hires-lossless")), "hires-lossless");
  assert.equal(facts("apple-music", "stereo:lossy").bitrateKbps, 256);
});

test("Dolby Atmos is E-AC-3 JOC over a 5.1 bed, as both services deliver it", () => {
  // Observed from real TIDAL and Apple downloads rather than assumed from the
  // badge, which is why a layout is stated here at all.
  for (const [provider, tier] of [["tidal", "spatial:atmos"], ["apple-music", "atmos"]]) {
    const atmos = facts(provider, tier);
    assert.equal(atmos.codec, "eac3", provider);
    assert.equal(atmos.codecProfile, "joc", provider);
    assert.equal(atmos.channelLayout, "5.1", provider);
    assert.equal(atmos.sampleRateHz, 48000, provider);
    assert.equal(atmos.immersiveFormat, "dolby-atmos", provider);
  }
});

test("YouTube Music expects Opus, and Premium is what sets the rate", () => {
  // Google publishes each tier as "AAC or Opus"; yt-dlp prefers Opus wherever
  // it is offered. Premium decides 128 vs 256, and it is probed once per
  // session rather than per track.
  const free = facts("youtube-music", "stereo:lossy");
  assert.equal(free.codec, "opus");
  assert.equal(free.bitrateKbps, 128);

  const premium = expectedFactsForProviderTier(
    "youtube-music", "stereo:lossy", { youtubePremium: true },
  );
  assert.ok(premium);
  assert.equal(premium.codec, "opus");
  assert.equal(premium.bitrateKbps, 256);

  // The entitlement only affects YouTube.
  assert.equal(
    expectedFactsForProviderTier("tidal", "stereo:lossy", { youtubePremium: true })!.bitrateKbps,
    facts("tidal", "stereo:lossy").bitrateKbps,
  );
});

test("the other providers carry the codecs they publish", () => {
  assert.equal(facts("soundcloud", "standard").codec, "mp3");
  assert.equal(facts("soundcloud", "high").codec, "aac");
  assert.equal(facts("soundcloud", "high").bitrateKbps, 256);
  assert.equal(facts("deezer", "stereo:lossless").codec, "flac");
  assert.equal(facts("amazon-music", "ultra_hd").bitDepth, 24);
  // Spotify now has a lossless tier, and Votify can request FLAC.
  assert.equal(facts("spotify", "lossless").codec, "flac");
  assert.equal(facts("spotify", "high").codec, "vorbis");
});

test("Deezer has no hi-res and no immersive tier", () => {
  assert.equal(expectedFactsForProviderTier("deezer", "stereo:hires-lossless"), null);
  assert.equal(expectedFactsForProviderTier("deezer", "spatial:atmos"), null);
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
  // Which is the point: a profile can rank Atmos above 24-bit stereo without
  // claiming Atmos is higher fidelity than hi-res FLAC.
  assert.equal(presentationClassOf(facts("tidal", "stereo:hires-lossless")), "stereo");
  assert.equal(fidelityClassOf(facts("tidal", "stereo:hires-lossless")), "hires-lossless");
});

test("hi-res means better than CD on either axis", () => {
  const cd = facts("deezer", "flac");
  assert.equal(fidelityClassOf(cd), "lossless");
  assert.equal(fidelityClassOf({ ...cd, bitDepth: 24 }), "hires-lossless");
  assert.equal(fidelityClassOf({ ...cd, sampleRateHz: 96000 }), "hires-lossless");
});

test("fidelity is unknown when losslessness is unknown", () => {
  assert.equal(fidelityClassOf({ ...facts("deezer", "flac"), lossless: null }), null);
});

/* ── Labels state the expectation plainly ───────────────────────────── */

test("a label reads as the technical description it is", () => {
  assert.equal(
    audioFactsLabel(facts("tidal", "stereo:hires-lossless")), "FLAC · 2.0 · 24-bit · 96 kHz");
  assert.equal(audioFactsLabel(facts("tidal", "stereo:lossless")), "FLAC · 2.0 · 16-bit · 44.1 kHz");
  assert.equal(audioFactsLabel(facts("apple-music", "stereo:lossy")), "AAC · 2.0 · 256 kbps");
  assert.equal(
    audioFactsLabel(facts("apple-music", "atmos")),
    "Dolby Digital Plus · Dolby Atmos · 5.1 · 48 kHz · 768 kbps",
  );
});

test("a probed file names the codec it actually is", () => {
  const measured = mergeAudioFacts(facts("apple-music", "atmos"), {
    confidence: "observed", evidenceSource: "file-probe", bitrateKbps: 448,
  });
  assert.equal(audioFactsLabel(measured), "E-AC-3 JOC · Dolby Atmos · 5.1 · 48 kHz · 448 kbps");
});

/* ── A download describes itself, and nothing else ──────────────────── */

test("a probed file does not rewrite the offer it came from", () => {
  // One album arriving at 24/48 must not make a provider's whole lossless tier
  // hi-res; letting a download redefine a tier would make planning depend on
  // acquisition order.
  const measured = mergeAudioFacts(facts("apple-music", "stereo:lossless"), {
    confidence: "observed", evidenceSource: "file-probe",
    bitDepth: 24, sampleRateHz: 48000, bitrateKbps: 1411,
  });
  assert.equal(measured.confidence, "observed");
  assert.equal(measured.bitDepth, 24, "the file is what it is");
  assert.equal(
    facts("apple-music", "stereo:lossless").bitDepth, 16,
    "and the shared expectation is untouched",
  );
});

test("an absent observed field leaves the expectation standing", () => {
  const merged = mergeAudioFacts(facts("tidal", "stereo:lossless"), { bitrateKbps: 1000 });
  assert.equal(merged.codec, "flac");
  assert.equal(merged.bitDepth, 16);
  assert.equal(merged.confidence, "expected", "a bare number is not an observation");
});

test("360 Reality Audio is MPEG-H 3D Audio, not MQA", () => {
  // Object-based MPEG-H (ISO/IEC 23008-3). MQA is an unrelated
  // lossy-in-a-lossless-container scheme with nothing to do with 360RA.
  const facts360 = facts("amazon-music", "360ra");
  assert.equal(facts360.codec, "mpegh");
  assert.equal(facts360.immersiveFormat, "sony-360ra");
  assert.equal(presentationClassOf(facts360), "immersive");
});

/* ── Reading an acquired file back as facts ─────────────────────────── */

test("a probed file is read into the same vocabulary as an offer", async () => {
  const { observedFactsFromFile } = await import("./audio-facts.js");
  const flac = observedFactsFromFile({
    codec: "flac", bitrate: 1411, sample_rate: 44100, bit_depth: 16, channel_count: 2,
  });
  assert.equal(flac.confidence, "observed");
  assert.equal(flac.evidenceSource, "file-probe");
  assert.equal(flac.lossless, true, "inferred from the codec, not trusted from a column");
  assert.equal(fidelityClassOf(flac), "lossless");

  // ffprobe's names differ from ours and must normalise.
  assert.equal(observedFactsFromFile({ codec: "mp4a" }).codec, "aac");
  assert.equal(observedFactsFromFile({ codec: "ec-3" }).codec, "eac3");
  assert.equal(observedFactsFromFile({ codec: "invented" }).codec, null);
  assert.equal(observedFactsFromFile({ codec: "invented" }).lossless, null);
});

test("plain E-AC-3 5.1 is multichannel, not immersive", async () => {
  // The distinction this whole model rests on: Dolby Digital Plus surround is
  // exactly E-AC-3 at 5.1. Inferring Atmos from the channel count would
  // relabel every ordinary multichannel file as immersive.
  const { observedFactsFromFile } = await import("./audio-facts.js");
  const surround = observedFactsFromFile({
    codec: "eac3", channel_count: 6, channel_layout: "5.1", sample_rate: 48000, bitrate: 640,
  });
  assert.equal(surround.immersiveFormat, null);
  assert.equal(presentationClassOf(surround), "multichannel");
});

test("immersive needs the file to say so", async () => {
  const { observedFactsFromFile } = await import("./audio-facts.js");
  // Either the declared spatial format...
  const declared = observedFactsFromFile({
    codec: "eac3", channel_count: 6, channel_layout: "5.1", spatial_format: "atmos",
  });
  assert.equal(declared.immersiveFormat, "dolby-atmos");
  assert.equal(declared.objectAudio, true);
  assert.equal(presentationClassOf(declared), "immersive");

  // ...or the JOC profile, which is the Atmos-bearing extension.
  assert.equal(
    observedFactsFromFile({ codec: "eac3", channel_count: 6, codec_profile: "JOC" }).immersiveFormat,
    "dolby-atmos",
  );
  assert.equal(
    observedFactsFromFile({ codec: "mpegh", spatial_format: "360ra" }).immersiveFormat,
    "sony-360ra",
  );
  // And stereo E-AC-3 remains stereo.
  assert.equal(observedFactsFromFile({ codec: "eac3", channel_count: 2 }).immersiveFormat, null);
});

test("a file that arrived better than promised is not a reason to re-download", async () => {
  const { fileSatisfiesOffer, observedFactsFromFile } = await import("./audio-facts.js");
  const offer = facts("apple-music", "stereo:lossless");
  // Apple Lossless expected at CD; this one landed at 24/48.
  const better = observedFactsFromFile({
    codec: "alac", bit_depth: 24, sample_rate: 48000, channel_count: 2,
  });
  assert.equal(fileSatisfiesOffer(better, offer), true);
  assert.equal(fileSatisfiesOffer(observedFactsFromFile({
    codec: "alac", bit_depth: 16, sample_rate: 44100,
  }), offer), true, "exactly as promised also satisfies");
  assert.equal(fileSatisfiesOffer(observedFactsFromFile({
    codec: "aac", bitrate: 256,
  }), offer), false, "a lossy file does not satisfy a lossless offer");
});
