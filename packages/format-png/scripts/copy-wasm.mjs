import { cpSync } from "node:fs";

cpSync(new URL("../src/wasm", import.meta.url), new URL("../dist/wasm", import.meta.url), {
    recursive: true,
});
