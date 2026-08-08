import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The version is defined ONCE, in app.zon (the app manifest the native shell
// and packager already read). The frontend must not keep its own copy that
// can drift, so we read app.zon's `.version` here and hand it to the client
// as the compile-time constant `__APP_VERSION__`. A missing/unreadable
// manifest falls back to "dev" rather than failing the build.
function appVersion() {
  try {
    const zon = fs.readFileSync(path.resolve(import.meta.dirname, "../app.zon"), "utf8");
    const match = zon.match(/\.version\s*=\s*"([^"]+)"/);
    return match ? match[1] : "dev";
  } catch {
    return "dev";
  }
}

// Port 5173 is Vite's default and is routinely taken by another project's
// dev server. That is worse than a clash here: `native dev` waits for
// app.zon's dev URL to answer, so a stranger on 5173 reads as "ready" and
// the shell loads someone else's app. strictPort makes a taken port fail
// loudly instead of silently sliding to 5174.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5199,
    strictPort: true,
  },
});
