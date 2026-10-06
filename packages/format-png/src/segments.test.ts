// One image's compression split across the pool's workers, in Node. Runs
// against dist/: run `npm run build` first.
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
    PngError, WorkerPoolError, createWorkerPool, decode, decodeRgba8, encode, encodeRgba8, init,
    type EncodeOptions, type PngImage, type WorkerPool,
} from "../dist/index.js";

const fixture = (name: string) =>
    readFileSync(new URL(`../../../../format-png/tests/data/${name}`, import.meta.url));

const workerUrl = new URL("../dist/worker.js", import.meta.url);

/** How many prepared images `worker` holds. It answers between tasks; a worker the pool stopped holds none. */
function handlesIn(worker: Worker): Promise<number> {
    return new Promise((resolve) => {
        const done = (count: number) => {
            worker.off("message", onMessage);
            worker.off("exit", onExit);
            resolve(count);
        };
        const onMessage = (message: { id: number; value: number }) => {
            if (message.id === -1) done(message.value);
        };
        const onExit = () => done(0);
        worker.on("message", onMessage);
        worker.on("exit", onExit);
        worker.postMessage({ id: -1, op: "handles", args: [] });
    });
}

/** Real workers, kept so a test can ask them about prepared images, recording the ops each is sent. */
function countingWorkers() {
    const workers: Worker[] = [];
    const ops = new Map<Worker, string[]>();
    const createWorker = () => {
        const worker = new Worker(workerUrl);
        workers.push(worker);
        const sent: string[] = [];
        ops.set(worker, sent);
        const postMessage = worker.postMessage.bind(worker);
        worker.postMessage = (message: { id: number; op: string }, transfer?: readonly ArrayBuffer[]) => {
            if (message.id !== -1) sent.push(message.op);
            postMessage(message, transfer as ArrayBuffer[]);
        };
        return worker;
    };
    const live = () => workers.filter((worker) => worker.threadId !== -1);
    /** How many prepared images the live workers hold together. */
    const handles = async () => (await Promise.all(live().map(handlesIn))).reduce((sum, count) => sum + count, 0);
    return { workers, ops, live, createWorker, handles };
}

/** Smooth gradients plus a little noise, like a photo. */
function photo(width: number, height: number, seed = 1) {
    const data = new Uint8Array(width * height * 4);
    let state = seed;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            state = (state * 1103515245 + 12345) >>> 0;
            const noise = (state >>> 29) - 4;
            const i = (y * width + x) * 4;
            data[i] = (x * 255) / width + noise;
            data[i + 1] = (y * 255) / height + noise;
            data[i + 2] = ((x + y) * 127) / (width + height) + 64 + noise;
            data[i + 3] = 255;
        }
    }
    return { width, height, data };
}

/** At most 200 colors, so `palette: "auto"` makes it indexed. */
function fewColors(width: number, height: number) {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const color = ((i % width) * 7 + Math.floor(i / width) * 3) % 200;
        data.set([color, 255 - color, (color * 5) % 256, 255], i * 4);
    }
    return { width, height, data };
}

const asPngImage = ({ width, height, data }: { width: number; height: number; data: Uint8Array }, interlaced = false): PngImage =>
    ({ header: { width, height, bitDepth: 8, colorType: "rgba", interlaced }, data });

// 1024x1024 RGBA: 4 MiB of filtered data, so 5 segments.
let big: PngImage;
let pool: WorkerPool;

beforeAll(async () => {
    await init();
    big = asPngImage(photo(1024, 1024));
});

afterEach(async () => {
    await pool?.terminate();
});

// Large images, encoded both in the pool and on this thread: slower than the default 5 s.
describe("splitting an encode across the pool", { timeout: 120_000 }, () => {
    const metadata = {
        gamma: 0.45455,
        text: [{ keyword: "Title", text: "segments" }, { keyword: "Comment", text: "ü".repeat(100), chunkType: "iTXt" as const, compressed: true }],
        iccProfile: { name: "Test", profile: new Uint8Array(4000).fill(7) },
    };
    // Each over 3 MiB of filtered data: several segments.
    const cases: [string, () => PngImage, EncodeOptions][] = [
        ["level 1", () => big, { compression: 1 }],
        ["level 6", () => big, {}],
        ["level 9", () => big, { compression: 9 }],
        ["fixed blocks, paeth", () => big, { compressionStrategy: "fixed", filter: "paeth" }],
        ["palette auto", () => asPngImage(fewColors(1800, 1800)), { palette: "auto" }],
        ["strip all", () => ({ ...big, metadata }), { strip: "all" }],
        ["interlaced", () => asPngImage(photo(1024, 1024), true), {}],
        ["metadata and chunks", () => ({ ...big, metadata, chunks: [{ type: "ruSt", data: new Uint8Array([1, 2, 3]), position: "after-image-data" }] }), {}],
    ];
    for (const [name, image, options] of cases) {
        it(`gives the same bytes as threads: "auto": ${name}`, async () => {
            pool = createWorkerPool({ size: 4 });
            expect(await pool.encode(image(), options)).toEqual(encode(image(), { ...options, threads: "auto" }));
        });
    }

    it("splits for real: other bytes than one stream, the same pixels", async () => {
        pool = createWorkerPool({ size: 4 });
        const png = await pool.encode(big);
        expect(png).not.toEqual(encode(big));
        expect(decode(png).data).toEqual(big.data);
        const rgba = photo(1100, 1000, 3);
        expect(await pool.encodeRgba8(rgba)).toEqual(encodeRgba8(rgba, { threads: "auto" }));
    });

    it("gives the same bytes with 1, 2 and 8 workers", async () => {
        const expected = encode(big, { threads: "auto" });
        for (const size of [1, 2, 8]) {
            pool = createWorkerPool({ size });
            expect(await pool.encode(big), `size ${size}`).toEqual(expected);
            await pool.terminate();
        }
    });

    it("compresses one image's segments on several workers", async () => {
        const { workers, ops, createWorker, handles } = countingWorkers();
        pool = createWorkerPool({ size: 4, createWorker });
        expect(await pool.encode(big)).toEqual(encode(big, { threads: "auto" }));
        expect(workers).toHaveLength(4);
        const sent = [...ops.values()];
        expect(sent.filter((list) => list.includes("compressSegment"))).toHaveLength(4);
        expect(sent.flat().filter((op) => op === "compressSegment")).toHaveLength(5);
        // The worker that prepared it also finished it.
        const preparer = sent.find((list) => list.includes("encode"))!;
        expect(preparer.at(-1)).toBe("finish");
        expect(await handles()).toBe(0);
    });

    it("encodes small images whole, as the sync default does", async () => {
        pool = createWorkerPool({ size: 2 });
        for (const name of ["rgba_8.png", "rgb_16.png", "indexed_2_trns.png", "gray_1.png", "metadata.png"]) {
            const image = decode(fixture(`valid/${name}`), { preserveMetadata: true, preserveChunks: true });
            expect(await pool.encode(image), name).toEqual(encode(image));
        }
        const small = photo(300, 200);
        expect(await pool.encodeRgba8(small, { compression: 9 })).toEqual(encodeRgba8(small, { compression: 9 }));
    });

    it("encodes on one worker with threads: \"single\", as the sync default does", async () => {
        pool = createWorkerPool({ size: 4 });
        expect(await pool.encode(big, { threads: "single" })).toEqual(encode(big));
    });

    it("can't deadlock: a pool of one runs a split job among others", async () => {
        pool = createWorkerPool({ size: 1 });
        const small = photo(64, 64);
        const jobs = [
            pool.encode(big),
            pool.encodeRgba8(small),
            pool.encode(asPngImage(photo(900, 1200, 5))),
            pool.readHeader(fixture("valid/rgb_8.png")),
            pool.encode(big, { compression: 1 }),
        ];
        const [a, b, c, d, e] = await Promise.all(jobs);
        expect(a).toEqual(encode(big, { threads: "auto" }));
        expect(b).toEqual(encodeRgba8(small));
        expect(c).toEqual(encode(asPngImage(photo(900, 1200, 5)), { threads: "auto" }));
        expect(d).toMatchObject({ width: 13, height: 7 });
        expect(e).toEqual(encode(big, { compression: 1, threads: "auto" }));
    });

    it("doesn't hold up later jobs while it's split", async () => {
        const { workers, ops, createWorker } = countingWorkers();
        pool = createWorkerPool({ size: 1, createWorker });
        const large = pool.encode(asPngImage(photo(1500, 1500, 7))); // 9 segments
        await expect.poll(() => ops.get(workers[0])?.includes("compressSegment"), { timeout: 10_000 }).toBe(true);
        await pool.readHeader(fixture("valid/rgb_8.png"));
        await large;
        // The small job ran between two segments, not after all nine.
        const sent = ops.get(workers[0])!;
        const segmentsBefore = sent.slice(0, sent.indexOf("readHeader")).filter((op) => op === "compressSegment").length;
        expect(segmentsBefore).toBeLessThanOrEqual(2);
        expect(sent.filter((op) => op === "compressSegment")).toHaveLength(9);
        expect(sent.at(-1)).toBe("finish");
    });

    it("rejects with PngError, holding nothing, and keeps working", async () => {
        const { createWorker, handles } = countingWorkers();
        pool = createWorkerPool({ size: 2, createWorker });
        await expect(pool.encode(big, { palette: "bogus" as never })).rejects.toThrow(new PngError("bogus isn't a palette mode"));
        await expect(pool.encode({ ...big, data: big.data.subarray(1) })).rejects.toBeInstanceOf(PngError);
        await expect(pool.encode({ ...big, metadata: { gamma: -1 } })).rejects.toBeInstanceOf(PngError);
        expect(await handles()).toBe(0);
        expect(await pool.encode(big)).toEqual(encode(big, { threads: "auto" }));
        expect(await handles()).toBe(0);
    });

    it("frees the prepared image when cancelled midway", async () => {
        const { createWorker, handles } = countingWorkers();
        pool = createWorkerPool({ size: 2, createWorker });
        const controller = new AbortController();
        const job = pool.encode(asPngImage(photo(1500, 1500, 9)), { compression: 9, signal: controller.signal });
        await expect.poll(handles, { timeout: 10_000 }).toBe(1); // prepared, compressing segments
        controller.abort();
        await expect(job).rejects.toMatchObject({ name: "AbortError" });
        // A segment still running finishes first; then the image is freed.
        await expect.poll(handles, { timeout: 10_000 }).toBe(0);
        expect(await pool.encode(big)).toEqual(encode(big, { threads: "auto" }));
    });

    it("rejects a job whose prepared image's worker crashes, and replaces it", async () => {
        const { live, createWorker, handles } = countingWorkers();
        pool = createWorkerPool({ size: 2, createWorker });
        const job = pool.encode(asPngImage(photo(1500, 1500, 11)), { compression: 9 }).catch((error: unknown) => error);
        await expect.poll(handles, { timeout: 10_000 }).toBe(1);
        // Kill the worker holding the prepared image.
        for (const worker of live()) if ((await handlesIn(worker)) > 0) await worker.terminate();
        expect(await job).toMatchObject({ name: "WorkerPoolError", code: "worker-crashed" });
        expect(await pool.encode(big)).toEqual(encode(big, { threads: "auto" }));
        expect(await handles()).toBe(0);
    });

    it("rejects split jobs on terminate()", async () => {
        pool = createWorkerPool({ size: 2 });
        const jobs = [pool.encode(big, { compression: 9 }), pool.encode(big)].map((job) => job.catch((error: unknown) => error));
        await new Promise((resolve) => setTimeout(resolve, 200));
        await pool.terminate();
        for (const error of await Promise.all(jobs)) expect(error).toBeInstanceOf(WorkerPoolError);
    });

    it("decodes back to the same pixels", async () => {
        pool = createWorkerPool({ size: 3 });
        const rgba = photo(1200, 900, 13);
        expect(decodeRgba8(await pool.encodeRgba8(rgba)).data).toEqual(new Uint8ClampedArray(rgba.data));
    });
});
