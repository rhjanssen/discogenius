export interface ArtistMetadataScanPolicy {
  hydrateCatalog?: boolean;
  hydrateAlbumTracks?: boolean;
  monitorAlbums?: boolean;
}

export interface ArtistMetadataScanState {
  hasManagedMetadata?: boolean;
}

function resolveScanFlag(
  explicitValue: boolean | undefined,
  legacyValue: boolean | undefined,
  defaultValue: boolean,
): boolean {
  if (explicitValue !== undefined) {
    return explicitValue;
  }

  if (legacyValue !== undefined) {
    return legacyValue;
  }

  return defaultValue;
}

export function shouldHydrateArtistAlbumTracks(policy: ArtistMetadataScanPolicy): boolean {
  return resolveScanFlag(policy.hydrateAlbumTracks, policy.monitorAlbums, true);
}

export function shouldHydrateArtistCatalog(
  policy: ArtistMetadataScanPolicy,
  state: ArtistMetadataScanState,
): boolean {
  return resolveScanFlag(policy.hydrateCatalog, policy.monitorAlbums, true) || state.hasManagedMetadata !== true;
}
