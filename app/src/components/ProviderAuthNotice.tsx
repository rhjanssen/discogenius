import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ProviderAuthBanner, providerAuthWaitingText, type ProviderAuthBannerItem } from "@/components/ProviderAuthBanner";
import { useGlobalEvents } from "@/hooks/useGlobalEvents";
import { useToast } from "@/hooks/useToast";
import { api } from "@/services/api";

const QUERY_KEY = ["provider-auth-health"] as const;

function providerLabel(provider: string): string {
  if (provider === "tidal") return "Tidal";
  if (provider === "deezer") return "Deezer";
  if (provider === "apple-music") return "Apple Music";
  return provider;
}

/** Polls login state, toasts once per server transition, and shows the banner. */
export function ProviderAuthNotice() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const lastEvent = useGlobalEvents(["provider.auth.changed"]);
  const seenEvent = useRef<typeof lastEvent>(null);
  const [retrying, setRetrying] = useState(false);
  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.getProviderAuthHealth(),
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (!lastEvent || seenEvent.current === lastEvent) return;
    seenEvent.current = lastEvent;
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    const payload = lastEvent.data ?? {};
    const provider = typeof payload.provider === "string" ? payload.provider : "";
    const held = Number(payload.held ?? 0);
    if (payload.status === "needs_reauth") {
      toast({
        title: typeof payload.banner === "string" && payload.banner
          ? payload.banner
          : `${providerLabel(provider)} opnieuw koppelen`,
        description: providerAuthWaitingText(providerLabel(provider), Number.isFinite(held) ? held : 0),
        variant: "destructive",
      });
      return;
    }
    if (payload.status === "ok") {
      toast({
        title: `${providerLabel(provider)} is weer gekoppeld`,
        description: "Wachtende albums gaan verder.",
        variant: "warning",
      });
    }
  }, [lastEvent, queryClient, toast]);

  const items: ProviderAuthBannerItem[] = (data?.providers ?? [])
    .filter((row) => row.status === "needs_reauth" && row.banner && row.href)
    .map((row) => ({
      provider: row.provider,
      label: providerLabel(row.provider),
      banner: row.banner as string,
      held: row.held,
      href: row.href as string,
    }));

  const retry = () => {
    if (retrying) return;
    setRetrying(true);
    void api.retryAuthFailedAlbums()
      .then((result) => {
        toast({
          title: result.requeued === 1
            ? "1 album terug in de wachtrij"
            : `${result.requeued} albums terug in de wachtrij`,
          variant: "warning",
        });
        void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      })
      .catch((error: unknown) => {
        toast({
          title: "Opnieuw proberen mislukt",
          description: error instanceof Error ? error.message : "De wachtrij is niet bijgewerkt.",
          variant: "destructive",
        });
      })
      .finally(() => setRetrying(false));
  };

  return <ProviderAuthBanner items={items} onRetry={retry} retrying={retrying} />;
}
