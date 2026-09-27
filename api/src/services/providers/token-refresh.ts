import { streamingProviderManager } from "./index.js";

// Check often enough to refresh before the downloader's own OAuth window.
export const TOKEN_CHECK_INTERVAL = 5 * 60 * 1000;

let tokenRefreshInterval: NodeJS.Timeout | null = null;

/**
 * Initialize token refresh interval
 * Checks every five minutes if a provider token needs refresh.
 */
export function startTokenRefreshInterval() {
    // Clear any existing interval
    if (tokenRefreshInterval) {
        clearInterval(tokenRefreshInterval);
    }

    console.log(
        `✅ [TOKEN] Token refresh interval started (checks every ${TOKEN_CHECK_INTERVAL / 60_000} minutes)`
    );

    // Run immediately on startup
    void checkAndRefreshToken();

    // Then check every five minutes.
    tokenRefreshInterval = setInterval(() => {
        void checkAndRefreshToken();
    }, TOKEN_CHECK_INTERVAL);
}

/**
 * Stop the token refresh interval (used during shutdown)
 */
export function stopTokenRefreshInterval() {
    if (tokenRefreshInterval) {
        clearInterval(tokenRefreshInterval);
        tokenRefreshInterval = null;
        console.log('⏹️ [TOKEN] Token refresh interval stopped');
    }
}

/**
 * Check if token needs refresh and refresh if needed
 */
async function checkAndRefreshToken() {
    const providers = streamingProviderManager
        .getAllStreamingProviders()
        .filter((provider) => provider.refreshProviderToken);

    try {
        await Promise.all(providers.map((provider) => provider.refreshProviderToken?.()));
    } catch (error) {
        console.error('[TOKEN] Failed to refresh token:', error);
    }
}
