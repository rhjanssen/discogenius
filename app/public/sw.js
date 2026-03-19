const CACHE_VERSION = "v3";
const SHELL_CACHE = `discogenius-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `discogenius-assets-${CACHE_VERSION}`;
const IMAGE_CACHE = `discogenius-images-${CACHE_VERSION}`;

const CORE_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/assets/images/favicon.ico",
  "/assets/images/apple-icon-180.png",
  "/assets/images/icon-192.png",
  "/assets/images/icon-512.png",
  "/assets/images/manifest-icon-192.maskable.png",
  "/assets/images/manifest-icon-512.maskable.png",
  "/assets/images/dolby_atmos_logo.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("discogenius-") && ![SHELL_CACHE, ASSET_CACHE, IMAGE_CACHE].includes(key))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/services/") || url.pathname === "/health") {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  const isHashedAsset = url.pathname.startsWith("/assets/")
    && ["script", "style", "worker", "font"].includes(request.destination);
  if (isHashedAsset) {
    event.respondWith(cacheFirstWithRefresh(request, ASSET_CACHE));
    return;
  }

  if (request.destination === "image") {
    event.respondWith(staleWhileRevalidate(request, IMAGE_CACHE));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
});

function isCacheableResponse(response) {
  return Boolean(response) && response.ok && response.type === "basic";
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (isCacheableResponse(response)) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put("/index.html", response.clone());
    }
    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const cached = (await cache.match(request)) || (await cache.match("/index.html"));
    return cached || new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function cacheFirstWithRefresh(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request)
    .then(async (response) => {
      if (isCacheableResponse(response)) {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  return cached || (await networkFetch) || new Response("Offline", { status: 503, statusText: "Offline" });
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request)
    .then(async (response) => {
      if (isCacheableResponse(response)) {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  return cached || (await networkFetch) || new Response("Offline", { status: 503, statusText: "Offline" });
}
