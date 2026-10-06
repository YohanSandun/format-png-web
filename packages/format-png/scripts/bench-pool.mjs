// Times one large photo-like image (2500x3800 RGBA, about 37 segments)
// encoded by worker pools of several sizes, which split its compression across
// their workers, against encoding it on this thread. Every pool's output must
// be byte for byte that of encoding with threads: "auto", or the script fails.
//
//   npm run bench:pool
//   npm run bench:pool -- --runs 5 --level 9 --sizes 1,4,8
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { parseArgs } from "node:util";
import { createWorkerPool, encodeRgba8, init } from "../dist/index.js";
import { image } from "./bench-image.mjs";

const { values: args } = parseArgs({
    options: {
        runs: { type: "string", default: "3" },
        level: { type: "string", default: "6" },
        sizes: { type: "string", default: "1,2,4,8" },
    },
});
const runs = Number(args.runs);
const options = { compression: Number(args.level) };
const sizes = args.sizes.split(",").map(Number);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const median = (times) => times.toSorted((a, b) => a - b)[Math.floor(times.length / 2)];

async function time(fn) {
    await fn(); // warm-up: starts the workers
    const times = [];
    let result;
    for (let i = 0; i < runs; i++) {
        const start = performance.now();
        result = await fn();
        times.push(performance.now() - start);
    }
    return { median: median(times), result };
}

await init();
const pixels = image(2500, 3800, 3, 1);
console.log(`2500x3800 photo-like RGBA at level ${options.compression}, median of ${runs} runs after a warm-up`);
console.log(`Node ${process.version}, ${availableParallelism()} cores\n`);

const single = await time(() => encodeRgba8(pixels, options));
const auto = await time(() => encodeRgba8(pixels, { ...options, threads: "auto" }));
const expected = sha256(auto.result);

console.log("| | Time | vs this thread | Size |");
console.log("|---|---|---|---|");
const row = (name, ms, bytes) =>
    console.log(`| ${name} | ${(ms / 1000).toFixed(2)} s | ${(single.median / ms).toFixed(1)}× | ${(bytes / 1e6).toFixed(2)} MB |`);
row('This thread, threads: "single"', single.median, single.result.length);
row('This thread, threads: "auto"', auto.median, auto.result.length);

let identical = true;
for (const size of sizes) {
    const pool = createWorkerPool({ size });
    try {
        const { median: ms, result } = await time(() => pool.encodeRgba8(pixels, options));
        identical &&= sha256(result) === expected;
        row(`Pool of ${size}`, ms, result.length);
    } finally {
        await pool.terminate();
    }
}

if (!identical) {
    console.error('\nA pool\'s output differs from encoding with threads: "auto".');
    process.exit(1);
}
console.log('\nEvery pool\'s output is byte for byte that of threads: "auto".');
