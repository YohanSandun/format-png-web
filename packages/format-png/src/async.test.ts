// The async functions, on the shared pool, in Node. Runs against dist/: run
// `npm run build` first.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    PngError, WorkerPoolError, decode, decodeAsync, decodeRgba8, decodeRgba8Async, defaultWorkerPool, encode, encodeAsync, encodeRgba8,
    encodeRgba8Async, init, parseText, parseTextAsync, readChunks, readChunksAsync, readHeader, readHeaderAsync, terminateDefaultWorkerPool,
} from "../dist/index.js";

const fixture = (name: string) =>
    readFileSync(new URL(`../../../../format-png/tests/data/${name}`, import.meta.url));

beforeAll(async () => {
    await init(); // for the sync results to compare with
});

afterAll(async () => {
    await terminateDefaultWorkerPool();
});

describe("async functions", () => {
    it("give the same results as the sync ones, without a pool or init()", async () => {
        for (const name of ["rgba_8.png", "rgb_16.png", "indexed_2_trns.png", "gray_1.png", "ancillary_chunks.png"]) {
            const bytes = fixture(`valid/${name}`);
            const options = { preserveMetadata: true, preserveChunks: true };
            expect(await decodeAsync(bytes, options), name).toEqual(decode(bytes, options));
            expect(await decodeRgba8Async(bytes), name).toEqual(decodeRgba8(bytes));
            expect(await readChunksAsync(bytes), name).toEqual(readChunks(bytes));
            expect(await readHeaderAsync(bytes), name).toEqual(readHeader(bytes));
            const raw = decode(bytes, options);
            expect(await encodeAsync(raw, { compression: 9 }), name).toEqual(encode(raw, { compression: 9 }));
            const rgba = decodeRgba8(bytes);
            expect(await encodeRgba8Async(rgba, { palette: "auto" }), name).toEqual(encodeRgba8(rgba, { palette: "auto" }));
        }
        const text = readChunks(fixture("valid/ancillary_chunks.png")).chunks.find((chunk) => chunk.type === "tEXt")!;
        expect(await parseTextAsync("tEXt", text.data)).toEqual(parseText("tEXt", text.data));
    });

    it("work with .then()", () =>
        decodeRgba8Async(fixture("valid/rgba_8_1x1.png")).then((image) => {
            expect([...image.data]).toEqual([0, 53, 106, 159]);
        }));

    it("reject with PngError", async () => {
        await expect(decodeRgba8Async(fixture("invalid/ihdr_crc_wrong.png"))).rejects.toBeInstanceOf(PngError);
        await expect(encodeRgba8Async({ width: 1, height: 1, data: new Uint8Array(4) }, { palette: "bogus" as never }))
            .rejects.toThrow(new PngError("bogus isn't a palette mode"));
    });

    it("share one pool, which starts again after terminateDefaultWorkerPool()", async () => {
        const pool = defaultWorkerPool();
        expect(defaultWorkerPool()).toBe(pool);
        expect(pool.size).toBeLessThanOrEqual(8);

        const pending = encodeRgba8Async({ width: 512, height: 512, data: new Uint8Array(512 * 512 * 4).fill(7) }, { compression: 9 })
            .catch((error: unknown) => error);
        await terminateDefaultWorkerPool();
        const error = await pending;
        expect(error).toBeInstanceOf(WorkerPoolError);
        expect(error).toMatchObject({ name: "WorkerPoolError", code: "terminated" });

        expect(await readHeaderAsync(fixture("valid/rgb_8.png"))).toEqual(readHeader(fixture("valid/rgb_8.png")));
        expect(defaultWorkerPool()).not.toBe(pool);
    });
});
