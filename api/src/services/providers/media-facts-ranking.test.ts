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
  lossyQualityScore,
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

const lossy = (codec: AudioFacts["codec"], bitrateKbps: number): AudioFacts => ({
  ...audio("soundcloud", "standard"), codec, bitrateKbps,
});

test("a codec advantage survives where bits are scarce", () => {
  // Hydrogenaudio's 96 kbps multiformat test put Opus ahead of AAC ahead of
  // MP3; the MP3 entry needed roughly 30 kbps more than its nominal rate.
  assert.ok(lossyQualityScore(lossy("opus", 96))! > lossyQualityScore(lossy("mp3", 96))!);
  assert.ok(lossyQualityScore(lossy("opus", 128))! > lossyQualityScore(lossy("mp3", 128))!);
  assert.ok(lossyQualityScore(lossy("aac", 128))! > lossyQualityScore(lossy("mp3", 128))!);
  assert.ok(compareAudioFidelity(lossy("opus", 96), lossy("mp3", 128)) > 0);
});

test("the codec advantage tapers as bitrate rises", () => {
  // The Opus project warns against reading precise equivalences off its curves,
  // and transparency is listener- and material-dependent. So the gap must
  // narrow rather than stay a fixed multiple.
  const lowGap = lossyQualityScore(lossy("opus", 96))! / lossyQualityScore(lossy("mp3", 96))!;
  const highGap = lossyQualityScore(lossy("opus", 320))! / lossyQualityScore(lossy("mp3", 320))!;
  assert.ok(highGap < lowGap, "the advantage narrows approaching transparency");
  assert.ok(highGap >= 1, "but never inverts");
});

test("more bits of the same codec always wins", () => {
  assert.ok(compareAudioFidelity(lossy("aac", 256), lossy("aac", 128)) > 0);
  assert.ok(compareAudioFidelity(lossy("mp3", 320), lossy("mp3", 128)) > 0);
  assert.ok(compareAudioFidelity(lossy("opus", 256), lossy("opus", 128)) > 0);
});

test("Apple's AAC 256 still outranks a 128 kbps stream of any codec", () => {
  const apple = audio("apple-music", "stereo:lossy");
  assert.equal(apple.bitrateKbps, 256);
  assert.ok(compareAudioFidelity(apple, lossy("opus", 128)) > 0);
  assert.ok(compareAudioFidelity(apple, lossy("mp3", 128)) > 0);
  // And SoundCloud Go+ ties it: SoundCloud publishes AAC 256 too.
  assert.equal(compareAudioFidelity(apple, audio("soundcloud", "high")), 0);
});

test("YouTube Premium is worth roughly a doubling, and the model says so", () => {
  // Free expects Opus 128, Premium Opus 256 — the entitlement is the only
  // thing that decides it, and it is probed once per session.
  const free = audio("youtube-music", "stereo:lossy");
  const premium = expectedFactsForProviderTier(
    "youtube-music", "stereo:lossy", { youtubePremium: true },
  )!;
  assert.ok(compareAudioFidelity(premium, free) > 0);
  // Premium Opus 256 lands in the same neighbourhood as Apple AAC 256, because
  // the codec advantage has largely tapered by then.
  const apple = audio("apple-music", "stereo:lossy");
  const ratio = lossyQualityScore(premium)! / lossyQualityScore(apple)!;
  assert.ok(ratio > 1 && ratio < 1.2, `expected a small edge, got ${ratio}`);
});

test("lossless outranks any lossy offer regardless of bitrate", () => {
  const cd = audio("deezer", "flac");
  for (const offer of [lossy("opus", 320), lossy("aac", 320), audio("tidal", "high")]) {
    assert.ok(compareAudioFidelity(cd, offer) > 0);
  }
  assert.equal(lossyQualityScore(cd), null, "lossless has no lossy score");
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
  assert.ok(compareAudioFidelity(
    audio("tidal", "stereo:hires-lossless"), audio("tidal", "spatial:atmos"),
  ) > 0, "on fidelity alone, hi-res wins");
});

/* ── Video: resolution, then bitrate scaled by codec ────────────────── */

const shot = (
  codec: VideoFacts["codec"], heightPx: number, bitrateKbps: number | null = null,
): VideoFacts => ({
  ...video("tidal", "fhd"), codec, heightPx, bitrateKbps,
});

test("resolution dominates the codec", () => {
  // A better encoder cannot recover detail the resolution never carried.
  assert.ok(compareVideoQuality(shot("h264", 1080), shot("av1", 720)) > 0);
});

test("with no bitrate known, the better codec wins at equal resolution", () => {
  // The catalogue-time case: a provider's encodes at one tier are broadly
  // comparable in bitrate, so VP9 over H.264 is the right guess.
  assert.ok(compareVideoQuality(shot("vp9", 1080), shot("h264", 1080)) > 0);
  assert.ok(compareVideoQuality(shot("av1", 1080), shot("vp9", 1080)) > 0);
});

test("a known bitrate outranks the codec preference", () => {
  // The ordering the previous comparator got wrong: consulting the codec before
  // the bitrate says a starved AV1 stream beats a generous H.264 one.
  assert.ok(
    compareVideoQuality(shot("h264", 1080, 10_000), shot("av1", 1080, 500)) > 0,
    "1080p H.264 at 10 Mbps beats 1080p AV1 at 500 kbps",
  );
  // And at comparable bitrates the efficient codec still wins.
  assert.ok(compareVideoQuality(shot("av1", 1080, 4000), shot("h264", 1080, 4000)) > 0);
  // AV1's efficiency means it needs fewer bits for the same result.
  assert.ok(compareVideoQuality(shot("av1", 1080, 3000), shot("h264", 1080, 4000)) > 0);
});

test("HDR ranks below what the picture actually carries", () => {
  // Whether HDR is wanted is a profile question — some devices cannot use it —
  // exactly as immersive audio is.
  const base = shot("av1", 2160, 20_000);
  assert.ok(compareVideoQuality({ ...base, hdr: true }, { ...base, hdr: false }) > 0);
  assert.ok(
    compareVideoQuality({ ...base, hdr: false }, { ...shot("av1", 2160, 5000), hdr: true }) > 0,
    "a much higher bitrate still wins over an HDR flag",
  );
});

test("video tiers name the codec our downloader actually gets", () => {
  // yt-dlp's own format preference ranks AV1 above VP9 above H.264, so on
  // YouTube we expect VP9 or better; TIDAL and Apple serve H.264 at 1080p.
  assert.equal(video("youtube-music", "fhd").codec, "vp9");
  assert.equal(video("tidal", "fhd").codec, "h264");
  assert.equal(video("apple-music", "uhd").codec, "hevc");
  assert.equal(videoFactsLabel(video("youtube-music", "fhd")), "VP9 · 1080p");
  // And that is exactly the 1080p VP9 over 1080p H.264 case.
  assert.ok(compareVideoQuality(video("youtube-music", "fhd"), video("tidal", "fhd")) > 0);
});

test("an unmapped video provider or tier resolves to nothing", () => {
  assert.equal(expectedVideoFactsForProviderTier("deezer", "fhd"), null);
  assert.equal(expectedVideoFactsForProviderTier("tidal", "uhd"), null);
});

test("the resolution class comes from the height, never from the tier name", () => {
  assert.equal(videoQualityClassOf(shot("vp9", 480)), "sd");
  assert.equal(videoQualityClassOf(video("youtube-music", "fhd")), "fhd");
});
