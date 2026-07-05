import { useInfiniteQuery, type QueryKey } from "@tanstack/react-query";
import { ACTIVITY_REFRESH_EVENT } from "@/utils/appEvents";
import { useDebouncedQueryInvalidation } from "@/hooks/useDebouncedQueryInvalidation";
import type { GlobalEventPayload } from "@/hooks/useGlobalEvents";

type FeedPage<TItem> = {
    items: TItem[];
    offset: number;
    hasMore: boolean;
    total: number;
};

type UseDashboardInfiniteFeedOptions<TItem> = {
    queryKey: QueryKey;
    pageSize: number;
    timeoutMs?: number;
    refreshErrorFallbackMessage: string;
    fetchPage: (args: { limit: number; offset: number; timeoutMs: number }) => Promise<FeedPage<TItem>>;
    getItemId: (item: TItem) => string | number;
    enabled?: boolean;
    refetchIntervalMs?: number | false;
    refetchOnMount?: boolean | "always";
    globalEventFilter?: (event: GlobalEventPayload) => boolean;
};

/**
 * Shared filter: per-second download progress ticks arrive as command.updated
 * with status "started" and cannot change list membership — the SSE progress
 * stream keeps visible progress live. Everything else invalidates.
 */
export function ignoreProgressTickEvents(event: GlobalEventPayload): boolean {
    if (event.type !== "command.updated") {
        return true;
    }
    const status = (event.data as { status?: string } | null)?.status;
    return status !== "started";
}

const DASHBOARD_FEED_GLOBAL_EVENTS = [
    "command.added",
    "command.updated",
    "command.deleted",
    "queue.cleared",
    "history.added",
    "config.updated",
    "file.added",
    "file.deleted",
    "file.upgraded",
] as const;

export function useDashboardInfiniteFeed<TItem>({
    queryKey,
    pageSize,
    timeoutMs = 10_000,
    refreshErrorFallbackMessage,
    fetchPage,
    getItemId,
    enabled = true,
    refetchIntervalMs = false,
    refetchOnMount,
    globalEventFilter,
}: UseDashboardInfiniteFeedOptions<TItem>) {
    useDebouncedQueryInvalidation({
        queryKeys: [queryKey],
        globalEvents: [...DASHBOARD_FEED_GLOBAL_EVENTS],
        windowEvents: [ACTIVITY_REFRESH_EVENT],
        debounceMs: 500,
        enabled,
        globalEventFilter,
    });

    const query = useInfiniteQuery({
        queryKey,
        queryFn: async ({ pageParam }) => fetchPage({
            limit: pageSize,
            offset: Number(pageParam || 0),
            timeoutMs,
        }),
        initialPageParam: 0,
        getNextPageParam: (lastPage) => (
            lastPage.hasMore
                ? lastPage.offset + lastPage.items.length
                : undefined
        ),
        staleTime: 5_000,
        refetchOnMount,
        refetchOnWindowFocus: false,
        refetchInterval: refetchIntervalMs,
        refetchIntervalInBackground: Boolean(refetchIntervalMs),
        retry: 1,
        placeholderData: (previousData) => previousData,
        enabled,
    });

    const pages = query.data?.pages ?? [];
    const itemsById = new Map<string, TItem>();
    for (const item of pages.flatMap((page) => page.items)) {
        if (item == null) {
            continue;
        }

        try {
            const itemId = getItemId(item);
            if (itemId == null) {
                continue;
            }

            itemsById.set(String(itemId), item);
        } catch {
            continue;
        }
    }

    const items = Array.from(itemsById.values());
    const total = pages[pages.length - 1]?.total ?? pages[0]?.total ?? 0;
    const hasData = pages.length > 0;

    return {
        ...query,
        items,
        total,
        hasData,
        isInitialLoading: query.isLoading && !hasData,
        isUpdating: query.isFetching && hasData,
        hasRefreshError: query.isError,
        refreshErrorMessage: query.error instanceof Error
            ? query.error.message
            : query.error
                ? refreshErrorFallbackMessage
                : null,
    };
}
