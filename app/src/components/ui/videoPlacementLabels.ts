import type { VideoDetailContract } from "@contracts/media";

export type VideoPlacementRelatedTrack = NonNullable<VideoDetailContract["related_tracks"]>[number];
