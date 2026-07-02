import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Produces a single self-contained index.html with all JS, CSS and fonts
// inlined — works offline from a phone with no server or network.
export default defineConfig({
  base: "./",
  plugins: [react(), viteSingleFile()],
  build: {
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000, // inline fonts as data URIs
    chunkSizeWarningLimit: 5000,
  },
});
