import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * `pnpm --filter @alden/ui dev` serves the UI with hot reload and forwards /api to an `alden ui` you started with
 * `alden ui --no-open --port 4318`. Open the dev server with the printed link's `#t=…` fragment.
 */
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: {
    proxy: {
      "/api": {
        target: process.env.ALDEN_UI_API ?? "http://127.0.0.1:4318",
        changeOrigin: true,
        // The API only accepts its own origin; the dev server is a different one.
        configure: (proxy) => proxy.on("proxyReq", (req) => req.removeHeader("origin")),
      },
    },
  },
});
