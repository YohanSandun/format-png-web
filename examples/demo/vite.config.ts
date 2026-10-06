import { defineConfig } from "vite";

export default defineConfig({
    // Module workers, so the Minimize worker can import format-png like the page does.
    worker: { format: "es" },
});