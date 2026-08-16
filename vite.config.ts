import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const PROXY_PORT = Number(process.env.WEBUI_PROXY_PORT ?? 4097);
const VITE_PORT = Number(process.env.WEBUI_VITE_PORT ?? 5173);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: VITE_PORT,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${PROXY_PORT}`,
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
