import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    outDir: "../dist-web",
    emptyOutDir: true,
  },
});
