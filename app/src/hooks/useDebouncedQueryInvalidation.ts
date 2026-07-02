import { useCallback, useEffect, useRef } from "react";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useGlobalEvents } from "@/hooks/useGlobalEvents";

interface UseDebouncedQueryInvalidationOptions {
  queryKeys: QueryKey[];
  globalEvents?: string[];
  windowEvents?: string[];
  debounceMs?: number;
  enabled?: boolean;
}

export function useDebouncedQueryInvalidation({
  queryKeys,
  globalEvents,
  windowEvents,
  debounceMs = 300,
  enabled = true,
}: UseDebouncedQueryInvalidationOptions) {
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastGlobalEvent = useGlobalEvents(enabled ? (globalEvents ?? []) : []);

  // Callers rebuild queryKeys every render; read them through a ref so
  // scheduleInvalidation stays referentially stable. Otherwise the effects
  // below re-run on every render and each refetch re-schedules the next one,
  // producing an endless invalidate/refetch loop.
  const queryKeysRef = useRef(queryKeys);
  queryKeysRef.current = queryKeys;

  const scheduleInvalidation = useCallback(() => {
    if (!enabled) {
      return;
    }

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      for (const queryKey of queryKeysRef.current) {
        // invalidateQueries already refetches active queries; a follow-up
        // refetchQueries would cancel that in-flight fetch and start another.
        void queryClient.invalidateQueries({ queryKey });
      }
    }, debounceMs);
  }, [debounceMs, enabled, queryClient]);

  useEffect(() => {
    if (!lastGlobalEvent) {
      return;
    }

    scheduleInvalidation();
  }, [lastGlobalEvent, scheduleInvalidation]);

  useEffect(() => {
    if (!enabled || !windowEvents?.length) {
      return;
    }

    for (const eventName of windowEvents) {
      window.addEventListener(eventName, scheduleInvalidation);
    }

    return () => {
      for (const eventName of windowEvents) {
        window.removeEventListener(eventName, scheduleInvalidation);
      }
    };
  }, [enabled, scheduleInvalidation, windowEvents]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);
}
