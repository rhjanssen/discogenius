import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { QueueItemContract } from "@contracts/status";
import { api } from "@/services/api";
import { useDebouncedQueryInvalidation } from "@/hooks/useDebouncedQueryInvalidation";
import { ACTIVITY_REFRESH_EVENT } from "@/utils/appEvents";

type UseQueueDetailsOptions = {
  artistId?: string;
  albumIds?: string[];
  providerIds?: string[];
  enabled?: boolean;
};

export function useQueueDetails({
  artistId,
  albumIds,
  providerIds,
  enabled = true,
}: UseQueueDetailsOptions = {}) {
  const normalizedAlbumIds = useMemo(() => Array.from(new Set((albumIds ?? []).filter(Boolean))), [albumIds]);
  const normalizedProviderIds = useMemo(() => Array.from(new Set((providerIds ?? []).filter(Boolean))), [providerIds]);
  const queryKey = useMemo(() => ([
    "queueDetails",
    {
      artistId: artistId ?? null,
      albumIds: normalizedAlbumIds,
      providerIds: normalizedProviderIds,
    },
  ] as const), [artistId, normalizedAlbumIds, normalizedProviderIds]);

  const hasFilters = Boolean(
    (artistId && artistId.trim().length > 0)
    || normalizedAlbumIds.length > 0
    || normalizedProviderIds.length > 0,
  );
  const isEnabled = enabled && hasFilters;

  useDebouncedQueryInvalidation({
    queryKeys: [queryKey],
    globalEvents: ["command.added", "command.updated", "command.deleted", "queue.cleared"],
    windowEvents: [ACTIVITY_REFRESH_EVENT],
    debounceMs: 400,
    enabled: isEnabled,
  });

  const query = useQuery<QueueItemContract[]>({
    queryKey,
    queryFn: () => api.getQueueDetails({
      artistId,
      albumIds: normalizedAlbumIds,
      providerIds: normalizedProviderIds,
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
