import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig({
  // Served under /admin by the FastAPI backend, because "/" is the consumer
  // landing page. Asset URLs in the built index.html are prefixed with this;
  // the router's basename in main.tsx has to agree with it.
  base: "/admin/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
  },
});
