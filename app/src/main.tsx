import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import {
  shouldAttemptChunkReload,
} from "@/utils/chunkReload";

// Self-heal: when a code-split chunk fails to load (common after rebuilds/restarts
// or while the API event loop is stalled), force a one-time reload.
const reloadOnce = () => {
  if (!shouldAttemptChunkReload()) return;
  const url = new URL(window.location.href);
  url.searchParams.set("reload", String(Date.now()));
  window.location.replace(url.toString());
};

// Vite emits this in production when preloading a dynamic import fails.
window.addEventListener("vite:preloadError", reloadOnce as EventListener);

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
