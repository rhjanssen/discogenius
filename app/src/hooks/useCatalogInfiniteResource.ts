import { useInfiniteQuery, type InfiniteData, type QueryKey } from "@tanstack/react-query";

export type CatalogPage<TItem> = {
  items: TItem[];
  hasMore: boolean;
  total: number;
  offset: number;
};

type UseCatalogInfiniteResourceOptions<TItem, TResponse> = {
  queryKey: QueryKey;
  pageSize: number;
  timeoutMs?: number;
  staleTime?: number;
  enabled?: boolean;
  fetchPage: (args: {
    limit: number;
    offset: number;
    signal: AbortSignal;
    timeoutMs: number;
  }) => Promise<TResponse>;
  normalizePage?: (response: TResponse, offset: number) => CatalogPage<TItem>;
};

function normalizeCatalogPage<TItem>(response: unknown, offset: number): CatalogPage<TItem> {
  const record = response && typeof response === "object"
    ? response as {
      items?: unknown;
      hasMore?: unknown;
      total?: unknown;
    }
    : null;
  const items = Array.isArray(record?.items) ? record.items as TItem[] : [];

  return {
    items,
    hasMore: record?.hasMore === true,
    total: typeof record?.total === "number" ? record.total : offset + items.length,
    offset,
  };
}

export function useCatalogInfiniteResource<TItem, TResponse = unknown>({
  queryKey,
  pageSize,
  timeoutMs = 15_000,
  staleTime = 30_000,
  enabled = true,
  fetchPage,
  normalizePage,
}: UseCatalogInfiniteResourceOptions<TItem, TResponse>) {
  const query = useInfiniteQuery<CatalogPage<TItem>>({
    queryKey,
    queryFn: async ({ pageParam, signal }) => {
      const offset = Number(pageParam || 0);
      const response = await fetchPage({
        limit: pageSize,
        offset,
        signal,
        timeoutMs,
      });

      return normalizePage
        ? normalizePage(response, offset)
        : normalizeCatalogPage<TItem>(response, offset);
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => (
      lastPage.hasMore
        ? lastPage.offset + lastPage.items.length
        : undefined
    ),
    staleTime,
    refetchOnWindowFocus: false,
    retry: 1,
    placeholderData: (previousData: InfiniteData<CatalogPage<TItem>> | undefined) => previousData,
    enabled,
  });

  const pages = query.data?.pages ?? [];
  const items = enabled ? pages.flatMap((page) => page.items) : [];
  const total = enabled ? (pages[pages.length - 1]?.total ?? pages[0]?.total ?? 0) : 0;
  const hasData = pages.length > 0;

  return {
    ...query,
    items,
    total,
    hasMore: enabled ? Boolean(query.hasNextPage) : false,
    loading: enabled ? query.isPending && items.length === 0 : false,
    isPopulated: hasData,
    hasData,
    isUpdating: query.isFetching && hasData,
    hasRefreshError: query.isError,
    refreshErrorMessage: query.error instanceof Error
      ? query.error.message
      : query.error
        ? "Could not refresh the current view"
        : null,
  };
}
