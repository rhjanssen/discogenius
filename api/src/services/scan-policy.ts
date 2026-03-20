export interface ArtistMetadataScanPolicy {
  monitorAlbums?: boolean;
}

export function shouldHydrateArtistAlbumTracks(policy: ArtistMetadataScanPolicy): boolean {
  return policy.monitorAlbums !== false;
}
