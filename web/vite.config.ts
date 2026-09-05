import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// The page is served from the APT repository root (the "baseurl"), alongside
// index.json — so the production build writes straight into ../repo.
export default defineConfig({
  base: "./",
  plugins: [vue(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("../repo", import.meta.url)),
    // NEVER empty: ../repo holds the actual APT repository (dists/, pool/, …).
    // Stale hashed assets are pruned by the `prebuild` npm script instead.
    emptyOutDir: false,
  },
  server: {
    proxy: {
      // During `vite dev`, forward repository data to a locally served repo/.
      // Start one with: python3 -m http.server 8137 --directory repo
      "^/(index\\.json|dists|pool|conf|db)(/|$)": {
        target: process.env.VITE_REPO_ORIGIN ?? "http://127.0.0.1:8137",
        changeOrigin: true,
      },
    },
  },
});
