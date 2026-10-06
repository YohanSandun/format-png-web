// The worker pool in a real browser, with Web Workers started the way bundlers
// see them: Vite serves dist/, resolving `#spawn` and `#port` to the web
// adapters. Run `npm run build` first.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    PngError, WorkerPoolError, createWorkerPool, decode, decodeRgba8, decodeRgba8Async, encode, encodeRgba8, encodeRgba8Async, init, readChunks,
    readHeader, terminateDefaultWorkerPool,
    type PngImage, type WorkerPool,
} from "../dist/index.js";

function noise(width: number, height: number, seed: number) {
    const data = new Uint8Array(width * height * 4);
    let state = seed;
    for (let i = 0; i < data.length; i++) {
        state = (state * 1103515245 + 12345) >>> 0;
        data[i] = state >>> 24;
    }
    return { width, height, data };
}

const header = (width: number, height: number, bitDepth: number, colorType: PngImage["header"]["colorType"]) =>
    ({ width, height, bitDepth, colorType, interlaced: false });

let images: Record<string, Uint8Array>;
let pool: WorkerPool;

beforeAll(async () => {
    await init();
    images = {
        rgba8: encodeRgba8({ ...noise(40, 30, 1), metadata: { text: [{ keyword: "Title", text: "browser" }], gamma: 0.45455 } }),
        rgb16: encode({ header: header(20, 10, 16, "rgb"), data: noise(20, 15, 2).data.subarray(0, 20 * 10 * 6) }),
        gray1: encode({ header: header(13, 7, 1, "grayscale"), data: noise(2, 7, 3).data.subarray(0, 14) }),
        indexed: encode({
            header: header(16, 16, 4, "indexed"),
            data: noise(16, 16, 4).data.subarray(0, 128).map((byte) => byte & 0x77),
            palette: Array.from({ length: 8 }, (_, i) => [i * 30, 255 - i * 30, i * 10] as [number, number, number]),
            transparency: { kind: "palette", alpha: Uint8Array.from([0, 128, 255]) },
        }),
    };
    pool = createWorkerPool({ size: 4 });
});

afterAll(async () => {
    await pool?.terminate();
    await terminateDefaultWorkerPool();
});

describe("WorkerPool in the browser", () => {
    it("decodes, encodes and reads chunks like the sync API", async () => {
        for (const [name, png] of Object.entries(images)) {
            expect(await pool.decode(png, { preserveMetadata: true }), name).toEqual(decode(png, { preserveMetadata: true }));
            expect(await pool.decodeRgba8(png), name).toEqual(decodeRgba8(png));
            expect(await pool.readChunks(png), name).toEqual(readChunks(png));
            expect(await pool.readHeader(png), name).toEqual(readHeader(png));
            const raw = decode(png);
            expect(await pool.encode(raw, { compression: 9 }), name).toEqual(encode(raw, { compression: 9 }));
            const rgba = decodeRgba8(png);
            expect(await pool.encodeRgba8(rgba, { palette: "auto" }), name).toEqual(encodeRgba8(rgba, { palette: "auto" }));
        }
    });

    it("encodes ImageData from a canvas", async () => {
        const canvas = new OffscreenCanvas(8, 8);
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#3a6";
        context.fillRect(0, 0, 5, 8);
        const imageData = context.getImageData(0, 0, 8, 8);
        expect(await pool.encodeRgba8(imageData)).toEqual(encodeRgba8(imageData));
        expect(imageData.data.byteLength).toBe(256); // copied, not transferred
    });

    it("rejects with PngError", async () => {
        const error = await pool.decodeRgba8(new Uint8Array([137, 80, 78, 71])).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(PngError);
        await expect(pool.encodeRgba8(noise(1, 1, 1), { strip: "most" as never })).rejects.toThrow(new PngError("most isn't a strip mode"));
    });

    it("transfers with transfer: true", async () => {
        const bytes = images.rgba8.slice();
        const job = pool.decodeRgba8(bytes, { transfer: true });
        expect(bytes.byteLength).toBe(0);
        expect(await job).toEqual(decodeRgba8(images.rgba8));
    });

    it("keeps the main thread responsive while encoding", async () => {
        const image = noise(2048, 2048, 9);
        let longestGap = 0;
        let last = performance.now();
        const timer = setInterval(() => {
            const now = performance.now();
            longestGap = Math.max(longestGap, now - last);
            last = now;
        }, 5);
        const start = performance.now();
        await Promise.all([pool.encodeRgba8(image, { compression: 9 }), pool.encodeRgba8(image, { compression: 9, filter: "paeth" })]);
        const elapsed = performance.now() - start;
        clearInterval(timer);
        // The main thread only copies the pixels; the encoding itself is elsewhere.
        expect(longestGap).toBeLessThan(Math.max(150, elapsed / 3));
    });

    it("runs the async functions without a pool", async () => {
        const image = await decodeRgba8Async(images.indexed);
        expect(image).toEqual(decodeRgba8(images.indexed));
        expect(await encodeRgba8Async(image)).toEqual(encodeRgba8(image));
        await expect(decodeRgba8Async(new Uint8Array(4))).rejects.toBeInstanceOf(PngError);
    });

    it("rejects after terminate()", async () => {
        const other = createWorkerPool({ size: 1 });
        const job = other.encodeRgba8(noise(512, 512, 5), { compression: 9 });
        await other.terminate();
        await expect(job).rejects.toBeInstanceOf(WorkerPoolError);
        await expect(other.readHeader(images.rgba8)).rejects.toMatchObject({ code: "terminated" });
    });
});
