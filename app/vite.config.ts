import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import { readFileSync } from "fs";
import path from "path";

// https://vitejs.dev/config/
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8")
) as { version?: string };

const DEFAULT_BACKEND_PORT = 3737;

function resolveBackendPort(rawPort: string | undefined): number {
  const parsed = Number.parseInt(String(rawPort || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_BACKEND_PORT;
  }

  return parsed;
}

export default defineConfig(({ mode }) => {
  const repoRoot = path.resolve(__dirname, "..");
  const env = loadEnv(mode, repoRoot, "");
  const backendTarget = `http://localhost:${resolveBackendPort(env.PORT || process.env.PORT)}`;

  return {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version || "0.0.0"),
    },
    envDir: repoRoot,
    server: {
      host: "::",
      port: 8080,
      proxy: {
        '/api': {
          target: backendTarget,
          changeOrigin: true,
          secure: false,
        },
        '/app-auth': {
          target: backendTarget,
          changeOrigin: true,
          secure: false,
        },
        '/health': {
          target: backendTarget,
          changeOrigin: true,
          secure: false,
        },
        '/proxy': {
          target: backendTarget,
          changeOrigin: true,
          secure: false,
        },
        '/services/ultrablur': {
          target: backendTarget,
          changeOrigin: true,
          secure: false,
        },
      },
    },
    plugins: [
      react(),
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "@contracts": path.resolve(__dirname, "../api/src/contracts"),
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('/node_modules/')) return undefined;

            if (id.includes('@tanstack/react-query')) {
              return 'query';
            }

            if (id.includes('@fluentui/react-icons')) {
              return 'fluent-icons';
            }

            if (id.includes('@griffel/')) {
              return 'fluent-styles';
            }

            if (
              id.includes('@floating-ui/') ||
              id.includes('tabster') ||
              id.includes('@fluentui/react-components') ||
              id.includes('@fluentui/react-') ||
              id.includes('@fluentui/priority-overflow')
            ) {
              return 'fluent-components';
            }

            if (
              id.includes('@fluentui/')
            ) {
              return 'fluent-core';
            }

            if (
              id.includes('/react-dom/') ||
              id.includes('/react-router-dom/') ||
              id.includes('/react-router/') ||
              id.includes('/react/')
            ) {
              return 'react-vendor';
            }

            return undefined;
          },
        },
      },
    },
  };
});


