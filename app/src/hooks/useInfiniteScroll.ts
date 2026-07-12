/**
 * useInfiniteScroll - Reusable infinite scroll observer hook
 * Eliminates duplicate IntersectionObserver setups across tabs
 */

import { useEffect, useRef } from "react";

export interface UseInfiniteScrollOptions {
    /** Optional scroll root. Omit it to observe against the document viewport. */
    rootRef?: React.RefObject<Element | null>;
    /** Sentinel element ref that triggers load-more when visible */
    sentinelRef: React.RefObject<HTMLDivElement | null>;
    /** Whether more items are available to load */
    hasMore: boolean;
    /** Whether currently fetching more items */
    isLoading: boolean;
    /** Callback to load next page */
    onLoadMore: () => Promise<void>;
    /** Optional: root margin for early trigger (default: "0px 0px 400px 0px") */
    rootMargin?: string;
    /** Optional: whether this observer is active (default: true) */
    enabled?: boolean;
}

/**
 * Reusable infinite scroll hook using IntersectionObserver
 * Triggers onLoadMore when sentinel element becomes visible within rootMargin
 */
export const useInfiniteScroll = ({
    rootRef,
    sentinelRef,
    hasMore,
    isLoading,
    onLoadMore,
    rootMargin = "0px 0px 400px 0px",
    enabled = true,
}: UseInfiniteScrollOptions) => {
    const isLoadingRef = useRef(isLoading);

    useEffect(() => {
        isLoadingRef.current = isLoading;
    }, [isLoading]);

    useEffect(() => {
        if (!enabled || !hasMore || isLoading || !sentinelRef.current) {
            return;
        }

        // A supplied root must exist before observation. With no rootRef the
        // observer intentionally uses the document viewport.
        if (rootRef && !rootRef.current) {
            return;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting && hasMore && !isLoadingRef.current) {
                        // IntersectionObserver can deliver several entries before
                        // React has propagated isLoading. Close that window here so
                        // one intersection can enqueue at most one page.
                        isLoadingRef.current = true;
                        onLoadMore()
                            .catch((err) => console.error("Infinite scroll load error:", err))
                            .finally(() => {
                                isLoadingRef.current = false;
                            });
                    }
                });
            },
            { root: rootRef?.current ?? null, rootMargin }
        );

        observer.observe(sentinelRef.current);
        return () => observer.disconnect();
    }, [enabled, hasMore, isLoading, rootRef, sentinelRef, onLoadMore, rootMargin]);
};

