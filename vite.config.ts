import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    proxy: {
      // Preserve the browser's Host so API origin checks also work in development.
      "/api": { target: "http://127.0.0.1:3000", changeOrigin: false },
    },
  },
});
