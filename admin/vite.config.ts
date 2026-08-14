import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The admin panel talks to the Ride91 backend via /api. In development we
// proxy /api → localhost:8001 so we don't need to worry about CORS. In
// production, the deployed static site should be served behind a reverse
// proxy that rewrites /api to the FastAPI backend on the same domain, or
// set VITE_API_URL to a fully-qualified backend URL.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: "http://localhost:8001",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
