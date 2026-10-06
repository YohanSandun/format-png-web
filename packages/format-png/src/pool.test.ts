// The worker pool, in Node with worker_threads. Runs against the build in
// dist/, as the workers load dist/worker.js: run `npm run build` first.
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
    PngError, WorkerPoolError, createWorkerPool, decode, decodeRgba8, encode, encodeRgba8, init, parseText, readChunks, readHeader,
    type WorkerPool,
} from "../dist/index.js";

const fixture = (name: string) =>
    readFileSync(new URL(`../../../../format-png/tests/data/${name}`, import.meta.url));

const workerUrl = new URL("../dist/worker.js", import.meta.url);

/** Real workers that record which job ids each one was sent. */
function recordingWorkers() {
    const sent: number[][] = [];
    const createWorker = () => {
        const worker = new Worker(workerUrl);
        const ids: number[] = [];
        sent.push(ids);
        const postMessage = worker.postMessage.bind(worker);
        worker.postMessage = (message: { id: number }, transfer?: readonly ArrayBuffer[]) => {
            ids.push(message.id);
            postMessage(message, transfer as ArrayBuffer[]);
        };
        return worker;
    };
    return { sent, createWorker };
}

/** Noisy pixels, slow enough to compress that jobs overlap. */
function noise(width: number, height: number, seed: number) {
    const data = new Uint8Array(width * height * 4);
    let state = seed;
    for (let i = 0; i < data.length; i++) {
        state = (state * 1103515245 + 12345) >>> 0;
        data[i] = state >>> 24;
    }
    return { width, height, data };
}

const variedFixtures = [
    "rgba_8.png", "rgb_16.png", "rgba_16_adam7.png", "gray_alpha_16.png", "gray_1.png", "gray_2_trns.png",
    "indexed_1.png", "indexed_4_adam7.png", "indexed_8_trns.png", "rgb_16_trns.png", "metadata.png", "ancillary_chunks.png",
];

let pool: WorkerPool;

beforeAll(async () => {
    await init(); // for the sync results to compare with
});

afterEach(async () => {
    await pool?.terminate();
});

describe("WorkerPool", () => {
    it("has a default size of the CPU cores, at most 8", () => {
        pool = createWorkerPool();
        expect(pool.size).toBeGreaterThanOrEqual(1);
        expect(pool.size).toBeLessThanOrEqual(8);
        expect(() => createWorkerPool({ size: 0 })).toThrow(RangeError);
        expect(() => createWorkerPool({ size: 1.5 })).toThrow(RangeError);
    });

    it("decodes like the sync API, in every format", async () => {
        pool = createWorkerPool({ size: 3 });
        const options = { preserveMetadata: true, preserveChunks: true };
        for (const name of variedFixtures) {
            const bytes = fixture(`valid/${name}`);
            expect(await pool.decode(bytes), name).toEqual(decode(bytes));
            expect(await pool.decode(bytes, options), name).toEqual(decode(bytes, options));
            expect(await pool.decodeRgba8(bytes, options), name).toEqual(decodeRgba8(bytes, options));
            expect(await pool.readHeader(bytes), name).toEqual(readHeader(bytes));
        }
        const rgba = await pool.decodeRgba8(fixture("valid/rgba_16.png"));
        expect(rgba.data).toBeInstanceOf(Uint8ClampedArray);
    });

    it("encodes like the sync API, with options", async () => {
        pool = createWorkerPool({ size: 3 });
        const optionSets = [{}, { compression: 9, filter: "paeth" as const }, { palette: "auto" as const, strip: "safe" as const }, { compressionStrategy: "stored" as const }];
        for (const name of variedFixtures) {
            const raw = decode(fixture(`valid/${name}`), { preserveMetadata: true, preserveChunks: true });
            const rgba = decodeRgba8(fixture(`valid/${name}`), { preserveMetadata: true });
            for (const options of optionSets) {
                expect(await pool.encode(raw, options), `${name} ${JSON.stringify(options)}`).toEqual(encode(raw, options));
                expect(await pool.encodeRgba8(rgba, options), `${name} ${JSON.stringify(options)}`).toEqual(encodeRgba8(rgba, options));
            }
        }
        // 16-bit and indexed survive the round trip through the pool.
        for (const name of ["rgba_16.png", "indexed_2_trns.png"]) {
            const raw = decode(fixture(`valid/${name}`));
            expect(await pool.decode(await pool.encode(raw))).toEqual(raw);
        }
    });

    it("reads chunks like the sync API, as views into the input", async () => {
        pool = createWorkerPool({ size: 2 });
        for (const name of ["ancillary_chunks.png", "metadata.png", "indexed_2_trns.png", "rgb_8_trns.png"]) {
            const bytes = fixture(`valid/${name}`);
            const chunks = await pool.readChunks(bytes, { strictAncillary: true });
            expect(chunks, name).toEqual(readChunks(bytes, { strictAncillary: true }));
            expect(chunks.chunks.every((chunk) => chunk.data.buffer === bytes.buffer)).toBe(true);
        }
        const text = readChunks(fixture("valid/ancillary_chunks.png")).chunks.find((chunk) => chunk.type === "zTXt")!;
        expect(await pool.parseText("zTXt", text.data)).toEqual(parseText("zTXt", text.data));
    });

    it("rejects with PngError, as the sync API throws", async () => {
        pool = createWorkerPool({ size: 2 });
        const corrupt = fixture("invalid/ihdr_crc_wrong.png");
        const syncError = (() => {
            try {
                decodeRgba8(corrupt);
            } catch (error) {
                return error as PngError;
            }
        })()!;
        const error = await pool.decodeRgba8(corrupt).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(PngError);
        expect(error).toMatchObject({ name: "PngError", message: syncError.message });
        await expect(pool.readChunks(corrupt)).rejects.toThrow(PngError);
        await expect(pool.readHeader(new Uint8Array([1, 2, 3]))).rejects.toThrow(PngError);

        const image = { width: 1, height: 1, data: new Uint8Array(4) };
        await expect(pool.encodeRgba8(image, { palette: "bogus" as never })).rejects.toThrow(new PngError("bogus isn't a palette mode"));
        await expect(pool.encodeRgba8(image, { filter: "nope" as never })).rejects.toThrow(PngError);
        await expect(pool.encodeRgba8(image, { compression: 12 })).rejects.toThrow(PngError);
        await expect(pool.encodeRgba8({ ...image, data: new Uint8Array(3) })).rejects.toThrow(PngError);

        // The worker is still usable after an error.
        expect(await pool.encodeRgba8(image)).toEqual(encodeRgba8(image));
    });

    it("runs more jobs than workers, starting them in order", async () => {
        const { sent, createWorker } = recordingWorkers();
        pool = createWorkerPool({ size: 2, createWorker });
        const images = Array.from({ length: 10 }, (_, i) => noise(32 + i, 16, i));
        const results = await Promise.all(images.map((image) => pool.encodeRgba8(image)));
        expect(results).toEqual(images.map((image) => encodeRgba8(image)));

        expect(sent).toHaveLength(2);
        const ids = sent.flat();
        expect(ids.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => ids.toSorted((a, b) => a - b)[0] + i));
        for (const workerIds of sent) expect(workerIds).toEqual(workerIds.toSorted((a, b) => a - b)); // FIFO per worker
    });

    it("runs parallel jobs on different workers at once", async () => {
        const { sent, createWorker } = recordingWorkers();
        pool = createWorkerPool({ size: 4, createWorker });
        const images = Array.from({ length: 4 }, (_, i) => noise(512, 512, i));
        const jobs = images.map((image) => pool.encodeRgba8(image, { compression: 9 }));
        // All four were sent, one to each of four workers, before any finished.
        expect(sent.map((ids) => ids.length)).toEqual([1, 1, 1, 1]);
        expect(await Promise.all(jobs)).toEqual(images.map((image) => encodeRgba8(image, { compression: 9 })));
    });

    it("starts workers lazily and keeps them between jobs", async () => {
        const { sent, createWorker } = recordingWorkers();
        pool = createWorkerPool({ size: 4, createWorker });
        expect(sent).toHaveLength(0);
        for (let i = 0; i < 3; i++) await pool.readHeader(fixture("valid/rgb_8.png"));
        expect(sent).toEqual([[expect.any(Number), expect.any(Number), expect.any(Number)]]);
    });

    it("terminate() rejects pending jobs and later calls", async () => {
        pool = createWorkerPool({ size: 1 });
        const images = Array.from({ length: 3 }, (_, i) => noise(256, 256, i));
        const jobs = images.map((image) => pool.encodeRgba8(image).catch((e: unknown) => e));
        await pool.terminate();
        for (const error of await Promise.all(jobs)) {
            expect(error).toBeInstanceOf(WorkerPoolError);
            expect(error).toMatchObject({ code: "terminated" });
        }
        await expect(pool.readHeader(fixture("valid/rgb_8.png"))).rejects.toMatchObject({ name: "WorkerPoolError", code: "terminated" });
        await pool.terminate(); // idempotent

        // A call that's rejected at once leaves its input alone, even with `transfer`.
        const bytes = new Uint8Array(fixture("valid/rgb_8.png"));
        await expect(pool.decodeRgba8(bytes, { transfer: true })).rejects.toBeInstanceOf(WorkerPoolError);
        const other = createWorkerPool({ size: 1 });
        await expect(other.decodeRgba8(bytes, { transfer: true, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
        expect(bytes.byteLength).toBeGreaterThan(0);
        await other.terminate();
    });

    it("replaces a worker that crashes", async () => {
        let started = 0;
        pool = createWorkerPool({
            size: 1,
            createWorker: () => (started++ === 0 ? new Worker("process.exit(3)", { eval: true }) : new Worker(workerUrl)),
        });
        const error = await pool.readHeader(fixture("valid/rgb_8.png")).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(WorkerPoolError);
        expect(error).toMatchObject({ code: "worker-crashed" });
        expect(await pool.readHeader(fixture("valid/rgb_8.png"))).toEqual(readHeader(fixture("valid/rgb_8.png")));
        expect(started).toBe(2);
    });

    it("cancels queued and running jobs with an AbortSignal", async () => {
        pool = createWorkerPool({ size: 1 });
        const running = new AbortController();
        const queued = new AbortController();
        const first = pool.encodeRgba8(noise(1024, 1024, 1), { compression: 9, signal: running.signal });
        const second = pool.encodeRgba8(noise(8, 8, 2), { signal: queued.signal });
        const third = pool.encodeRgba8(noise(8, 8, 3));
        queued.abort();
        running.abort(new Error("stop"));
        await expect(first).rejects.toThrow("stop");
        await expect(second).rejects.toMatchObject({ name: "AbortError" });
        expect(await third).toEqual(encodeRgba8(noise(8, 8, 3))); // on a new worker

        await expect(pool.readHeader(fixture("valid/rgb_8.png"), { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    });

    describe("buffers", () => {
        it("copies the input by default", async () => {
            pool = createWorkerPool({ size: 1 });
            const bytes = new Uint8Array(fixture("valid/rgba_8.png"));
            const job = pool.decodeRgba8(bytes);
            expect(bytes.byteLength).toBeGreaterThan(0);
            bytes[0] = 0; // changing the input after the call doesn't affect the job
            expect((await job).width).toBe(13);

            const image = noise(4, 4, 1);
            const png = await pool.encodeRgba8(image);
            expect(image.data.byteLength).toBe(64);
            expect(png).toEqual(encodeRgba8(image));
        });

        it("copies only the view, not the whole buffer, of a view into a larger one", async () => {
            pool = createWorkerPool({ size: 1 });
            const png = fixture("valid/rgb_8.png");
            const big = new Uint8Array(png.length + 100);
            big.set(png, 50);
            const view = big.subarray(50, 50 + png.length);
            expect(await pool.decodeRgba8(view)).toEqual(decodeRgba8(png));
            const chunks = await pool.readChunks(view);
            expect(chunks).toEqual(readChunks(view));
            expect(chunks.chunks[0].data.buffer).toBe(big.buffer);
        });

        it("transfers, detaching the caller's buffer at once, with transfer: true", async () => {
            pool = createWorkerPool({ size: 1 });
            const expected = decodeRgba8(fixture("valid/rgba_8.png"));
            const bytes = new Uint8Array(fixture("valid/rgba_8.png"));
            const job = pool.decodeRgba8(bytes, { transfer: true });
            expect(bytes.byteLength).toBe(0);
            expect(bytes.buffer.byteLength).toBe(0);
            expect(await job).toEqual(expected);

            const image = noise(16, 16, 7);
            const expectedPng = encodeRgba8(image);
            const pixels = image.data;
            const png = await pool.encodeRgba8(image, { transfer: true });
            expect(pixels.byteLength).toBe(0);
            expect(png).toEqual(expectedPng);

            // Chunks are then views into the input, moved back from the worker.
            const source = fixture("valid/ancillary_chunks.png");
            const moved = new Uint8Array(source);
            const chunks = await pool.readChunks(moved, { transfer: true });
            expect(moved.byteLength).toBe(0);
            expect(chunks).toEqual(readChunks(new Uint8Array(source)));
            expect(chunks.chunks[0].data.buffer.byteLength).toBe(source.length);
        });

        it("rejects transfer: true for a SharedArrayBuffer", async () => {
            pool = createWorkerPool({ size: 1 });
            const shared = new Uint8Array(new SharedArrayBuffer(8));
            await expect(pool.readHeader(shared, { transfer: true })).rejects.toThrow(TypeError);
        });
    });
});
