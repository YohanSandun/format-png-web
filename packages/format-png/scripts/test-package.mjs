// Tests the package as users get it: packs it with `npm pack`, installs the
// tarball into an empty project, and uses it from Node through its `exports`
// only. Catches what unit tests can't: a file missing from `files`, a broken
// `exports` entry, or a wasm file the glue can't find. Also checks that no
// published JS calls fetch: the package makes no network requests.
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    const installed = join(project, "node_modules", "format-png");
    for (const file of readdirSync(installed, { recursive: true })) {
        if (file.endsWith(".js") && /\bfetch\s*\(/.test(readFileSync(join(installed, file), "utf8"))) {
            throw new Error(`${file} calls fetch; the package shouldn't make network requests`);
        }
    }
} finally {
    rmSync(work, { recursive: true, force: true });
}
