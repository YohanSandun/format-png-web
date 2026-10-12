import { defineConfig } from "vite";

export default defineConfig({
    // Module workers, as format-png's worker pool uses: its worker imports the rest of the package.
    worker: { format: "es" },
    // format-png embeds its WebAssembly module, about 420 kB as base64, so the app's chunk is larger than Vite expects.
    build: { chunkSizeWarningLimit: 1024 },
});
