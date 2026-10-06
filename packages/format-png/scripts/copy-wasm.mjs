import { cpSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

// The .wasm file itself stays out: it's embedded in format_png_wasm_bg.wasm.base64.js.
const skip = new Set(["format_png_wasm_bg.wasm", "format_png_wasm_bg.wasm.d.ts"]);

// Paths, not URLs: cpSync ignores `filter` when given URLs.
cpSync(fileURLToPath(new URL("../src/wasm", import.meta.url)), fileURLToPath(new URL("../dist/wasm", import.meta.url)), {
    recursive: true,
    filter: (source) => !skip.has(basename(source)),
});
