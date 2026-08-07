/**
 * Provider-neutral audio facts: one representative expectation per tier.
 *
 * The old model stored a library-shaped answer — `lossless`, `spatial` — as the
 * fundamental identity of an offer. Spatial is not a fidelity tier, so a
 * profile could never say "Atmos above 24-bit stereo" while `spatial` sat
 * inside the same ladder as `hires-lossless`. Fidelity and presentation are
 * separate axes here for that reason.
 *
 * What a tier tells us is a *category*, not a measurement — a provider tags an
 * album `lossless` and nothing finer. So each tier maps to the quality we
 * expect to actually receive, taking into account how our downloader for that
 * provider behaves. Two examples of why that beats modelling the theoretical
 * ceiling:
 *
 *  - Apple Lossless can technically reach 24-bit/48 kHz, but the overwhelming
 *    majority of it is CD. Recording the ceiling would file nearly all Apple
 *    lossless material as hi-res and push it into MAX profiles it does not
 *    belong in.
 *  - YouTube publishes every tier as "AAC or Opus", but yt-dlp prefers Opus
 *    when it is offered, so Opus is what we expect — and Premium is what
 *    decides whether that is ~128 or ~256 kbps.
 *
 * These are approximations, deliberately. The file that lands is measured by
 * ffprobe and stored exactly; when it differs slightly from the expectation
 * that is fine and expected, and the offer is *not* rewritten from it. One
 * album arriving at 24/48 does not make a provider's whole lossless tier
 * hi-res, and letting a single download redefine a tier would make planning
 * depend on acquisition order.
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

  channelCount: number | null;
  channelLayout: string | null;

  immersiveFormat: ImmersiveFormat | null;
  objectAudio: boolean | null;
}

const EMPTY: AudioFacts = {
  evidenceSource: "provider-catalog",
  confidence: "expected",
  codec: null, codecProfile: null, container: null,
  lossless: null, bitDepth: null, sampleRateHz: null, bitrateKbps: null,
  channelCount: null, channelLayout: null,
  immersiveFormat: null, objectAudio: null,
};

function expected(facts: Partial<AudioFacts>): AudioFacts {
  return { ...EMPTY, ...facts, confidence: "expected", evidenceSource: "provider-catalog" };
}

/* ── What each provider's tier is expected to deliver ───────────────── */

/** A stereo pair, which every non-immersive tier is. */
const STEREO = { channelCount: 2, channelLayout: "2.0" };

/**
 * Dolby Atmos as both TIDAL and Apple actually deliver it.
 *
 * E-AC-3 with Joint Object Coding — "Dolby Digital Plus with Dolby Atmos"
 * commercially — over a 5.1 bed at 48 kHz. Observed from real downloads from
 * both services rather than assumed from the badge.
 */
const DOLBY_ATMOS = {
  codec: "eac3" as const, codecProfile: "joc", container: "m4a",
  lossless: false, sampleRateHz: 48000, bitrateKbps: 768,
  channelCount: 6, channelLayout: "5.1",
  immersiveFormat: "dolby-atmos" as const, objectAudio: true,
};

/** CD, and the hi-res rate most commonly served where a range is offered. */
const CD = { lossless: true, bitDepth: 16, sampleRateHz: 44100 };
const HI_RES = { lossless: true, bitDepth: 24, sampleRateHz: 96000 };

/**
 * Keyed by our own `presentation:fidelity` variant vocabulary, plus each
 * provider's own tier names where a backend uses them.
 *
 * Values are what we expect to *receive*, which is the provider's tier read
 * through our downloader for it. See the note at the top of the file on why
 * that beats recording each tier's theoretical maximum.
 */
const PROVIDER_TIER_FACTS: Record<string, Record<string, AudioFacts>> = {
  tidal: {
    // tiddl asks TIDAL for a playback quality and gets that stream back; it
    // does not fetch lossless and re-encode. So these are real alternatives.
    low: expected({ codec: "aac", container: "m4a", lossless: false, bitrateKbps: 96, ...STEREO }),
    high: expected({ codec: "aac", container: "m4a", lossless: false, bitrateKbps: 320, ...STEREO }),
    lossless: expected({ codec: "flac", container: "flac", ...CD, ...STEREO }),
    hi_res_lossless: expected({ codec: "flac", container: "m4a", ...HI_RES, ...STEREO }),
    dolby_atmos: expected(DOLBY_ATMOS),
  },
  "apple-music": {
    lossy: expected({ codec: "aac", container: "m4a", lossless: false, bitrateKbps: 256, ...STEREO }),
    // The backend asks for `--alac-max 48000` here. Apple Lossless can reach
    // 24/48, but the catalogue is overwhelmingly CD and calling the tier
    // hi-res would file almost all of it into MAX.
    lossless: expected({ codec: "alac", container: "m4a", ...CD, ...STEREO }),
    "hires-lossless": expected({ codec: "alac", container: "m4a", ...HI_RES, ...STEREO }),
    atmos: expected(DOLBY_ATMOS),
  },
  deezer: {
    mp3_128: expected({ codec: "mp3", lossless: false, bitrateKbps: 128, ...STEREO }),
    mp3_320: expected({ codec: "mp3", lossless: false, bitrateKbps: 320, ...STEREO }),
    flac: expected({ codec: "flac", container: "flac", ...CD, ...STEREO }),
  },
  "amazon-music": {
    standard: expected({ codec: "aac", container: "m4a", lossless: false, bitrateKbps: 256, ...STEREO }),
    hd: expected({ codec: "flac", container: "flac", ...CD, ...STEREO }),
    ultra_hd: expected({ codec: "flac", container: "flac", ...HI_RES, ...STEREO }),
    atmos: expected(DOLBY_ATMOS),
    // 360 Reality Audio is MPEG-H 3D Audio (ISO/IEC 23008-3), purely
    // object-based — not MQA, which is an unrelated lossy-in-lossless scheme.
    "360ra": expected({
      codec: "mpegh", codecProfile: "3d-audio", lossless: false, sampleRateHz: 48000,
      immersiveFormat: "sony-360ra", objectAudio: true,
    }),
  },
  spotify: {
    // Votify can request Vorbis, AAC or FLAC; Vorbis 320 is the representative
    // stereo stream, and Spotify's newer lossless tier is FLAC at CD.
    low: expected({ codec: "vorbis", container: "ogg", lossless: false, bitrateKbps: 96, ...STEREO }),
    normal: expected({ codec: "vorbis", container: "ogg", lossless: false, bitrateKbps: 160, ...STEREO }),
    high: expected({ codec: "vorbis", container: "ogg", lossless: false, bitrateKbps: 320, ...STEREO }),
    lossless: expected({ codec: "flac", container: "flac", ...CD, ...STEREO }),
  },
  "youtube-music": {
    // Google publishes each tier as "AAC or Opus"; yt-dlp prefers Opus wherever
    // it is offered, so Opus is what we expect. Premium is what decides the
    // rate — see `expectedFactsForProviderTier`.
    normal: expected({ codec: "opus", container: "webm", lossless: false, bitrateKbps: 128, ...STEREO }),
    high: expected({ codec: "opus", container: "webm", lossless: false, bitrateKbps: 256, ...STEREO }),
  },
  soundcloud: {
    // SoundCloud publishes standard as MP3 128 and Go+ as AAC 256, which it
    // equates to MP3 320.
    standard: expected({ codec: "mp3", lossless: false, bitrateKbps: 128, ...STEREO }),
    high: expected({ codec: "aac", container: "m4a", lossless: false, bitrateKbps: 256, ...STEREO }),
  },
};

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
  deezer: { "stereo:lossy": "mp3_320", "stereo:lossless": "flac" },
  "amazon-music": {
    "stereo:lossy": "standard",
    "stereo:lossless": "hd",
    "stereo:hires-lossless": "ultra_hd",
    "spatial:atmos": "atmos",
    "spatial:360ra": "360ra",
  },
  spotify: { "stereo:lossy": "high", "stereo:lossless": "lossless" },
  // Resolved against the session's entitlement below, not fixed here.
  "youtube-music": { "stereo:lossy": "normal" },
  soundcloud: { "stereo:lossy": "standard" },
};

/**
 * What the account can reach, where that changes what we expect to receive.
 *
 * Probed once when a provider session is established, not per track — the
 * entitlement is a property of the login, and asking per track would be a
 * request per track for information that does not vary.
 */
export interface ProviderSessionCapabilities {
  /** yt-dlp reports "Detected YouTube Premium subscription" on a Premium login. */
  youtubePremium?: boolean;
}

/**
 * The facts a provider's tier is expected to deliver, or null when the pairing
 * is unknown. Returns a copy, so callers may layer observations on top.
 */
export function expectedFactsForProviderTier(
  provider: string | null | undefined,
  tierOrVariantKey: string | null | undefined,
  capabilities: ProviderSessionCapabilities = {},
): AudioFacts | null {
  const providerKey = String(provider || "").trim().toLowerCase();
  const raw = String(tierOrVariantKey || "").trim().toLowerCase();
  if (!providerKey || !raw) return null;
  const tiers = PROVIDER_TIER_FACTS[providerKey];
  if (!tiers) return null;

  let tier = VARIANT_KEY_TO_TIER[providerKey]?.[raw] ?? raw;
  // Premium is the difference between ~128 and ~256 kbps on YouTube Music, and
  // it is the only thing that decides it.
  if (providerKey === "youtube-music" && tier === "normal" && capabilities.youtubePremium) {
    tier = "high";
  }
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
  const betterThanCd = (facts.bitDepth != null && facts.bitDepth > 16)
    || (facts.sampleRateHz != null && facts.sampleRateHz > 44100);
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
  if (facts.sampleRateHz != null) parts.push(formatKhz(facts.sampleRateHz));
  if (facts.bitrateKbps != null) parts.push(`${facts.bitrateKbps} kbps`);

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
  return merged;
}

/* ── Comparing offers across providers ──────────────────────────────── */

/**
 * Coding efficiency relative to AAC-LC, and how much it still matters.
 *
 * Bitrate alone does not order lossy offers: 128 kbps Opus is not 128 kbps MP3.
 * The evidence for the ordering is solid — Hydrogenaudio's 96 kbps multiformat
 * listening test put Opus ahead of Apple AAC ahead of MP3 and Vorbis, with the
 * MP3 entry consuming roughly 30 kbps more than its nominal rate — but the
 * Opus project itself warns against reading precise bitrate equivalences off
 * those curves.
 *
 * So the advantage tapers. Codec efficiency is decisive where bits are scarce
 * and much less so approaching transparency, where the differences are
 * listener-, material- and encoder-dependent. These factors encode the observed
 * *ordering*; the tests assert that ordering and never the numbers.
 */
const CODEC_EFFICIENCY_AT_LOW_BITRATE: Partial<Record<AudioCodec, number>> = {
  opus: 1.25,
  aac: 1.0,
  vorbis: 0.95,
  mp3: 0.8,
  eac3: 1.0,
  ac3: 0.7,
};

/** Where the advantage has largely tapered out. */
const TAPER_FLOOR_KBPS = 96;
const TAPER_CEILING_KBPS = 320;

/**
 * A comparable score for lossy offers; null for lossless.
 *
 * Deliberately *not* called a bitrate. "196 AAC-equivalent kbps" sounds far
 * more measurable than it is, and naming it that way invites callers to treat a
 * coarse ranking heuristic as a conversion. It orders offers and nothing else.
 *
 */
export function lossyQualityScore(facts: AudioFacts): number | null {
  if (facts.lossless !== false) return null;
  const bitrate = facts.bitrateKbps;
  if (bitrate == null) return null;
  // An unknown codec is scored at parity rather than penalised: YouTube's tiers
  // genuinely do not say, and guessing either way would be an invention.
  const lowRateFactor = facts.codec ? CODEC_EFFICIENCY_AT_LOW_BITRATE[facts.codec] ?? 1 : 1;
  const taper = Math.min(1, Math.max(0,
    (bitrate - TAPER_FLOOR_KBPS) / (TAPER_CEILING_KBPS - TAPER_FLOOR_KBPS)));
  const factor = lowRateFactor + (1 - lowRateFactor) * taper;
  return Math.round(bitrate * factor);
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
    return (lossyQualityScore(left) ?? 0) - (lossyQualityScore(right) ?? 0);
  }
  const depth = (left.bitDepth ?? 0) - (right.bitDepth ?? 0);
  if (depth !== 0) return depth;
  return (left.sampleRateHz ?? 0) - (right.sampleRateHz ?? 0);
}

/* ── Reading an acquired file back as facts ─────────────────────────── */

/** The audio columns a `TrackFiles` row carries, as ffprobe filled them. */
export interface ProbedFileRow {
  codec?: string | null;
  container?: string | null;
  bitrate?: number | null;
  sample_rate?: number | null;
  bit_depth?: number | null;
  channel_count?: number | null;
  channel_layout?: string | null;
}

const CODEC_ALIASES: Record<string, AudioCodec> = {
  "aac": "aac", "mp4a": "aac", "he-aac": "aac",
  "mp3": "mp3", "mp3float": "mp3",
  "vorbis": "vorbis", "opus": "opus",
  "flac": "flac", "alac": "alac", "pcm_s16le": "pcm", "pcm_s24le": "pcm",
  "eac3": "eac3", "ec-3": "eac3", "ac3": "ac3",
  "mpegh": "mpegh", "mhm1": "mpegh",
};

const LOSSLESS_CODECS = new Set<AudioCodec>(["flac", "alac", "pcm"]);

/**
 * The facts of a file that exists, read from its stored probe.
 *
 * This is the other half of the model, and the only place `observed` comes
 * from. It exists so the same comparisons that ranked an offer can be applied
 * to what actually landed — deciding whether a file already satisfies a
 * profile, or whether a better offer is worth an upgrade — without a second
 * quality vocabulary for files.
 *
 * `lossless` is inferred from the codec rather than trusted from a column: a
 * probe reports what the stream is, and FLAC is lossless whatever anything else
 * claims.
 */
export function observedFactsFromFile(row: ProbedFileRow): AudioFacts {
  const rawCodec = String(row.codec || "").trim().toLowerCase();
  const codec = CODEC_ALIASES[rawCodec] ?? null;
  const channelCount = row.channel_count ?? null;
  return {
    evidenceSource: "file-probe",
    confidence: "observed",
    codec,
    codecProfile: null,
    container: row.container ?? null,
    lossless: codec == null ? null : LOSSLESS_CODECS.has(codec),
    bitDepth: row.bit_depth ?? null,
    sampleRateHz: row.sample_rate ?? null,
    bitrateKbps: row.bitrate ?? null,
    channelCount,
    channelLayout: row.channel_layout ?? null,
    // E-AC-3 beyond stereo is how both TIDAL and Apple deliver Atmos; a probe
    // cannot see the object metadata, so the codec and channel count are the
    // evidence available.
    immersiveFormat: codec === "eac3" && (channelCount ?? 0) > 2 ? "dolby-atmos" : null,
    objectAudio: null,
  };
}

/**
 * Does a file already deliver what an offer would?
 *
 * Returns true when the file is at least as good, which is the question an
 * upgrade decision asks — not whether they are identical, because a file that
 * arrived better than its tier promised is not a reason to re-download.
 */
export function fileSatisfiesOffer(file: AudioFacts, offer: AudioFacts): boolean {
  return compareAudioFidelity(file, offer) >= 0;
}
