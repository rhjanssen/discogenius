import { refreshTidalToken, loadToken, shouldRefreshToken } from './tidal.js';

// Check every 30 minutes (in milliseconds)
export const TOKEN_CHECK_INTERVAL = 30 * 60 * 1000;

// Refresh threshold: 30 minutes (in seconds)
export const TOKEN_REFRESH_THRESHOLD = 30 * 60;

let tokenRefreshInterval: NodeJS.Timeout | null = null;

/**
 * Initialize token refresh interval
 * Checks every 30 minutes if token needs refresh
 */
export function startTokenRefreshInterval() {
    // Clear any existing interval
    if (tokenRefreshInterval) {
        clearInterval(tokenRefreshInterval);
    }

    console.log(
        `✅ [TOKEN] Token refresh interval started (checks every ${TOKEN_REFRESH_THRESHOLD / 60} minutes)`
    );

    // Run immediately on startup
    void checkAndRefreshToken();

    // Then check every 30 minutes
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
    try {
        await refreshTidalToken();
    } catch (error) {
        console.error('[TOKEN] Failed to refresh token:', error);
    }
}
