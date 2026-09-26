import { defineConfig } from "vite";

// The public site bundle — one page template (web/site/index.html), one small script, one
// stylesheet, no MapLibre. `earthdeck watch export` fills the template with each
// server-rendered page and copies assets/ + public files (og.png) next to the ledger files.
export default defineConfig({
  root: "web/site",
  base: "./",
  build: {
    outDir: "../../dist/site",
    emptyOutDir: true,
    sourcemap: false,
  },
});
