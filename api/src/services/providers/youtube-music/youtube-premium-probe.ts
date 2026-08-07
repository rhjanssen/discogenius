/**
 * Whether the configured YouTube session is Premium.
 *
 * Google publishes YouTube Music's tiers as Low ≤48, Normal ≤128 and High ≤256
 * kbps, and the higher ones are a Premium feature. That single bit is the only
 * thing that moves our expectation for a YouTube offer between ~128 and ~256
 * kbps, so it is worth knowing — and it is a property of the *login*, not of a
 * track, so it is probed once when the session is established rather than per
 * item. Probing per track would be a request per track for something that does
 * not vary.
 *
 * yt-dlp already determines this: with authenticated cookies it selects a
 * different player-client combination for Premium accounts and says so in
 * verbose output. Asking it is cheaper and more truthful than inferring an
 * entitlement from `ytmusicapi`, whose account-info response documents only a
 * name, handle and profile image.
 *
 * A failed or unauthenticated probe reports `false`, never throws, and never
 * blocks: not knowing the entitlement is the same as not having it for
 * expectation purposes, and being wrong here costs a slightly pessimistic
 * quality estimate rather than a failed download.
 */
import { spawn } from "node:child_process";

/** yt-dlp prints this on a Premium login. */
const PREMIUM_MARKER = /Detected YouTube Premium subscription/i;

/** A cheap public video; we only ever read the client-selection log lines. */
const PROBE_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const PROBE_TIMEOUT_MS = 20_000;

export interface YouTubeSessionCapabilities {
  authenticated: boolean;
  /** Null when the probe could not run; treated as non-Premium downstream. */
  premium: boolean | null;
  checkedAt: string;
}

let cached: YouTubeSessionCapabilities | null = null;

/**
 * Run yt-dlp in simulate mode and read whether it announced Premium.
 *
 * `--simulate` means no media is fetched — this is one metadata request, not a
 * download.
 */
async function probe(binary: string, extraArgs: readonly string[]): Promise<boolean | null> {
  return await new Promise<boolean | null>((resolve) => {
    let settled = false;
    const finish = (value: boolean | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let output = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, [...extraArgs, "--verbose", "--simulate", "--no-warnings", PROBE_URL], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish(null);
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, PROBE_TIMEOUT_MS);

    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      // The marker appears early; stop as soon as it does.
      if (PREMIUM_MARKER.test(output)) {
        clearTimeout(timer);
        child.kill();
        finish(true);
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish(PREMIUM_MARKER.test(output) ? true : false);
    });
  });
}

/**
 * The session's capabilities, probed once and cached until invalidated.
 *
 * `authenticated` is supplied by the caller because the provider already knows
 * it; an unauthenticated session is never Premium, so the probe is skipped
 * entirely in that case.
 */
export async function getYouTubeSessionCapabilities(input: {
  authenticated: boolean;
  binary: string;
  extraArgs?: readonly string[];
  now?: () => Date;
}): Promise<YouTubeSessionCapabilities> {
  if (cached) return cached;
  const checkedAt = (input.now?.() ?? new Date()).toISOString();
  if (!input.authenticated) {
    cached = { authenticated: false, premium: false, checkedAt };
    return cached;
  }
  const premium = await probe(input.binary, input.extraArgs ?? []);
  cached = { authenticated: true, premium, checkedAt };
  return cached;
}

/** Call when credentials change, so the next read re-probes. */
export function invalidateYouTubeSessionCapabilities(): void {
  cached = null;
}

/**
 * The capability flag the facts model consumes.
 *
 * A null probe resolves to false: an unknown entitlement is treated as absent,
 * which under-promises rather than over-promises the expected quality.
 */
export function youtubePremiumForExpectations(
  capabilities: YouTubeSessionCapabilities | null,
): boolean {
  return capabilities?.premium === true;
}
