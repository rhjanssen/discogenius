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
    forceUpdate?: boolean;
    forceAlbumUpdate?: boolean;
    includeSimilarArtists?: boolean;
    seedSimilarArtists?: boolean;
    includeSimilarAlbums?: boolean;
    seedSimilarAlbums?: boolean;
    progress?: (event: ArtistScanProgressEvent) => void;
}

export type ArtistScanProgressEvent =
    | { kind: "status"; message: string }
    | { kind: "albums_total"; total: number }
    | { kind: "album"; index: number; total: number; albumId: string; title: string; created: boolean }
    | { kind: "album_tracks"; index: number; total: number; albumId: string; title: string };
