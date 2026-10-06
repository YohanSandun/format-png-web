// Tests the package as users get it: packs it with `npm pack`, installs the
// tarball into an empty project, and uses it from Node through its `exports`
// only. Catches what unit tests can't: a file missing from `files`, a broken
// `exports` entry, or an embedded module that doesn't load. Also checks that no
// .wasm file is published and no published JS calls fetch: the package makes
// no network requests. Then runs the worker pool from Node, and builds a
// browser app using it with Vite, to check the worker is bundled and none of
// the Node-only adapters are.
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "format-png-package-"));
const run = (command, cwd) => execSync(command, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString().trim();

try {
    const tarball = join(work, run(`npm pack --silent --pack-destination "${work}"`, packageDir).split("\n").at(-1));
    const project = join(work, "project");
    mkdirSync(project);
    run(`npm init -y`, project);
    run(`npm install --no-audit --no-fund "${tarball}"`, project);

    writeFileSync(
        join(project, "smoke.mjs"),
        `
import assert from "node:assert/strict";
import { init, decode, decodeRgba8, encode, encodeRgba8, readChunks, readHeader, PngError } from "format-png";

// The embedded module, as the docs say to load it.
await init();

const data = Uint8Array.from({ length: 4 * 3 * 4 }, (_, i) => (i * 37) % 256);
const png = encodeRgba8({ width: 4, height: 3, data, metadata: { text: [{ keyword: "Title", text: "smoke" }] } }, { compression: 9 });
assert.deepEqual(readHeader(png), { width: 4, height: 3, bitDepth: 8, colorType: "rgba", interlaced: false });
assert.deepEqual([...decodeRgba8(png).data], [...data]);
assert.equal(readChunks(png).metadata.text[0].text, "smoke");

// 16-bit round trip, byte for byte.
const header = { width: 2, height: 1, bitDepth: 16, colorType: "grayscale", interlaced: false };
const samples = new Uint8Array([0x12, 0x34, 0xfe, 0xdc]);
assert.deepEqual([...decode(encode({ header, data: samples })).data], [...samples]);

assert.throws(() => decodeRgba8(new Uint8Array([1, 2, 3])), PngError);
console.log("format-png package OK");
`,
    );
    console.log(run("node smoke.mjs", project));

    writeFileSync(
        join(project, "pool.mjs"),
        `
import assert from "node:assert/strict";
import { createWorkerPool, init, decodeRgba8, decodeRgba8Async, encodeRgba8, encodeRgba8Async, readChunks, PngError, WorkerPoolError } from "format-png";

await init(); // only for the sync results to compare with; the pool doesn't need it
const data = Uint8Array.from({ length: 64 * 48 * 4 }, (_, i) => (i * 37) % 256);
const png = encodeRgba8({ width: 64, height: 48, data, metadata: { text: [{ keyword: "Title", text: "pool" }] } });

const pool = createWorkerPool({ size: 2 });
const results = await Promise.all([1, 6, 9].map((compression) => pool.encodeRgba8({ width: 64, height: 48, data }, { compression })));
assert.deepEqual(results, [1, 6, 9].map((compression) => encodeRgba8({ width: 64, height: 48, data }, { compression })));
assert.deepEqual(await pool.decodeRgba8(png), decodeRgba8(png));
assert.deepEqual(await pool.readChunks(png), readChunks(png));
await assert.rejects(pool.decodeRgba8(new Uint8Array([1, 2, 3])), PngError);

const moved = png.slice();
const job = pool.decodeRgba8(moved, { transfer: true });
assert.equal(moved.byteLength, 0);
assert.deepEqual((await job).data, decodeRgba8(png).data);

await pool.terminate();
await assert.rejects(pool.readHeader(png), WorkerPoolError);

// The async functions, on the shared pool: no pool to create or terminate.
assert.deepEqual(await decodeRgba8Async(png), decodeRgba8(png));
assert.deepEqual(await encodeRgba8Async({ width: 64, height: 48, data }), encodeRgba8({ width: 64, height: 48, data }));
console.log("format-png worker pool OK");
`,
    );
    console.log(run("node pool.mjs", project));

    // A browser app, built with the demo's Vite: the worker must be bundled,
    // with the web adapters, and nothing Node-only may reach the bundle.
    const vitePackage = createRequire(new URL("../../../examples/demo/package.json", import.meta.url)).resolve("vite/package.json");
    const vite = join(dirname(vitePackage), JSON.parse(readFileSync(vitePackage, "utf8")).bin.vite);
    writeFileSync(join(project, "index.html"), `<!doctype html><script type="module" src="./main.js"></script>`);
    writeFileSync(
        join(project, "main.js"),
        `import { createWorkerPool } from "format-png";
const pool = createWorkerPool();
globalThis.result = pool.readHeader(new Uint8Array(8));
`,
    );
    writeFileSync(join(project, "vite.config.mjs"), `export default { logLevel: "warn", worker: { format: "es" } };
`);
    run(`node "${vite}" build`, project);
    const assets = join(project, "dist", "assets");
    const bundle = readdirSync(assets).filter((file) => file.endsWith(".js")).map((file) => [file, readFileSync(join(assets, file), "utf8")]);
    const workers = bundle.filter(([, code]) => code.includes("parseText") && code.includes("addEventListener"));
    if (bundle.length < 2 || workers.length === 0) throw new Error(`Vite didn't bundle the pool's worker: ${bundle.map(([file]) => file).join(", ")}`);
    for (const [file, code] of bundle) {
        if (/worker_threads|node:os|parentPort/.test(code)) throw new Error(`${file}: a Node-only adapter was bundled for the browser`);
    }
    console.log(`Vite bundles the worker pool: ${bundle.map(([file]) => file).join(", ")}`);

    // With esbuild, which doesn't bundle workers, the worker is built from the
    // `format-png/worker.js` export. It must survive tree shaking.
    const esbuild = await import("esbuild");
    const { outputFiles } = await esbuild.build({
        stdin: { contents: `import "format-png/worker.js";`, resolveDir: project },
        bundle: true, format: "esm", platform: "browser", write: false, logLevel: "silent",
    });
    const worker = outputFiles[0].text;
    if (!worker.includes("addEventListener") || !worker.includes("parseText")) throw new Error("esbuild dropped format-png/worker.js: check `sideEffects`");
    if (/worker_threads|parentPort/.test(worker)) throw new Error("esbuild bundled the worker's Node adapter for the browser");
    console.log("esbuild bundles format-png/worker.js");

    const installed = join(project, "node_modules", "format-png");
    for (const file of readdirSync(installed, { recursive: true })) {
        if (file.endsWith(".wasm")) throw new Error(`${file} is published; the module should only be embedded`);
        if (file.endsWith(".js") && /\bfetch\s*\(/.test(readFileSync(join(installed, file), "utf8"))) {
            throw new Error(`${file} calls fetch; the package shouldn't make network requests`);
        }
    }
} finally {
    rmSync(work, { recursive: true, force: true });
}
