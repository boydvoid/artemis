import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Port 5173 is Vite's default and is routinely taken by another project's
// dev server. That is worse than a clash here: `native dev` waits for
// app.zon's dev URL to answer, so a stranger on 5173 reads as "ready" and
// the shell loads someone else's app. strictPort makes a taken port fail
// loudly instead of silently sliding to 5174.
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
