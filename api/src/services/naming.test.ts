import assert from "node:assert/strict";
import test from "node:test";

import { renderFileStem, renderRelativePath } from "./naming.js";

test("existing Discogenius naming tokens continue to render", () => {
  const rendered = renderFileStem(
    "{artistName} - {albumFullTitle} ({releaseYear}) - {trackNumber00} - {trackFullTitle}",
    {
      artistName: "Daft Punk",
      albumTitle: "Discovery",
      albumVersion: null,
      releaseYear: "2001",
      trackTitle: "One More Time",
      trackVersion: null,
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
      "{Track FullTitle}",
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
      trackArtistName: "The Beatles",
      trackArtistMbId: "artist-mbid-1",
    }
  );

  assert.equal(
    rendered,
    "The Beatles ; The Beatles ; The Beatles ; The Beatles ; The White Album ; ALBUM ; album-mbid-1 ; 1968 ; Helter Skelter ; Helter Skelter ; The Beatles ; artist-mbid-1"
  );
});

test("modifiers work: :the applies The suffix transform (deprecated, use named variables)", () => {
  const rendered = renderFileStem(
    "{artistName:the} ; {albumTitle:the} ; {trackArtistName:the}",
    {
      artistName: "The Beatles",
      albumTitle: "The White Album",
      trackArtistName: "The Rolling Stones",
    }
  );

  assert.equal(rendered, "Beatles, The ; White Album, The ; Rolling Stones, The");
});

test("modifiers work: :clean removes non-alphanumeric characters (deprecated, use named variables)", () => {
  const rendered = renderFileStem(
    "{artistName:clean} ; {albumTitle:clean} ; {trackTitle:clean}",
    {
      artistName: "AC/DC",
      albumTitle: "The White Album",
      trackTitle: "Don't Stop Me Now!",
    }
  );

  assert.equal(rendered, "AC DC ; The White Album ; Don t Stop Me Now");
});

test("modifiers work: :first extracts first character (deprecated, use named variables)", () => {
  const rendered = renderFileStem("{artistName:first} ; {albumTitle:first}", {
    artistName: "Daft Punk",
    albumTitle: "Discovery",
  });

  assert.equal(rendered, "D ; D");
});

test("modifiers can be stacked: :clean:the (deprecated, use named variables)", () => {
  const rendered = renderFileStem("{artistName:clean:the}", {
    artistName: "The AC/DC",
  });

  assert.equal(rendered, "AC DC, The");
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

  // TitleThe regex preserves parenthetical suffixes in capture group 3,
  // then both main part and suffix are cleaned separately.
  // Parentheses are removed during cleaning, and "(Remastered)" becomes "Remastered"
  // Result: "White Album, TheRemastered"
  assert.equal(rendered, "White Album, TheRemastered");
});

test("named variables: {trackCleanTitle} produces CleanTitle result", () => {
  const rendered = renderFileStem("{trackCleanTitle}", {
    artistName: "Test Artist",
    trackTitle: "Don't Stop Me Now!",
  });

  assert.equal(rendered, "Don t Stop Me Now");
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

  assert.equal(rendered, "Music Video 1");
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

  const legacyRendered = renderFileStem("{trackNumber00}-{volumeNumber000}", {
    artistName: "Daft Punk",
    trackNumber: 1,
    volumeNumber: 1,
  });

  assert.equal(legacyRendered, "01-001");
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

  assert.equal(rendered, "LOSSLESS ; FLAC ; 320 ; 44100 ; 24 ; 2");
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

  assert.equal(rendered, "start-------end");
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

  assert.equal(rendered, "HIRES_LOSSLESS @ 192Hz 24bit");
});

test("unknown tokens render as empty strings", () => {
  const rendered = renderFileStem("start-{Unknown Token}-end", {
    artistName: "Daft Punk",
  });

  assert.equal(rendered, "start--end");
});

test("renderRelativePath returns \"Unknown\" when all segments collapse", () => {
  const rendered = renderRelativePath("{Unknown Token}", {
    artistName: "Daft Punk",
  });

  assert.equal(rendered, "Unknown");
});
