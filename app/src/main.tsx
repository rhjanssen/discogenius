import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// Self-heal: when a code-split chunk fails to load (common after rebuilds/restarts),
// force a one-time reload with a cache-busting query param.
const reloadOnce = () => {
  const key = "discogenius:chunk-reload";
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
  } catch {
    // ignore
  }
  const url = new URL(window.location.href);
  url.searchParams.set("reload", String(Date.now()));
  window.location.replace(url.toString());
};

// Vite emits this in production when preloading a dynamic import fails.
window.addEventListener("vite:preloadError", reloadOnce as any);

// Extra safety net for browsers that surface chunk failures as window.onerror.
window.addEventListener("error", (e) => {
  const msg = (e as ErrorEvent).message || "";
  if (
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Loading chunk") ||
    msg.includes("ChunkLoadError")
  ) {
    reloadOnce();
  }
});

const registerServiceWorker = () => {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) {
    return;
  }

  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });

      // Keep updates quiet and predictable. A new worker can wait until the next
      // navigation instead of forcing a controller change and reload loop.
      void registration.update();
    } catch {
      // ignore
    }
  });
};

registerServiceWorker();

createRoot(document.getElementById("root")!).render(<App />);
