export interface ArtistMetadataScanPolicy {
  monitorAlbums?: boolean;
}

export interface ArtistMetadataScanState {
  hasManagedMetadata?: boolean;
}

export function shouldHydrateArtistAlbumTracks(policy: ArtistMetadataScanPolicy): boolean {
  return policy.monitorAlbums !== false;
}

export function shouldHydrateArtistCatalog(
  policy: ArtistMetadataScanPolicy,
  state: ArtistMetadataScanState,
): boolean {
  return policy.monitorAlbums !== false || state.hasManagedMetadata !== true;
}
