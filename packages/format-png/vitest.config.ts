import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: "node",
                    include: ["src/**/*.test.ts"],
                    exclude: [...configDefaults.exclude, "src/**/*.browser.test.ts"],
                },
            },
            {
                // The worker pool in Chromium, as Vite bundles it: `npm run test:browser`.
                test: {
                    name: "browser",
                    include: ["src/**/*.browser.test.ts"],
                    browser: { enabled: true, provider: playwright(), headless: true, instances: [{ browser: "chromium" }] },
                },
            },
        ],
    },
});
