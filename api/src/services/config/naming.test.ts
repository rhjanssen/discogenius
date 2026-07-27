import assert from "node:assert/strict";
import test from "node:test";

import { cleanPathSegment, previewNamingConfig, renderFileStem, renderRelativePath, validateNamingConfig } from "./naming.js";

test("existing Discogenius naming tokens continue to render", () => {
  const rendered = renderFileStem(
    "{artistName} - {albumTitle} ({releaseYear}) - {track:00} - {trackTitle}",
    {
      artistName: "Daft Punk",
      albumTitle: "Discovery",
      releaseYear: "2001",
      trackTitle: "One More Time",
      trackNumber: 1,
    }
  );

  assert.equal(rendered, "Daft Punk - Discovery (2001) - 01 - One More Time");
});

test("normalized filename variants resolve correctly", () => {
  const rendered = renderFileStem(
    [
      "{Artist Name}",
      "{artist_name}",
      "{Artist.Name}",
      "{ARTIST NAME}",
      "{Album Title}",
      "{Album Type}",
      "{Album MbId}",
      "{Release Year}",
      "{Track Title}",
      "{Track CleanTitle}",
      "{Track MbId}",
      "{Track ArtistName}",
      "{Track ArtistMbId}",
    ].join(" ; "),
    {
      artistName: "The Beatles",
      artistMbId: "artist-mbid-1",
      albumTitle: "The White Album",
      albumType: "ALBUM",
      albumMbId: "album-mbid-1",
      releaseYear: "1968",
      trackTitle: "Helter Skelter",
      trackMbId: "recording-mbid-1",
      trackArtistName: "The Beatles",
      trackArtistMbId: "artist-mbid-1",
    }
  );

  assert.equal(
    rendered,
    "The Beatles ; the_beatles ; The.Beatles ; THE BEATLES ; The White Album ; ALBUM ; album-mbid-1 ; 1968 ; Helter Skelter ; Helter Skelter ; recording-mbid-1 ; The Beatles ; artist-mbid-1"
  );
});

test("prefixed nested tokens render as literal folder disambiguators", () => {
  const rendered = renderRelativePath("{artistName} {artistMbId}", {
    artistName: "The Example Artist",
    artistMbId: "artist-mbid-1",
  });

  assert.equal(rendered, "The Example Artist artist-mbid-1");
});

test("release group and video id tokens render correctly", () => {
  const rendered = renderFileStem(
    "{releaseGroupMbId} ; {videoId} ; {trackId} ; {mediaId}",
    {
      artistName: "Test Artist",
      releaseGroupMbId: "release-group-mbid-1",
      videoId: "video-1",
    }
  );

  assert.equal(rendered, "release-group-mbid-1 ; video-1 ; video-1 ; video-1");
});

test("provider media and recording tokens render without track/video split", () => {
  const rendered = renderFileStem(
    "{mediaId} ; {providerMediaId} ; {recordingId} ; {recordingMbId}",
    {
      artistName: "Test Artist",
      mediaId: "provider-media-1",
      providerMediaId: "provider-media-1",
      recordingId: "42",
      recordingMbId: "recording-mbid-1",
    }
  );

  assert.equal(rendered, "provider-media-1 ; provider-media-1 ; 42 ; recording-mbid-1");
});

test("named variables: {artistCleanName} produces CleanTitle result", () => {
  const rendered = renderFileStem("{artistCleanName}", {
    artistName: "AC/DC",
  });

  assert.equal(rendered, "AC DC");
});

test("named variables: {artistNameThe} produces TitleThe result", () => {
  const rendered = renderFileStem("{artistNameThe}", {
    artistName: "The Beatles",
  });

  assert.equal(rendered, "Beatles, The");
});

test("named variables: {artistCleanNameThe} produces CleanTitleThe result", () => {
  const rendered = renderFileStem("{artistCleanNameThe}", {
    artistName: "The AC/DC",
  });

  assert.equal(rendered, "AC DC, The");
});

test("named variables: {albumCleanTitle} produces CleanTitle result", () => {
  const rendered = renderFileStem("{albumCleanTitle}", {
    artistName: "Test Artist",
    albumTitle: "AC/DC & Friends",
  });

  assert.equal(rendered, "AC DC and Friends");
});

test("named variables: {albumTitleThe} produces TitleThe result", () => {
  const rendered = renderFileStem("{albumTitleThe}", {
    artistName: "Test Artist",
    albumTitle: "The White Album",
  });

  assert.equal(rendered, "White Album, The");
});

test("named variables: {albumCleanTitleThe} produces CleanTitleThe result", () => {
  const rendered = renderFileStem("{albumCleanTitleThe}", {
    artistName: "Test Artist",
    albumTitle: "The White Album (Remastered)",
  });

  assert.equal(rendered, "White Album, The Remastered");
});

test("named variables: {trackCleanTitle} produces CleanTitle result", () => {
  const rendered = renderFileStem("{trackCleanTitle}", {
    artistName: "Test Artist",
    trackTitle: "Don't Stop Me Now!",
  });

  assert.equal(rendered, "Don't Stop Me Now!");
});

test("named variables: {trackTitleThe} produces TitleThe result", () => {
  const rendered = renderFileStem("{trackTitleThe}", {
    artistName: "Test Artist",
    trackTitle: "The Scientist",
  });

  assert.equal(rendered, "Scientist, The");
});

test("named variables: {trackCleanTitleThe} produces CleanTitleThe result", () => {
  const rendered = renderFileStem("{trackCleanTitleThe}", {
    artistName: "Test Artist",
    trackTitle: "The Greatest/Best",
  });

  assert.equal(rendered, "Greatest Best, The");
});

test("named variables: {trackArtistCleanName} produces CleanTitle result", () => {
  const rendered = renderFileStem("{trackArtistCleanName}", {
    artistName: "Test Artist",
    trackArtistName: "The Who?",
  });

  assert.equal(rendered, "The Who");
});

test("named variables: {trackArtistNameThe} produces TitleThe result", () => {
  const rendered = renderFileStem("{trackArtistNameThe}", {
    artistName: "Test Artist",
    trackArtistName: "The Who",
  });

  assert.equal(rendered, "Who, The");
});

test("named variables: {trackArtistCleanNameThe} produces CleanTitleThe result", () => {
  const rendered = renderFileStem("{trackArtistCleanNameThe}", {
    artistName: "Test Artist",
    trackArtistName: "The Rolling Stones",
  });

  assert.equal(rendered, "Rolling Stones, The");
});

test("named variables: {videoCleanTitle} produces CleanTitle result", () => {
  const rendered = renderFileStem("{videoCleanTitle}", {
    artistName: "Test Artist",
    videoTitle: "Music Video #1",
  });

  assert.equal(rendered, "Music Video #1");
});

test("named variables: {videoType} / {Video Type} render Plex extras suffix", () => {
  const rendered = renderFileStem("{videoCleanTitle}{videoType} {{providerName}-{mediaId}}", {
    artistName: "Bastille",
    videoTitle: "Pompeii",
    videoType: "-video",
    provider: "tidal",
    mediaId: "123",
  });
  assert.equal(rendered, "Pompeii-video {TIDAL-123}");

  const lyrics = renderFileStem("{videoCleanTitle}{Video Type}", {
    artistName: "Bastille",
    videoTitle: "Pompeii (Lyrics)",
    videoType: "-lyrics",
  });
  assert.equal(lyrics, "Pompeii Lyrics-lyrics");
});

test("named variables: {videoTitleThe} produces TitleThe result", () => {
  const rendered = renderFileStem("{videoTitleThe}", {
    artistName: "Test Artist",
    videoTitle: "The Best Moments",
  });

  assert.equal(rendered, "Best Moments, The");
});

test("named variables: {videoCleanTitleThe} produces CleanTitleThe result", () => {
  const rendered = renderFileStem("{videoCleanTitleThe}", {
    artistName: "Test Artist",
    videoTitle: "The Greatest/Live",
  });

  assert.equal(rendered, "Greatest Live, The");
});

test("track and medium aliases support zero-padding custom formats", () => {
  const rendered = renderFileStem("{track:00}-{track:000}-{medium:00}-{medium:000}", {
    artistName: "Daft Punk",
    trackNumber: 1,
    volumeNumber: 1,
  });

  assert.equal(rendered, "01-001-01-001");
});

test("quality metadata variables render correctly", () => {
  const rendered = renderFileStem(
    "{quality} ; {codec} ; {bitrate} ; {sampleRate} ; {bitDepth} ; {channels}",
    {
      artistName: "Test Artist",
      quality: "LOSSLESS",
      codec: "FLAC",
      bitrate: 320,
      sampleRate: 44100,
      bitDepth: 24,
      channels: 2,
    }
  );

  assert.equal(rendered, "lossless ; flac ; 320 ; 44100 ; 24 ; 2");
});

test("sampleRate format modifier: kHz", () => {
  const rendered = renderFileStem("{sampleRate:kHz}", {
    artistName: "Test Artist",
    sampleRate: 44100,
  });

  assert.equal(rendered, "44.1");
});

test("sampleRate format modifier: Hz", () => {
  const rendered = renderFileStem("{sampleRate:Hz}", {
    artistName: "Test Artist",
    sampleRate: 44100,
  });

  assert.equal(rendered, "44100");
});

test("quality metadata variables render empty when not provided", () => {
  const rendered = renderFileStem(
    "start-{quality}-{codec}-{bitrate}-{sampleRate}-{bitDepth}-{channels}-end",
    {
      artistName: "Test Artist",
    }
  );

  assert.equal(rendered, "start-end");
});

test("quality metadata variables handle high-resolution audio", () => {
  const rendered = renderFileStem(
    "{quality} @ {sampleRate:kHz}Hz {bitDepth}bit",
    {
      artistName: "Test Artist",
      quality: "HIRES_LOSSLESS",
      sampleRate: 192000,
      bitDepth: 24,
    }
  );

  assert.equal(rendered, "hires_lossless @ 192Hz 24bit");
});

test("unknown tokens render as empty strings", () => {
  const rendered = renderFileStem("start-{Unknown Token}-end", {
    artistName: "Daft Punk",
  });

  assert.equal(rendered, "start-end");
});

test("renderRelativePath returns \"Unknown\" when all segments collapse", () => {
  const rendered = renderRelativePath("{Unknown Token}", {
    artistName: "Daft Punk",
  });

  assert.equal(rendered, "Unknown");
});

test("factory default naming templates render Plex/Jellyfin-friendly previews", () => {
  const config = {
    artist_folder: "{Artist Name} {mbid-{Artist MbId}}",
    album_track_path_single: "{Album Title} ({Release Year})/{track:00} - {Track Title}",
    album_track_path_multi: "{Album Title} ({Release Year})/{medium:0}{track:00} - {Track Title}",
    video_file: "{Video Title}{Video Type} {{Provider Name}-{Provider VideoId}}",
  };

  const validation = validateNamingConfig(config);
  assert.equal(Object.values(validation).every((result) => result.valid), true);

  const preview = previewNamingConfig(config);
  const normalize = (value: string) => value.replace(/\\/g, "/");
  assert.deepEqual(
    {
      artistFolder: normalize(preview.artistFolder),
      standardTrack: normalize(preview.standardTrack),
      multiDiscTrack: normalize(preview.multiDiscTrack),
      video: normalize(preview.video),
    },
    {
      artistFolder: "Bastille {mbid-7808accb-6395-4b25-858c-678bbb73896b}",
      standardTrack: "Bad Blood (2013)/01 - Pompeii.flac",
      multiDiscTrack: "Bad Blood (2013)/203 - Pompeii.flac",
      video: "Pompeii (Live At The O2)-video {TIDAL-26065587}.mp4",
    },
  );
});

test("validateNamingConfig accepts templates and returns backend previews", () => {
  const config = {
    artist_folder: "{artistCleanNameThe}",
    album_track_path_single: "{Album CleanTitle} ({Release Year})/{track:00} - {Track CleanTitle}",
    album_track_path_multi: "{Album CleanTitle} ({Release Year})/{medium:0}{track:00} - {Track CleanTitle}",
    video_file: "{artistCleanName} - {videoCleanTitle} [{trackId}]",
  };

  const validation = validateNamingConfig(config);
  assert.equal(Object.values(validation).every((result) => result.valid), true);

  const preview = previewNamingConfig(config);
  const normalize = (p: string) => p.replace(/\\/g, "/");
  assert.deepEqual(
    {
      artistFolder: normalize(preview.artistFolder),
      standardTrack: normalize(preview.standardTrack),
      multiDiscTrack: normalize(preview.multiDiscTrack),
      video: normalize(preview.video),
    },
    {
      artistFolder: "Bastille",
      standardTrack: "Bad Blood (2013)/01 - Pompeii.flac",
      multiDiscTrack: "Bad Blood (2013)/203 - Pompeii.flac",
      video: "Bastille - Pompeii Live At The O2 [26065587].mp4",
    }
  );
});

test("validateNamingConfig rejects unknown tokens and unsafe track templates", () => {
  const validation = validateNamingConfig({
    artist_folder: "{artistName} {artistMbId}",
    album_track_path_single: "{AlbumTitle}/{Mystery Token}",
    album_track_path_multi: "../{medium:00}-{track:00} - {trackTitle}",
    video_file: "{artistName} - {videoTitle}",
  });

  assert.equal(validation.album_track_path_single.valid, false);
  assert.match(validation.album_track_path_single.errors.join(" "), /Unknown token/i);
  assert.match(validation.album_track_path_single.errors.join(" "), /track title/i);
  assert.match(validation.album_track_path_single.errors.join(" "), /track number/i);
  assert.deepEqual(validation.album_track_path_single.unknownTokens, ["Mystery Token"]);

  assert.equal(validation.album_track_path_multi.valid, false);
  assert.match(validation.album_track_path_multi.errors.join(" "), /parent-directory/i);
});

test("provider-neutral tokens and double-bracket nested expressions render correctly", () => {
  const context = {
    provider: "apple-music",
    artistName: "Bastille",
    artistId: "112233",
    albumTitle: "Give Me The Future",
    albumId: "445566;778899",
    trackTitle: "Shut Off The Lights",
    trackId: "998877",
    mediaId: "998877",
  };

  const renderedTokens = renderFileStem(
    "{providerName} ; {providerArtistId} ; {providerAlbumId} ; {providerTrackId} ; {providerMediaId} ; {mediaId}",
    context
  );
  assert.equal(renderedTokens, "Apple Music ; 112233 ; 445566;778899 ; 998877 ; 998877 ; 998877");

  const renderedNestedSingle = renderFileStem(
    "{{providerName}-{providerTrackId}}",
    context
  );
  assert.equal(renderedNestedSingle, "{Apple Music-998877}");

  const renderedNestedMultiple = renderFileStem(
    "{{providerName}-{providerAlbumId}}",
    context
  );
  assert.equal(renderedNestedMultiple, "{Apple Music-445566; 778899}");

});

test("spaced provider/video tokens resolve via the provider registry", () => {
  const rendered = renderFileStem(
    "{Video Title}{Video Type} {{Provider Name}-{Provider VideoId}}",
    {
      provider: "tidal",
      artistName: "Bastille",
      videoTitle: "Pompeii (Live At The O2)",
      videoType: "-live",
      mediaId: "44187439",
      providerMediaId: "44187439",
      videoId: "44187439",
    },
  );
  assert.equal(rendered, "Pompeii (Live At The O2)-live {TIDAL-44187439}");

  const apple = renderFileStem("{Provider Name}", {
    provider: "apple-music",
    artistName: "Bastille",
  });
  assert.equal(apple, "Apple Music");
});

test("validateNamingConfig accepts provider-neutral tokens", () => {
  const config = {
    artist_folder: "{artistCleanNameThe}",
    album_track_path_single: "{Album CleanTitle} ({Release Year})/{track:00} - {Track CleanTitle}",
    album_track_path_multi: "{Album CleanTitle} ({Release Year})/{medium:0}{track:00} - {Track CleanTitle}",
    video_file: "{artistCleanName} - {videoCleanTitle} {{providerName}-{providerTrackId}}",
  };

  const validation = validateNamingConfig(config);
  assert.equal(Object.values(validation).every((result) => result.valid), true);
});

test("reserved Windows device names are sanitized when followed by an extension", () => {
  assert.equal(cleanPathSegment("con.flac"), "con_.flac");
  assert.equal(cleanPathSegment("CON.flac"), "CON_.flac");
  assert.equal(cleanPathSegment("aux.mp3"), "aux_.mp3");
  assert.equal(cleanPathSegment("nul.m4a"), "nul_.m4a");
  assert.equal(cleanPathSegment("prn.flac"), "prn_.flac");
  assert.equal(cleanPathSegment("com1.flac"), "com1_.flac");
  assert.equal(cleanPathSegment("lpt9.flac"), "lpt9_.flac");
});

test("reserved device name check is anchored and does not mangle unrelated names", () => {
  // Reserved word without a following dot is left untouched.
  assert.equal(cleanPathSegment("con"), "con");
  // Names that merely contain a reserved word as a substring are untouched.
  assert.equal(cleanPathSegment("Console.flac"), "Console.flac");
  assert.equal(cleanPathSegment("Prince.flac"), "Prince.flac");
  assert.equal(cleanPathSegment("Conan.flac"), "Conan.flac");
});

test("{Artist Genre} and {Album Genre} render the primary genre", () => {
  const rendered = renderFileStem(
    "{Artist Genre} - {Album Genre}",
    {
      artistName: "Daft Punk",
      artistGenre: "Electronic",
      albumTitle: "Discovery",
      albumGenre: "House",
    }
  );

  assert.equal(rendered, "Electronic - House");
});

test("{Artist Genre} and {Album Genre} render empty when no genre is known", () => {
  const rendered = renderFileStem(
    "{Artist Genre}{Album Genre}",
    {
      artistName: "Daft Punk",
      albumTitle: "Discovery",
    }
  );

  assert.equal(rendered, "");
});

test("{Album Disambiguation} renders the release-group disambiguation", () => {
  const rendered = renderFileStem(
    "{Album Title} ({Album Disambiguation})",
    {
      artistName: "Bastille",
      albumTitle: "Bad Blood",
      albumDisambiguation: "extended cut",
    }
  );

  assert.equal(rendered, "Bad Blood (extended cut)");
});
