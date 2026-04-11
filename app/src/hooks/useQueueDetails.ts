import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { QueueItemContract } from "@contracts/status";
import { api } from "@/services/api";
import { useDebouncedQueryInvalidation } from "@/hooks/useDebouncedQueryInvalidation";
import { ACTIVITY_REFRESH_EVENT } from "@/utils/appEvents";

type UseQueueDetailsOptions = {
  artistId?: string;
  albumIds?: string[];
  tidalIds?: string[];
  enabled?: boolean;
};

export function useQueueDetails({
  artistId,
  albumIds,
  tidalIds,
  enabled = true,
}: UseQueueDetailsOptions = {}) {
  const normalizedAlbumIds = useMemo(() => Array.from(new Set((albumIds ?? []).filter(Boolean))), [albumIds]);
  const normalizedTidalIds = useMemo(() => Array.from(new Set((tidalIds ?? []).filter(Boolean))), [tidalIds]);
  const queryKey = useMemo(() => ([
    "queueDetails",
    {
      artistId: artistId ?? null,
      albumIds: normalizedAlbumIds,
      tidalIds: normalizedTidalIds,
    },
  ] as const), [artistId, normalizedAlbumIds, normalizedTidalIds]);

  const hasFilters = Boolean(
    (artistId && artistId.trim().length > 0)
    || normalizedAlbumIds.length > 0
    || normalizedTidalIds.length > 0,
  );
  const isEnabled = enabled && hasFilters;

  useDebouncedQueryInvalidation({
    queryKeys: [queryKey],
    globalEvents: ["job.added", "job.updated", "job.deleted", "queue.cleared"],
    windowEvents: [ACTIVITY_REFRESH_EVENT],
    debounceMs: 400,
    enabled: isEnabled,
  });

  const query = useQuery<QueueItemContract[]>({
    queryKey,
    queryFn: () => api.getQueueDetails({
      artistId,
      albumIds: normalizedAlbumIds,
      tidalIds: normalizedTidalIds,
    }),
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
    enabled: isEnabled,
  });

  return {
    ...query,
    items: query.data ?? [],
  };
}
