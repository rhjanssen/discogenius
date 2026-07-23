export type ProviderPriorityItem = {
    id: string;
    authenticated: boolean;
};

function connectedProviderIds(providers: readonly ProviderPriorityItem[]): string[] {
    return providers
        .filter((provider) => provider.authenticated)
        .map((provider) => provider.id);
}

/**
 * Persist connected providers first so the first visible Settings row is also
 * the backend default. Disconnected providers remain in the saved order after
 * the active group, ready to regain their previous relative priority later.
 */
export function composeProviderPriority(
    providers: readonly ProviderPriorityItem[],
    orderedConnectedIds: readonly string[],
): string[] {
    const connected = new Set(connectedProviderIds(providers));
    const seen = new Set<string>();
    const order: string[] = [];

    for (const providerId of orderedConnectedIds) {
        if (!connected.has(providerId) || seen.has(providerId)) continue;
        seen.add(providerId);
        order.push(providerId);
    }
    for (const provider of providers) {
        if (!provider.authenticated || seen.has(provider.id)) continue;
        seen.add(provider.id);
        order.push(provider.id);
    }
    for (const provider of providers) {
        if (provider.authenticated || seen.has(provider.id)) continue;
        seen.add(provider.id);
        order.push(provider.id);
    }

    return order;
}

export function reorderConnectedProviderIds(
    providers: readonly ProviderPriorityItem[],
    providerId: string,
    direction: -1 | 1,
): string[] | null {
    const connectedIds = connectedProviderIds(providers);
    const connectedIndex = connectedIds.indexOf(providerId);
    const targetIndex = connectedIndex + direction;
    if (connectedIndex === -1 || targetIndex < 0 || targetIndex >= connectedIds.length) {
        return null;
    }

    [connectedIds[connectedIndex], connectedIds[targetIndex]] = [
        connectedIds[targetIndex],
        connectedIds[connectedIndex],
    ];
    return composeProviderPriority(providers, connectedIds);
}

export function dropConnectedProviderOn(
    providers: readonly ProviderPriorityItem[],
    providerId: string,
    targetProviderId: string,
): string[] | null {
    const connectedIds = connectedProviderIds(providers);
    const from = connectedIds.indexOf(providerId);
    const to = connectedIds.indexOf(targetProviderId);
    if (from === -1 || to === -1 || from === to) return null;

    connectedIds.splice(from, 1);
    connectedIds.splice(to, 0, providerId);
    return composeProviderPriority(providers, connectedIds);
}
