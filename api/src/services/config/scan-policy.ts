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
  defaultValue: boolean,
): boolean {
  if (explicitValue !== undefined) {
    return explicitValue;
  }

  return defaultValue;
}

export function shouldHydrateArtistAlbumTracks(policy: ArtistMetadataScanPolicy): boolean {
  return resolveScanFlag(policy.hydrateAlbumTracks, true);
}

export function shouldHydrateArtistCatalog(
  policy: ArtistMetadataScanPolicy,
  state: ArtistMetadataScanState,
): boolean {
  return resolveScanFlag(policy.hydrateCatalog, true) || state.hasManagedMetadata !== true;
}
