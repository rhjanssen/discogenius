import crypto from "node:crypto";

export const MAX_SIGNED_PLAYBACK_LIFETIME_SECONDS = 2 * 60 * 60;

export function getPlaybackSigningSecret(): string | null {
  return String(process.env.JWT_SECRET ?? "").trim() || null;
}

export function signPlaybackValue(value: string): string {
  const secret = getPlaybackSigningSecret();
  if (!secret) throw new Error("Playback signing secret is unavailable");
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

export function playbackSignatureMatches(actual: string, value: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(actual)) return false;
  const expected = signPlaybackValue(value);
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function parsePlaybackExpiration(raw: unknown, now = Math.floor(Date.now() / 1000)): number | null {
  const value = String(raw ?? "").trim();
  if (!/^\d{10}$/.test(value)) return null;
  const expires = Number(value);
  if (!Number.isSafeInteger(expires)
    || expires <= now
    || expires > now + MAX_SIGNED_PLAYBACK_LIFETIME_SECONDS) {
    return null;
  }
  return expires;
}
