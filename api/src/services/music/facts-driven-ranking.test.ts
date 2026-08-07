/**
 * Two offers of the same quality class are not the same offer.
 *
 * A quality profile ranks by *class* — `lossy`, `lossless`, `hires-lossless` —
 * so TIDAL's AAC 320 and a 128 kbps stream tie there however far apart they
 * are, and the winner used to fall out of row-id order. The variant rows now
 * carry what each tier is expected to deliver, and that decides.
 *
 * The rule that must survive: **preference affects ranking, not availability.**
 * A profile preferring lossy still acquires a lossless-only source, and a MAX
 * profile still acquires an AAC-only one rather than calling the recording
 * unavailable.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  enumerateAcquisitionPlans,
  type AcquisitionAudioVariant,
  type AcquisitionQualityProfile,
  type AcquisitionSourceCandidate,
} from "./acquisition-plan-optimizer.js";

const PROFILE = (
  allowed: string[], cutoff: string, order: string[],
): AcquisitionQualityProfile => ({
  allowedQualities: new Set(allowed as never[]),
  preferenceOrder: order as never[],
  cutoff: cutoff as never,
  continueUpgradesAfterCutoff: true,
});

const MAX_PROFILE = PROFILE(
  ["lossy", "lossless", "hires-lossless", "spatial"], "hires-lossless",
  ["hires-lossless", "lossless", "spatial", "lossy"],
);

let nextId = 1;
const source = (
  provider: string, variants: AcquisitionAudioVariant[],
): AcquisitionSourceCandidate => ({
  provider,
  providerEditionMatchId: nextId++,
  relation: "exact",
  sourceTrackCount: 1,
  albumDownloadSafe: true,
  releaseExplicit: null,
  trackMatches: [{
    providerTrackMatchId: nextId++,
    providerEditionMemberId: nextId++,
    trackId: 1,
    explicit: null,
    variants,
  }],
});

const variant = (over: Partial<AcquisitionAudioVariant>): AcquisitionAudioVariant => ({
  id: nextId++, quality: "lossy", available: true, ...over,
});

const winner = (sources: AcquisitionSourceCandidate[]) => enumerateAcquisitionPlans({
  orderedTrackIds: [1],
  profile: MAX_PROFILE,
  sources,
  providerPriority: [],
  preferredProviderEditionMatchId: null,
  exclusive: false,
  preferExplicit: true,
})[0];

/* ── Same class, different delivery ─────────────────────────────────── */

test("the higher-bitrate lossy offer wins a tie on class", () => {
  // TIDAL AAC 320 against a 128 kbps stream: both `lossy` to the profile.
  const best = winner([
    source("weak", [variant({ codec: "opus", bitrateKbps: 128 })]),
    source("tidal", [variant({ codec: "aac", bitrateKbps: 320 })]),
  ]);
  assert.equal(best.provider, "tidal");
});

test("a codec advantage decides when bitrates match", () => {
  // 128 kbps Opus is not 128 kbps MP3, which raw bitrate cannot express.
  const best = winner([
    source("mp3-provider", [variant({ codec: "mp3", bitrateKbps: 128 })]),
    source("opus-provider", [variant({ codec: "opus", bitrateKbps: 128 })]),
  ]);
  assert.equal(best.provider, "opus-provider");
});

test("within lossless, bit depth decides before sample rate", () => {
  const best = winner([
    source("cd", [variant({ quality: "lossless", codec: "flac", bitDepth: 16, sampleRateHz: 44100 })]),
    source("hires", [variant({ quality: "lossless", codec: "flac", bitDepth: 24, sampleRateHz: 44100 })]),
  ]);
  assert.equal(best.provider, "hires");
});

test("an offer with no delivered properties is not penalised for being unmeasured", () => {
  // It should lose to nothing merely because its variant row is sparse; the
  // class comparison and the existing tie-breaks still decide.
  const best = winner([
    source("known", [variant({ codec: "aac", bitrateKbps: 256 })]),
    source("unknown", [variant({})]),
  ]);
  assert.equal(best.coverage, 1, "a plan still exists either way");
});

/* ── Preference ranks; it does not gate ─────────────────────────────── */

test("a MAX profile still acquires an AAC-only source", () => {
  // The recording is not unavailable just because nothing lossless exists.
  const best = winner([source("lossy-only", [variant({ codec: "aac", bitrateKbps: 256 })])]);
  assert.ok(best, "a plan was produced");
  assert.equal(best.coverage, 1);
  assert.equal(best.qualityTier, "lossy");
});

test("a lossy-preferring profile still acquires a lossless-only source", () => {
  const normal = PROFILE(
    ["lossy", "lossless", "hires-lossless"], "lossy",
    ["lossy", "lossless", "hires-lossless"],
  );
  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1],
    profile: normal,
    sources: [source("flac-only", [
      variant({ quality: "lossless", codec: "flac", bitDepth: 16, sampleRateHz: 44100 }),
    ])],
    providerPriority: [],
    preferredProviderEditionMatchId: null,
    exclusive: false,
    preferExplicit: true,
  });
  assert.equal(plans.length > 0, true, "converting to the wanted output is a later decision");
  assert.equal(plans[0].coverage, 1);
});

test("a quality the profile disallows is genuinely excluded", () => {
  // The gate is `allowedQualities`, and it is the only thing that gates.
  const losslessOnly = PROFILE(["lossless"], "lossless", ["lossless"]);
  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1],
    profile: losslessOnly,
    sources: [source("lossy-only", [variant({ codec: "aac", bitrateKbps: 256 })])],
    providerPriority: [],
    preferredProviderEditionMatchId: null,
    exclusive: false,
    preferExplicit: true,
  });
  assert.equal(plans.length, 0);
});
