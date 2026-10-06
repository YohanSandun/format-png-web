import { defineConfig } from "vite";

export default defineConfig({
    // Module workers, as format-png's worker pool uses: its worker imports the rest of the package.
    worker: { format: "es" },
});