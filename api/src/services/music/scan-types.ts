export enum ScanLevel {
    NONE = 0,
    BASIC = 1,
    SHALLOW = 2,
    DEEP = 3,
}

export interface ScanOptions {
    monitorArtist?: boolean;
    monitorAlbums?: boolean;
    hydrateCatalog?: boolean;
    hydrateAlbumTracks?: boolean;
    resolveMusicBrainz?: boolean;
    forceUpdate?: boolean;
    forceAlbumUpdate?: boolean;
    includeSimilarArtists?: boolean;
    seedSimilarArtists?: boolean;
    includeSimilarAlbums?: boolean;
    seedSimilarAlbums?: boolean;
    /**
     * When true, scanDeep performs metadata intake only and SKIPS the inline
     * provider-matching step, returning the context a caller needs to enqueue a
     * standalone MatchArtistProviders command instead. Used by the RefreshArtist
     * command path to decompose refresh and provider matching into separate
     * queued units; direct callers leave it unset and keep inline matching.
     */
    deferProviderMatching?: boolean;
    progress?: (event: ArtistScanProgressEvent) => void;
}

/** What scanDeep hands back so a deferred MatchArtistProviders command is faithful to the inline path. */
export interface ScanDeepResult {
    artistMbid: string | null;
    shouldHydrateCatalog: boolean;
}

export type ArtistScanProgressEvent =
    | { kind: "status"; message: string }
    | { kind: "albums_total"; total: number }
    | { kind: "album"; index: number; total: number; albumId: string; title: string; created: boolean }
    | { kind: "album_tracks"; index: number; total: number; albumId: string; title: string };
