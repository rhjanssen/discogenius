/**
 * Recorded-shape Apple Music API fixtures (no live network). Shapes mirror real
 * https://api.music.apple.com JSON:API responses closely enough to exercise the
 * adapter's mapping, search routing, and quality classification.
 */

export const ARTIST_RESPONSE = {
  data: [
    {
      id: "1419227",
      type: "artists",
      attributes: {
        name: "Bastille",
        url: "https://music.apple.com/us/artist/bastille/1419227",
        genreNames: ["Alternative"],
        artwork: {
          url: "https://is1-ssl.mzstatic.com/image/thumb/abc/{w}x{h}bb.{f}",
          width: 3000,
          height: 3000,
        },
      },
    },
  ],
};

export const ARTIST_ALBUMS_RESPONSE = {
  data: [
    {
      id: "1440904699",
      type: "albums",
      attributes: {
        name: "Bad Blood",
        artistName: "Bastille",
        releaseDate: "2013-03-04",
        trackCount: 13,
        upc: "00602537312733",
        contentRating: "explicit",
        isSingle: false,
        audioTraits: ["lossless", "lossy-stereo"],
        url: "https://music.apple.com/us/album/bad-blood/1440904699",
        artwork: { url: "https://is1-ssl.mzstatic.com/image/thumb/x/{w}x{h}bb.{f}", width: 1500, height: 1500 },
        editorialVideo: {
          motionDetailSquare: {
            video: "https://mzstatic.com/editorialvideo/motion-detail-square.m3u8",
          },
          motionSquareVideo1x1: {
            video: "https://mzstatic.com/editorialvideo/motion-square-fallback.m3u8",
          },
        },
      },
    },
    {
      id: "1500000000",
      type: "albums",
      attributes: {
        name: "Give Me the Future (Spatial)",
        artistName: "Bastille",
        releaseDate: "2022-02-04",
        trackCount: 14,
        upc: "00602445123456",
        contentRating: "clean",
        isSingle: false,
        audioTraits: ["hi-res-lossless", "atmos"],
        url: "https://music.apple.com/us/album/give-me-the-future/1500000000",
        artwork: { url: "https://is1-ssl.mzstatic.com/image/thumb/y/{w}x{h}bb.{f}" },
      },
    },
  ],
};

export const ALBUM_RESPONSE = {
  data: [ARTIST_ALBUMS_RESPONSE.data[0]],
};

export const ALBUM_TRACKS_RESPONSE = {
  data: [
    {
      id: "1440904918",
      type: "songs",
      attributes: {
        name: "Pompeii",
        artistName: "Bastille",
        albumName: "Bad Blood",
        durationInMillis: 214000,
        trackNumber: 4,
        discNumber: 1,
        isrc: "GBUM71300776",
        contentRating: "clean",
        audioTraits: ["lossless"],
        url: "https://music.apple.com/us/song/pompeii/1440904918",
      },
    },
    {
      id: "1440904919",
      type: "songs",
      attributes: {
        name: "Things We Lost in the Fire",
        artistName: "Bastille",
        albumName: "Bad Blood",
        durationInMillis: 245000,
        trackNumber: 5,
        discNumber: 1,
        isrc: "GBUM71300777",
        contentRating: "clean",
        audioTraits: ["lossless"],
      },
    },
  ],
};

export const TRACK_RESPONSE = {
  data: [ALBUM_TRACKS_RESPONSE.data[0]],
};

export const VIDEO_RESPONSE = {
  data: [
    {
      id: "1452310551",
      type: "music-videos",
      attributes: {
        name: "Pompeii",
        artistName: "Bastille",
        durationInMillis: 215000,
        releaseDate: "2013-02-11",
        isrc: "GBUM71300999",
        contentRating: "clean",
        has4K: true,
        url: "https://music.apple.com/us/music-video/pompeii/1452310551",
        artwork: { url: "https://is1-ssl.mzstatic.com/image/thumb/v/{w}x{h}bb.{f}" },
      },
      relationships: {
        albums: {
          data: [{ id: "1440653916", type: "albums" }],
        },
        songs: {
          data: [{ id: "1440653947", type: "songs" }],
        },
      },
    },
  ],
};

export const SEARCH_RESPONSE = {
  results: {
    artists: { data: ARTIST_RESPONSE.data },
    albums: { data: ARTIST_ALBUMS_RESPONSE.data },
    songs: { data: ALBUM_TRACKS_RESPONSE.data },
    "music-videos": { data: VIDEO_RESPONSE.data },
  },
};

export const LIBRARY_ARTISTS_RESPONSE = {
  data: [
    {
      id: "r.library-bastille",
      type: "library-artists",
      attributes: {
        name: "Bastille",
        artwork: { url: "https://is1-ssl.mzstatic.com/image/thumb/la/{w}x{h}bb.{f}" },
      },
      relationships: {
        catalog: { data: ARTIST_RESPONSE.data },
      },
    },
  ],
};

export const LIBRARY_PLAYLISTS_RESPONSE = {
  data: [
    {
      id: "p.test",
      type: "library-playlists",
      attributes: {
        name: "Apple Test Playlist",
        description: { standard: "Fixture playlist" },
        trackCount: 2,
        artwork: { url: "https://is1-ssl.mzstatic.com/image/thumb/pl/{w}x{h}bb.{f}" },
      },
    },
  ],
};

export const LIBRARY_PLAYLIST_TRACKS_RESPONSE = {
  data: [
    {
      id: "i.library-song-1",
      type: "library-songs",
      attributes: {
        name: "Pompeii",
        artistName: "Bastille",
      },
      relationships: {
        catalog: { data: [ALBUM_TRACKS_RESPONSE.data[0]] },
      },
    },
    {
      id: "i.library-song-2",
      type: "library-songs",
      attributes: {
        name: "Things We Lost in the Fire",
        artistName: "Bastille",
      },
      relationships: {
        catalog: { data: [ALBUM_TRACKS_RESPONSE.data[1]] },
      },
    },
  ],
};

export const USER_STOREFRONT_RESPONSE = {
  data: [
    {
      id: "us",
      type: "storefronts",
      attributes: {
        defaultLanguageTag: "en-US",
        name: "United States",
      },
    },
  ],
};

/** Map an Apple Music API endpoint path to its fixture response. */
export function fixtureFor(url: string): unknown {
  if (url.includes("/v1/me/storefront")) return USER_STOREFRONT_RESPONSE;
  if (url.includes("/v1/me/library/playlists/p.test/tracks")) return LIBRARY_PLAYLIST_TRACKS_RESPONSE;
  if (url.includes("/v1/me/library/playlists")) return LIBRARY_PLAYLISTS_RESPONSE;
  if (url.includes("/v1/me/library/artists")) return LIBRARY_ARTISTS_RESPONSE;
  if (url.includes("/search?")) return SEARCH_RESPONSE;
  if (/\/artists\/\d+\/albums/.test(url)) return ARTIST_ALBUMS_RESPONSE;
  if (/\/artists\/\d+\/music-videos/.test(url)) return { data: VIDEO_RESPONSE.data };
  if (/\/artists\/\d+/.test(url)) return ARTIST_RESPONSE;
  if (/\/albums\/\d+\/tracks/.test(url)) return ALBUM_TRACKS_RESPONSE;
  if (/\/albums\/\d+/.test(url)) return ALBUM_RESPONSE;
  if (/\/songs\/\d+/.test(url)) return TRACK_RESPONSE;
  if (/\/music-videos\/\d+/.test(url)) return VIDEO_RESPONSE;
  throw new Error(`No fixture for ${url}`);
}
