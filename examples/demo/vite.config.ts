import { defineConfig } from "vite";

export default defineConfig({
    // Pre-bundling would move the glue away from its .wasm file.
    optimizeDeps: { exclude: ["format-png"] },
});