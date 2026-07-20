import type { StreamingProvider } from "./streaming-provider.js";

/**
 * Whether Discogenius can complete any connection step for this provider.
 *
 * Credential-based providers intentionally use `auth.kind = external`: the
 * credential itself comes from the provider's site, but Discogenius still owns
 * the form and persistence step through `saveCredentials`. Consequently,
 * `managedByApp` must not hide those providers from the connection UI.
 */
export function providerSupportsAppAuthentication(provider: StreamingProvider): boolean {
  if (provider.manifest?.auth.comingSoon) return false;
  return providerSupportsDeviceAuthentication(provider) || Boolean(provider.saveCredentials);
}

/** Device login is a narrower capability and still honours the manifest flag. */
export function providerSupportsDeviceAuthentication(provider: StreamingProvider): boolean {
  return Boolean(provider.manifest?.auth.managedByApp && provider.startDeviceLogin);
}
