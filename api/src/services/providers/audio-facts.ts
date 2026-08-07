/**
 * Provider-neutral audio facts, and what each provider's tier claims.
 *
 * The old model stored a library-shaped answer — `lossless`, `spatial` — as the
 * fundamental identity of an offer. Two things are wrong with that. Spatial is
 * not a fidelity tier, so a profile can never say "Atmos above 24-bit stereo"
 * while `spatial` sits inside the same ladder as `hires-lossless`. And a
 * provider badge is not a measurement: "Hi-Res Lossless" means *up to* 24/192,
 * not 24/192.
 *
 * So facts are stored with two dimensions the old model conflated —
 * **fidelity** (how much of the signal survived) and **presentation** (how many
 * channels, and whether objects) — plus the provenance of how we learned them.
 *
 *     expected   what the provider's tier implies — all we have when planning
 *     observed   what ffprobe read off the imported file
 *
 * An expectation may state a ceiling (`sampleRateHzMax`) where a measurement
 * states a value (`sampleRateHz`). Nothing renders a ceiling as if it were
 * measured: TIDAL Hi-Res shows "FLAC 24-bit up to 192 kHz", never
 * "FLAC 24-bit 192 kHz".
 *
 * Dolby Atmos is deliberately not given a channel layout until one is observed.
 * The delivery codec is E-AC-3 with Joint Object Coding — "Dolby Digital Plus
 * with Dolby Atmos" commercially — and JOC codes objects over a bed. Calling a
 * provider claim "5.1" states a layout the claim does not make; Apple's own HLS
 * signalling is `ec-3` with `CHANNELS="16/JOC"`, which is an object count, not
 * a speaker count.
 */

/**
 * How a fact was learned. There are exactly two states, deliberately.
 *
 * Before a file exists we have the provider's quality tier and nothing better —
 * planning and curation run entirely on that. Once a file exists we can read
 * it. A manifest sits between the two and was modelled at first, but it earns
 * nothing: it arrives too late to inform planning and is superseded the moment
 * the file lands. Two states keep every consumer honest about which it has.
 */
export type AudioEvidenceSource =
  | "provider-catalog"    // the tier badge; all acquisition planning uses this
  | "file-probe";         // ffprobe/TagLib on the imported file

/** Whether the numbers are implied by a tier or measured from the audio. */
export type AudioConfidence = "expected" | "observed";

export type AudioCodec =
  | "aac" | "mp3" | "vorbis" | "opus"        // lossy
  | "flac" | "alac" | "pcm"                  // lossless
  | "eac3" | "ac3"                           // lossy, and how Atmos is delivered
  | "mpegh"                                  // MPEG-H 3D Audio, how 360RA is delivered
  | "mqa";                                   // lossy-in-a-lossless-container

export type ImmersiveFormat = "dolby-atmos" | "sony-360ra";

/** How much of the signal survived encoding. Spatial is deliberately absent. */
export type FidelityClass = "lossy" | "lossless" | "hires-lossless";

/** How many channels, and whether objects. Independent of fidelity. */
export type PresentationClass = "stereo" | "multichannel" | "immersive";

export interface AudioFacts {
  evidenceSource: AudioEvidenceSource;
  confidence: AudioConfidence;

  codec: AudioCodec | null;
  /** `joc` for Atmos-bearing E-AC-3; `he-aac` etc. where it matters. */
  codecProfile: string | null;
  container: string | null;

  lossless: boolean | null;
  bitDepth: number | null;
  sampleRateHz: number | null;
  bitrateKbps: number | null;

  /** Ceilings, meaningful only for expectations. Never rendered as a value. */
  bitDepthMax: number | null;
  sampleRateHzMax: number | null;
  bitrateKbpsMax: number | null;

  channelCount: number | null;
  /** `2.0`, `5.1` — only ever set from a measurement. */
  channelLayout: string | null;

  immersiveFormat: ImmersiveFormat | null;
  objectAudio: boolean | null;
}

const EMPTY: AudioFacts = {
  evidenceSource: "provider-catalog",
  confidence: "expected",
  codec: null, codecProfile: null, container: null,
  lossless: null, bitDepth: null, sampleRateHz: null, bitrateKbps: null,
  bitDepthMax: null, sampleRateHzMax: null, bitrateKbpsMax: null,
  channelCount: null, channelLayout: null,
  immersiveFormat: null, objectAudio: null,
};

function expected(facts: Partial<AudioFacts>): AudioFacts {
  return { ...EMPTY, ...facts, confidence: "expected", evidenceSource: "provider-catalog" };
}

/* ── What each provider's tier claims ───────────────────────────────── */

/**
 * Keys are the provider's own tier vocabulary, lower-cased. Values are what
 * that tier *implies*, never what a given track is — that is what `observed`
 * facts are for.
 *
 * Sources are each provider's published specification. Where a provider
 * publishes a range ("up to 24-bit/192 kHz") it is stored as a ceiling.
 */
const PROVIDER_TIER_FACTS: Record<string, Record<string, AudioFacts>> = {
  tidal: {
    // AAC, and the two historic ceilings.
    low: expected({ codec: "aac", lossless: false, bitrateKbpsMax: 96, channelCount: 2 }),
    high: expected({ codec: "aac", lossless: false, bitrateKbpsMax: 320, channelCount: 2 }),
    lossless: expected({
      codec: "flac", container: "flac", lossless: true,
      bitDepth: 16, sampleRateHz: 44100, channelCount: 2,
    }),
    hi_res_lossless: expected({
      codec: "flac", container: "flac", lossless: true,
      bitDepth: 24, sampleRateHzMax: 192000, channelCount: 2,
    }),
    dolby_atmos: expected({
      codec: "eac3", codecProfile: "joc", lossless: false,
      immersiveFormat: "dolby-atmos", objectAudio: true,
    }),
  },
  "apple-music": {
    // Apple publishes AAC 256 for the lossy tier and ALAC for both lossless
    // tiers; Hi-Res Lossless reaches 24-bit/192 kHz.
    lossy: expected({ codec: "aac", lossless: false, bitrateKbps: 256, channelCount: 2 }),
    lossless: expected({
      codec: "alac", container: "m4a", lossless: true,
      bitDepth: 16, sampleRateHz: 44100, channelCount: 2,
    }),
    "hires-lossless": expected({
      codec: "alac", container: "m4a", lossless: true,
      bitDepth: 24, sampleRateHzMax: 192000, channelCount: 2,
    }),
    atmos: expected({
      codec: "eac3", codecProfile: "joc", lossless: false,
      immersiveFormat: "dolby-atmos", objectAudio: true,
    }),
  },
  deezer: {
    // No hi-res tier and no immersive tier.
    mp3_128: expected({ codec: "mp3", lossless: false, bitrateKbps: 128, channelCount: 2 }),
    mp3_320: expected({ codec: "mp3", lossless: false, bitrateKbps: 320, channelCount: 2 }),
    flac: expected({
      codec: "flac", container: "flac", lossless: true,
      bitDepth: 16, sampleRateHz: 44100, channelCount: 2,
    }),
  },
  "amazon-music": {
    // HD averages ~850 kbps, Ultra HD ~3730 kbps; both FLAC.
    standard: expected({ codec: "aac", lossless: false, bitrateKbpsMax: 256, channelCount: 2 }),
    hd: expected({
      codec: "flac", container: "flac", lossless: true,
      bitDepth: 16, sampleRateHz: 44100, channelCount: 2,
    }),
    ultra_hd: expected({
      codec: "flac", container: "flac", lossless: true,
      bitDepth: 24, sampleRateHzMax: 192000, channelCount: 2,
    }),
    atmos: expected({
      codec: "eac3", codecProfile: "joc", lossless: false,
      immersiveFormat: "dolby-atmos", objectAudio: true,
    }),
    // 360 Reality Audio is MPEG-H 3D Audio (ISO/IEC 23008-3), purely
    // object-based — not MQA, which is an unrelated lossy-in-lossless scheme.
    "360ra": expected({
      codec: "mpegh", codecProfile: "3d-audio", lossless: false,
      immersiveFormat: "sony-360ra", objectAudio: true,
    }),
  },
  spotify: {
    // Ogg Vorbis at the three published ceilings.
    low: expected({ codec: "vorbis", container: "ogg", lossless: false, bitrateKbpsMax: 96, channelCount: 2 }),
    normal: expected({ codec: "vorbis", container: "ogg", lossless: false, bitrateKbpsMax: 160, channelCount: 2 }),
    high: expected({ codec: "vorbis", container: "ogg", lossless: false, bitrateKbpsMax: 320, channelCount: 2 }),
  },
  "youtube-music": {
    low: expected({ codec: "opus", container: "webm", lossless: false, bitrateKbpsMax: 64, channelCount: 2 }),
    normal: expected({ codec: "opus", container: "webm", lossless: false, bitrateKbpsMax: 128, channelCount: 2 }),
    high: expected({ codec: "opus", container: "webm", lossless: false, bitrateKbpsMax: 256, channelCount: 2 }),
  },
  soundcloud: {
    // Free streams are Opus/MP3; Go+ adds AAC 256.
    low: expected({ codec: "opus", container: "ogg", lossless: false, bitrateKbpsMax: 64, channelCount: 2 }),
    standard: expected({ codec: "mp3", lossless: false, bitrateKbpsMax: 128, channelCount: 2 }),
    high: expected({ codec: "aac", lossless: false, bitrateKbpsMax: 256, channelCount: 2 }),
  },
};

/**
 * Our own persisted `variant_key` vocabulary — `presentation:fidelity`, e.g.
 * `stereo:hires-lossless` or `spatial:atmos` — mapped onto each provider's
 * tier names, so stored variants resolve without re-reading provider payloads.
 */
const VARIANT_KEY_TO_TIER: Record<string, Record<string, string>> = {
  tidal: {
    "stereo:lossy": "high",
    "stereo:lossless": "lossless",
    "stereo:hires-lossless": "hi_res_lossless",
    "spatial:atmos": "dolby_atmos",
  },
  "apple-music": {
    "stereo:lossy": "lossy",
    "stereo:lossless": "lossless",
    "stereo:hires-lossless": "hires-lossless",
    "spatial:atmos": "atmos",
  },
  deezer: {
    "stereo:lossy": "mp3_320",
    "stereo:lossless": "flac",
  },
  "amazon-music": {
    "stereo:lossy": "standard",
    "stereo:lossless": "hd",
    "stereo:hires-lossless": "ultra_hd",
    "spatial:atmos": "atmos",
    "spatial:360ra": "360ra",
  },
  spotify: { "stereo:lossy": "high" },
  "youtube-music": { "stereo:lossy": "high" },
  soundcloud: { "stereo:lossy": "standard" },
};

/**
 * The facts a provider's tier implies, or null when the pairing is unknown.
 *
 * Returns a copy, so callers may layer observations on top without mutating
 * the table.
 */
export function expectedFactsForProviderTier(
  provider: string | null | undefined,
  tierOrVariantKey: string | null | undefined,
): AudioFacts | null {
  const providerKey = String(provider || "").trim().toLowerCase();
  const raw = String(tierOrVariantKey || "").trim().toLowerCase();
  if (!providerKey || !raw) return null;
  const tiers = PROVIDER_TIER_FACTS[providerKey];
  if (!tiers) return null;
  const tier = VARIANT_KEY_TO_TIER[providerKey]?.[raw] ?? raw;
  const facts = tiers[tier];
  return facts ? { ...facts } : null;
}

/* ── Derived classifications ────────────────────────────────────────── */

/**
 * Fidelity from the facts, never from a provider's marketing name.
 *
 * Hi-res means better than CD on either axis. A ceiling counts: a tier that
 * *can* deliver 24-bit is a hi-res tier, which is what a profile targeting
 * hi-res is asking for.
 */
export function fidelityClassOf(facts: AudioFacts): FidelityClass | null {
  if (facts.lossless == null) return null;
  if (!facts.lossless) return "lossy";
  const bitDepth = facts.bitDepth ?? facts.bitDepthMax;
  const sampleRate = facts.sampleRateHz ?? facts.sampleRateHzMax;
  const betterThanCd = (bitDepth != null && bitDepth > 16)
    || (sampleRate != null && sampleRate > 44100);
  return betterThanCd ? "hires-lossless" : "lossless";
}

/**
 * Presentation from the facts.
 *
 * Object audio is immersive whatever its bed, and an unknown channel count on
 * a non-immersive offer is stereo — every provider's default, and the thing a
 * missing field means in practice.
 */
export function presentationClassOf(facts: AudioFacts): PresentationClass {
  if (facts.immersiveFormat != null || facts.objectAudio === true) return "immersive";
  if (facts.channelCount != null && facts.channelCount > 2) return "multichannel";
  return "stereo";
}

/* ── Display ────────────────────────────────────────────────────────── */

const CODEC_LABELS: Record<AudioCodec, string> = {
  aac: "AAC", mp3: "MP3", vorbis: "Vorbis", opus: "Opus",
  flac: "FLAC", alac: "ALAC", pcm: "PCM",
  eac3: "E-AC-3", ac3: "AC-3", mpegh: "MPEG-H 3D Audio", mqa: "MQA",
};

const IMMERSIVE_LABELS: Record<ImmersiveFormat, string> = {
  "dolby-atmos": "Dolby Atmos",
  "sony-360ra": "360 Reality Audio",
};

function formatKhz(hz: number): string {
  const khz = hz / 1000;
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
}

/**
 * A label that says exactly as much as the evidence supports.
 *
 * A claim reads "Dolby Digital Plus + Dolby Atmos"; a measurement reads
 * "E-AC-3 JOC · Dolby Atmos · 768 kbps · 48 kHz". Ceilings are printed with
 * "up to" so a tier is never mistaken for a measurement, and a channel layout
 * appears only when something measured it.
 */
export function audioFactsLabel(facts: AudioFacts): string {
  const parts: string[] = [];

  if (facts.immersiveFormat === "dolby-atmos") {
    // The commercial name of E-AC-3 + JOC, which is what a badge means.
    parts.push(facts.confidence === "observed" && facts.codec === "eac3"
      ? `E-AC-3${facts.codecProfile === "joc" ? " JOC" : ""}`
      : "Dolby Digital Plus");
    parts.push(IMMERSIVE_LABELS["dolby-atmos"]);
  } else if (facts.immersiveFormat != null) {
    if (facts.codec) parts.push(CODEC_LABELS[facts.codec]);
    parts.push(IMMERSIVE_LABELS[facts.immersiveFormat]);
  } else if (facts.codec) {
    parts.push(CODEC_LABELS[facts.codec]);
  }

  // Layout is a measurement or nothing — an Atmos badge does not claim 5.1.
  if (facts.channelLayout) parts.push(facts.channelLayout);

  if (facts.bitDepth != null) parts.push(`${facts.bitDepth}-bit`);
  else if (facts.bitDepthMax != null) parts.push(`up to ${facts.bitDepthMax}-bit`);

  if (facts.sampleRateHz != null) parts.push(formatKhz(facts.sampleRateHz));
  else if (facts.sampleRateHzMax != null) parts.push(`up to ${formatKhz(facts.sampleRateHzMax)}`);

  if (facts.bitrateKbps != null) parts.push(`${facts.bitrateKbps} kbps`);
  else if (facts.bitrateKbpsMax != null) parts.push(`up to ${facts.bitrateKbpsMax} kbps`);

  return parts.join(" · ");
}

/**
 * Layer a measurement over an expectation.
 *
 * Observations win field by field, and any ceiling the observation settles is
 * dropped — once a file is known to be 96 kHz, "up to 192 kHz" is noise. The
 * result's confidence is the stronger of the two.
 */
export function mergeAudioFacts(base: AudioFacts, observed: Partial<AudioFacts>): AudioFacts {
  const merged: AudioFacts = { ...base };
  for (const [key, value] of Object.entries(observed) as Array<[keyof AudioFacts, never]>) {
    if (value != null) merged[key] = value;
  }
  if (observed.confidence === "observed" || base.confidence === "observed") {
    merged.confidence = "observed";
  }
  if (merged.bitDepth != null) merged.bitDepthMax = null;
  if (merged.sampleRateHz != null) merged.sampleRateHzMax = null;
  if (merged.bitrateKbps != null) merged.bitrateKbpsMax = null;
  return merged;
}

/* ── Comparing offers across providers ──────────────────────────────── */

/**
 * Rough coding efficiency relative to AAC-LC at 1.0.
 *
 * Bitrate alone does not order lossy offers: Apple's AAC 256 and YouTube
 * Music's Opus 128 are much closer than 256-vs-128 suggests, because Opus
 * carries substantially more signal per bit. Ranking on the raw number would
 * overstate Apple's lead and understate Opus everywhere.
 *
 * These are ordering heuristics drawn from the broad consensus of public
 * listening tests, not measurements — the ordering they produce is what is
 * tested, never the individual numbers. Opus is the most efficient of the four
 * at these rates and MP3 the least.
 */
const CODEC_EFFICIENCY: Partial<Record<AudioCodec, number>> = {
  opus: 1.4,
  aac: 1.0,
  vorbis: 0.95,
  mp3: 0.75,
  // Atmos/360RA delivery codecs are compared by presentation, not by bitrate.
  eac3: 1.0,
  ac3: 0.7,
};

/**
 * A comparable "AAC-equivalent kbps" for lossy offers; null for lossless.
 *
 * Uses the ceiling when a tier only publishes one, because that is what the
 * tier offers and what the user is choosing between.
 */
export function perceptualBitrateKbps(facts: AudioFacts): number | null {
  if (facts.lossless !== false) return null;
  const bitrate = facts.bitrateKbps ?? facts.bitrateKbpsMax;
  if (bitrate == null || !facts.codec) return null;
  const efficiency = CODEC_EFFICIENCY[facts.codec];
  return efficiency == null ? bitrate : Math.round(bitrate * efficiency);
}

/** Fidelity order, independent of presentation. Higher is better. */
const FIDELITY_RANK: Record<FidelityClass, number> = {
  lossy: 0,
  lossless: 1,
  "hires-lossless": 2,
};

/**
 * Order two offers by what they actually deliver.
 *
 * Fidelity class first, then perceptual bitrate within lossy, then bit depth
 * and sample rate within lossless. Presentation is deliberately absent: whether
 * an immersive offer beats a hi-res stereo one is a *profile preference*, not a
 * property of the audio, and baking it in here is the conflation this model
 * exists to undo.
 *
 * Returns >0 when `left` is better, matching a descending comparator.
 */
export function compareAudioFidelity(left: AudioFacts, right: AudioFacts): number {
  const leftClass = fidelityClassOf(left);
  const rightClass = fidelityClassOf(right);
  if (leftClass !== rightClass) {
    return (leftClass ? FIDELITY_RANK[leftClass] : -1) - (rightClass ? FIDELITY_RANK[rightClass] : -1);
  }
  if (leftClass === "lossy") {
    return (perceptualBitrateKbps(left) ?? 0) - (perceptualBitrateKbps(right) ?? 0);
  }
  const depth = (left.bitDepth ?? left.bitDepthMax ?? 0) - (right.bitDepth ?? right.bitDepthMax ?? 0);
  if (depth !== 0) return depth;
  return (left.sampleRateHz ?? left.sampleRateHzMax ?? 0)
    - (right.sampleRateHz ?? right.sampleRateHzMax ?? 0);
}
