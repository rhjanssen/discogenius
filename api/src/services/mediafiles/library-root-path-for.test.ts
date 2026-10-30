import test from "node:test";
import assert from "node:assert/strict";
import { libraryRootPathFor } from "./unmapped-files.js";

test("libraryRootPathFor resolves the library that contains the file, longest root wins", () => {
    const libraries = [{ rootPath: "/library" }, { rootPath: "/library/stereo-music/" }, { rootPath: "/library/videos" }];
    assert.equal(libraryRootPathFor("/library/stereo-music/Artist/Album/01.flac", libraries), "/library/stereo-music");
    assert.equal(libraryRootPathFor("/library/stereo-musicx/a.flac", libraries), "/library");
    assert.equal(libraryRootPathFor("/elsewhere/a.flac", libraries), null);
});
