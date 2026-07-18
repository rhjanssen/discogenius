/**
 * Sanitized Spotify Web API responses recorded from the public catalog shape.
 * URLs and IDs remain Spotify-shaped; token/cookie material is synthetic.
 */
export const SPOTIFY_FIXTURE_IDS = {
  artist: "7EQ0qTo7fWT7DPxmxtSYEc",
  album: "0qPVrEhZboacuxAuV3lnd2",
  secondAlbum: "3KzgdYUlqV6TOG7JCmx2Wg",
  track: "3gbBpTdY8lnQwqxNCcf795",
  secondTrack: "1rIKgCH4H52lrvDcz50hS8",
} as const;

const artist = {
  external_urls: { spotify: `https://open.spotify.com/artist/${SPOTIFY_FIXTURE_IDS.artist}` },
  id: SPOTIFY_FIXTURE_IDS.artist,
  images: [
    { height: 320, url: "https://i.scdn.co/image/bastille-320", width: 320 },
    { height: 640, url: "https://i.scdn.co/image/bastille-640", width: 640 },
  ],
  name: "Bastille",
  popularity: 73,
  type: "artist",
};

const simplifiedArtist = {
  external_urls: artist.external_urls,
  id: artist.id,
  name: artist.name,
  type: artist.type,
};

const albumBase = {
  album_type: "album",
  artists: [simplifiedArtist],
  copyrights: [{ text: "© 2013 Virgin Records Limited", type: "C" }],
  external_ids: { upc: "00602537312733" },
  external_urls: { spotify: `https://open.spotify.com/album/${SPOTIFY_FIXTURE_IDS.album}` },
  id: SPOTIFY_FIXTURE_IDS.album,
  images: [{ height: 640, url: "https://i.scdn.co/image/bad-blood-640", width: 640 }],
  label: "Virgin Records",
  name: "Bad Blood",
  popularity: 77,
  release_date: "2013-03-04",
  release_date_precision: "day",
  total_tracks: 2,
  type: "album",
};

const trackOne = {
  artists: [simplifiedArtist],
  disc_number: 1,
  duration_ms: 214000,
  explicit: false,
  external_ids: { isrc: "GBUM71300776" },
  external_urls: { spotify: `https://open.spotify.com/track/${SPOTIFY_FIXTURE_IDS.track}` },
  id: SPOTIFY_FIXTURE_IDS.track,
  is_local: false,
  name: "Pompeii",
  popularity: 84,
  preview_url: "https://p.scdn.co/mp3-preview/pompeii-preview",
  track_number: 1,
  type: "track",
};

const trackTwo = {
  artists: [simplifiedArtist],
  disc_number: 1,
  duration_ms: 196400,
  explicit: true,
  external_ids: { isrc: "GBUM71301234" },
  external_urls: { spotify: `https://open.spotify.com/track/${SPOTIFY_FIXTURE_IDS.secondTrack}` },
  id: SPOTIFY_FIXTURE_IDS.secondTrack,
  is_local: false,
  name: "Things We Lost in the Fire",
  popularity: 68,
  preview_url: null,
  track_number: 2,
  type: "track",
};

const album = {
  ...albumBase,
  tracks: {
    items: [trackOne],
    limit: 1,
    next: `https://api.spotify.com/v1/albums/${SPOTIFY_FIXTURE_IDS.album}/tracks?offset=1&limit=1`,
    offset: 0,
    total: 2,
  },
};

const secondAlbum = {
  album_type: "single",
  album_group: "single",
  artists: [simplifiedArtist],
  external_ids: { upc: "00602599999999" },
  external_urls: { spotify: `https://open.spotify.com/album/${SPOTIFY_FIXTURE_IDS.secondAlbum}` },
  id: SPOTIFY_FIXTURE_IDS.secondAlbum,
  images: [{ height: 640, url: "https://i.scdn.co/image/ep-640", width: 640 }],
  name: "Overjoyed EP",
  release_date: "2012",
  release_date_precision: "year",
  total_tracks: 4,
  type: "album",
};

export const SPOTIFY_RECORDED_FIXTURES = {
  artist,
  album,
  track: { ...trackOne, album: albumBase },
  search: {
    artists: { items: [artist], limit: 10, next: null, offset: 0, total: 1 },
    albums: { items: [albumBase], limit: 10, next: null, offset: 0, total: 1 },
    tracks: { items: [{ ...trackOne, album: albumBase }], limit: 10, next: null, offset: 0, total: 1 },
  },
  artistAlbumsFirst: {
    items: [albumBase],
    limit: 1,
    next: `https://api.spotify.com/v1/artists/${SPOTIFY_FIXTURE_IDS.artist}/albums?offset=1&limit=1`,
    offset: 0,
    total: 2,
  },
  artistAlbumsSecond: {
    items: [secondAlbum],
    limit: 1,
    next: null,
    offset: 1,
    total: 2,
  },
  albumTracksSecond: {
    items: [trackTwo],
    limit: 1,
    next: null,
    offset: 1,
    total: 2,
  },
} as const;

export function recordedSpotifyFixture(urlValue: string): unknown {
  const url = new URL(urlValue);
  const path = url.pathname;
  if (url.origin === "https://accounts.spotify.com" && path === "/api/token") {
    return { access_token: "fixture-access-token", token_type: "Bearer", expires_in: 3600 };
  }
  if (path === `/v1/artists/${SPOTIFY_FIXTURE_IDS.artist}`) return SPOTIFY_RECORDED_FIXTURES.artist;
  if (path === `/v1/artists/${SPOTIFY_FIXTURE_IDS.artist}/albums`) {
    return url.searchParams.get("offset") === "1"
      ? SPOTIFY_RECORDED_FIXTURES.artistAlbumsSecond
      : SPOTIFY_RECORDED_FIXTURES.artistAlbumsFirst;
  }
  if (path === `/v1/albums/${SPOTIFY_FIXTURE_IDS.album}`) return SPOTIFY_RECORDED_FIXTURES.album;
  if (path === `/v1/albums/${SPOTIFY_FIXTURE_IDS.album}/tracks`) {
    return SPOTIFY_RECORDED_FIXTURES.albumTracksSecond;
  }
  if (path === `/v1/tracks/${SPOTIFY_FIXTURE_IDS.track}`) return SPOTIFY_RECORDED_FIXTURES.track;
  if (path === "/v1/search") return SPOTIFY_RECORDED_FIXTURES.search;
  throw new Error(`No recorded Spotify fixture for ${urlValue}`);
}

