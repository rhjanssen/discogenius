export enum AlbumRefreshLevel {
    NONE = 0,
    OFFER = 1,
    METADATA = 2,
    DETAILS = 3,
}

export interface RefreshOptions {
    monitorArtist?: boolean;
    monitorAlbums?: boolean;
    hydrateCatalog?: boolean;
    hydrateAlbumTracks?: boolean;
    resolveMusicBrainz?: boolean;
    forceUpdate?: boolean;
    forceAlbumUpdate?: boolean;
    /**
     * When true, artist refresh performs metadata intake only and skips the inline
     * provider-matching step, returning the context a caller needs to enqueue a
     * standalone MatchArtistProviders command instead. Used by the RefreshArtist
     * command path to decompose refresh and provider matching into separate
     * queued units; direct callers leave it unset and keep inline matching.
     */
    deferProviderMatching?: boolean;
    /**
     * When true, provider matching stops after selecting slots and does NOT run
     * curation inline — the caller is responsible for it.
     *
     * The queued artist workflow is RefreshArtist → MatchArtistProviders →
     * RescanFolders → CurateArtist, and MatchArtistProviders was curating the
     * whole artist inline *as well*, so every workflow paid for curation twice.
     * On prolific artists the second pass is what ran past the command lease and
     * poison-failed. Direct callers (scheduler, bulk RefreshMetadata) have no
     * following CurateArtist, so they leave this unset and keep curating inline.
     */
    deferCuration?: boolean;
    /**
     * Provider module that sourced the item being seeded/refreshed. Seeding a
     * cross-provider item (e.g. a video offer resolved to a non-default
     * provider) must query that provider's catalog, not the default one.
     */
    provider?: string;
    progress?: (event: ArtistScanProgressEvent) => void;
}

/** What artist refresh hands back so a deferred MatchArtistProviders command is faithful to the inline path. */
export interface ArtistRefreshResult {
    artistMbid: string | null;
    shouldHydrateCatalog: boolean;
    metadataChanged: boolean;
    isNewArtist: boolean;
}

export type ArtistScanProgressEvent =
    | { kind: "status"; message: string }
    | { kind: "albums_total"; total: number }
    | { kind: "album"; index: number; total: number; albumId: string; title: string; created: boolean }
    | { kind: "album_tracks"; index: number; total: number; albumId: string; title: string };
