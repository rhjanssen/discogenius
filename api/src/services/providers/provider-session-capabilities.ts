/**
 * What each provider session can currently reach.
 *
 * Some expected facts depend on the account rather than the catalogue —
 * YouTube Music's 256 kbps tier is a Premium feature, so the same track is a
 * different expectation on a different login. That is a property of the
 * session, so it is probed once when the session is established and published
 * here.
 *
 * A registry rather than a parameter because the three places that persist
 * variants (`refresh-artist`, `refresh-album`, provider ingestion) hold only a
 * provider id, and threading an entitlement through all of them would put a
 * YouTube concern into two services that have nothing to do with YouTube.
 *
 * Empty is the honest default: a provider that has published nothing gets the
 * base expectation, which under-promises rather than over-promises.
 */
import type { ProviderSessionCapabilities } from "./audio-facts.js";

const byProvider = new Map<string, ProviderSessionCapabilities>();

export function publishProviderSessionCapabilities(
  provider: string,
  capabilities: ProviderSessionCapabilities,
): void {
  byProvider.set(String(provider || "").trim().toLowerCase(), capabilities);
}

export function getProviderSessionCapabilities(
  provider: string | null | undefined,
): ProviderSessionCapabilities {
  return byProvider.get(String(provider || "").trim().toLowerCase()) ?? {};
}

export function clearProviderSessionCapabilities(provider?: string): void {
  if (provider == null) {
    byProvider.clear();
    return;
  }
  byProvider.delete(String(provider).trim().toLowerCase());
}
