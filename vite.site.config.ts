import { defineConfig } from "vite";

// The public site bundle — one page template (web/site/index.html), one small script, one
// stylesheet. MapLibre ships only in the lazy `explore` chunk (web/src/site/map/explore.ts),
// fetched when a reader reaches for the map, never before. `earthdeck watch export` fills the
// template with each server-rendered page and copies assets/ + public files next to the ledger.
export default defineConfig({
  root: "web/site",
  base: "./",
  build: {
    outDir: "../../dist/site",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1100, // the lazy MapLibre chunk (~270 kB gz); the entry stays ~11 kB gz
  },
});
