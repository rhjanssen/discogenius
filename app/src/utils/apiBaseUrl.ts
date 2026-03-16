export function getApiBaseUrl() {
  // In local dev, keep API calls same-origin so Vite proxy tracks backend PORT automatically.
  if (import.meta.env.DEV) {
    return window.location.origin;
  }

  if (import.meta.env.VITE_API_URL) {
    return String(import.meta.env.VITE_API_URL).trim().replace(/\/+$/, '');
  }

  return window.location.origin;
}
