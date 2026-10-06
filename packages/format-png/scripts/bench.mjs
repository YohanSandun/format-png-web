// Times the built package on two large 2500x3800 RGBA images: decodeRgba8,
// and encodeRgba8 at levels 6 and 9 and with filter "none". Prints the median
// of several runs after a warm-up, the .wasm size, and a SHA-256 of every
// output.
//
//   npm run bench                         # dist/: about 2 minutes
//   npm run bench -- --quick              # the smooth image only, no level 9: seconds
//   npm run bench -- --runs 9             # more runs of the fast cases
//   npm run bench -- --dist a --dist b    # compare builds (copies of dist/)
//
// Each case gets as many runs as fit in about 15 s per build, at least 3 and
// at most --runs (default 5): level 9 on the photo-like image takes 15 s a run.
//
// With several builds, runs alternate between them, so a machine slowing down
// or speeding up during the benchmark affects every build alike. The outputs
// of every build must be byte for byte the same: build settings such as the
// optimization level must never change them. If any differ, the script fails.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { image } from "./bench-image.mjs";

const { values: args } = parseArgs({
    options: { runs: { type: "string", default: "5" }, quick: { type: "boolean" }, dist: { type: "string", multiple: true } },
});
const maxRuns = Number(args.runs);
const minRuns = Math.min(3, maxRuns);
const budget = 15_000;
const dists = (args.dist ?? [new URL("../dist", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")]).map((dir) => resolve(dir));

const builds = [];
for (const dir of dists) {
    // core.js, the sync API: unlike index.js, it imports nothing through package.json, so a copy of dist/ anywhere works.
    const api = await import(pathToFileURL(`${dir}/core.js`).href);
    await api.init();
    const base64 = (await import(pathToFileURL(`${dir}/wasm/format_png_wasm_bg.wasm.base64.js`).href)).default;
    builds.push({ name: dists.length > 1 ? basename(dir) : "dist", api, wasmSize: Buffer.from(base64, "base64").length });
}

// Level 9 only on the photo-like image, where it matters most: it takes as long on both.
const images = {
    ...(args.quick ? {} : { "photo-like": { pixels: image(2500, 3800, 3, 1), level9: true } }),
    smooth: { pixels: image(2500, 3800, 1, 0.05), level9: false },
};

const cases = (api, pixels, png, level9) => ({
    decodeRgba8: () => api.decodeRgba8(png).data,
    "encode, level 6": () => api.encodeRgba8(pixels, { compression: 6 }),
    ...(level9 ? { "encode, level 9": () => api.encodeRgba8(pixels, { compression: 9 }) } : {}),
    'encode, filter "none"': () => api.encodeRgba8(pixels, { filter: "none" }),
});

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const median = (times) => times.toSorted((a, b) => a - b)[Math.floor(times.length / 2)];

console.log(`Median of ${minRuns} to ${maxRuns} runs after a warm-up, Node ${process.version}`);
console.log(builds.map((build) => `${build.name}: .wasm ${(build.wasmSize / 1000).toFixed(0)} kB`).join(", "));
let identical = true;

for (const [imageName, { pixels, level9 }] of Object.entries(images)) {
    const png = builds[0].api.encodeRgba8(pixels, { compression: 6 });
    console.log(`\n${imageName}: 2500x3800 RGBA, ${(png.length / 1e6).toFixed(1)} MB at level 6\n`);
    console.log(`| Case | Runs | ${builds.map((build) => build.name).join(" | ")} | Output |`);
    console.log(`|---|---|${builds.map(() => "---|").join("")}---|`);

    const caseNames = Object.keys(cases(builds[0].api, pixels, png, level9));
    for (const caseName of caseNames) {
        const fns = builds.map((build) => cases(build.api, pixels, png, level9)[caseName]);
        const times = builds.map(() => []);
        const hashes = new Set();
        let size = 0;
        const start = performance.now();
        for (const fn of fns) fn(); // warm-up
        const warmUp = (performance.now() - start) / fns.length;
        const runs = Math.max(minRuns, Math.min(maxRuns, Math.floor(budget / warmUp)));
        for (let run = 0; run < runs; run++) {
            for (const [i, fn] of fns.entries()) {
                const start = performance.now();
                const result = fn();
                times[i].push(performance.now() - start);
                if (run === 0) {
                    hashes.add(sha256(result));
                    size = result.length;
                }
            }
        }
        const medians = times.map(median);
        const cells = medians.map((ms, i) => {
            const change = i === 0 ? "" : ` (${ms < medians[0] ? "" : "+"}${(((ms - medians[0]) / medians[0]) * 100).toFixed(0)}%)`;
            return `${ms.toFixed(0)} ms${change}`;
        });
        const same = hashes.size === 1;
        identical &&= same;
        const output = `${(size / 1e6).toFixed(2)} MB, ${same ? `sha256 ${[...hashes][0].slice(0, 12)}…` : "DIFFERENT between builds"}`;
        console.log(`| ${caseName} | ${runs} | ${cells.join(" | ")} | ${output} |`);
    }
}

if (!identical) {
    console.error("\nThe builds' outputs differ.");
    process.exit(1);
}
if (builds.length > 1) console.log("\nEvery output is byte for byte the same in every build.");
