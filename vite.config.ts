import { execSync } from "node:child_process";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * A visible build stamp, shown in Settings.
 *
 * "Which version am I actually looking at" is otherwise unanswerable from a
 * phone, which turns every bug report into guesswork. That mattered most when
 * this app had a service worker; it is still worth the two lines.
 */
function buildStamp(): string {
  const sha =
    process.env.WORKERS_CI_COMMIT_SHA ??
    process.env.CF_PAGES_COMMIT_SHA ??
    (() => {
      try {
        return execSync("git rev-parse --short HEAD", {
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim();
      } catch {
        return "dev";
      }
    })();
  return `${sha.slice(0, 7)} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z`;
}

const STAMP = buildStamp();

/**
 * Writes the build stamp to /version.json as well as into the bundle.
 *
 * A URL anyone can curl answers "what is actually deployed right now"
 * without opening the app, signing in, or trusting a screenshot. Fetched
 * no-store by UpdateBanner, since a cached copy would defeat its purpose.
 */
function versionFile(): Plugin {
  return {
    name: "emit-version-json",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ build: STAMP }, null, 2) + "\n",
      });
    },
  };
}

export default defineConfig({
  define: {
    __BUILD_STAMP__: JSON.stringify(STAMP),
  },
  plugins: [react(), versionFile()],
  build: {
    // ./dist is what wrangler.jsonc serves as the Worker's asset directory.
    outDir: "dist",
    target: "es2022",
  },
  server: {
    // `npm run dev` serves the SPA with HMR but does not run the Worker, so
    // /api/* is forwarded to `wrangler dev` on its default port. Run both
    // together only when working on Phase 2; Phase 1 needs neither.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});
