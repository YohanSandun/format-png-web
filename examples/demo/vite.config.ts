import { defineConfig } from "vite";

export default defineConfig({
    // Pre-bundling would move the glue away from its .wasm file.
    optimizeDeps: { exclude: ["format-png"] },
    // Module workers, so the Minimize worker can import format-png like the page does.
    worker: { format: "es" },
});