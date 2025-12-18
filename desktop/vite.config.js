import { defineConfig } from "vite";

export default defineConfig({
  root: "renderer",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: "renderer/index.html",
        spotifyCallback: "renderer/spotify-callback.html",
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});