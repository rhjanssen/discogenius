import { describe, expect, it } from "vitest";
import { getQueueItemNavPath, queueVideoNavPath } from "./queueNavigation";

describe("queue navigation", () => {
  it("opens videos by canonical recording id only", () => {
    expect(queueVideoNavPath("70230")).toBe("/video/70230");
    expect(getQueueItemNavPath({
      type: "video",
      media_id: "70230",
      album_id: null,
    })).toBe("/video/70230");
  });

  it("does not deep-link a video by provider resource id", () => {
    expect(getQueueItemNavPath({
      type: "video",
      media_id: null,
    })).toBeNull();
  });

  it("opens albums by canonical album id only", () => {
    expect(getQueueItemNavPath({
      type: "album",
      album_id: "rg-1",
    })).toBe("/album/rg-1");
    expect(getQueueItemNavPath({
      type: "album",
      album_id: null,
    })).toBeNull();
  });
});
