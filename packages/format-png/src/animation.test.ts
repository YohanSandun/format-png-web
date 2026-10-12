// Animated PNG (APNG): decoding, compositing and encoding frames.
import { beforeAll, describe, expect, it } from "vitest";
import {
    PngDecoder, PngEncoder, PngError, decode, decodeAnimation, decodeAnimationRgba8, decodeRgba8, encodeAnimation, encodeAnimationRgba8,
    encodeRgba8, frameDelayMs, init, readChunks, type PngHeader,
} from "./index.js";

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];
const CLEAR = [0, 0, 0, 0];

/** `count` RGBA pixels of `color`. */
const pixels = (color: number[], count: number) => Uint8Array.from({ length: count * 4 }, (_, i) => color[i % 4]);

const rgba = (width: number, height: number): PngHeader => ({ width, height, bitDepth: 8, colorType: "rgba", interlaced: false });

/** A 2×1 canvas: red, then blue drawn over its right pixel. */
function redThenBlue(): Uint8Array {
    return encodeAnimation({
        header: rgba(2, 1),
        numPlays: 3,
        frames: [
            { data: pixels(RED, 2), delayNum: 1, delayDen: 2 },
            { data: pixels(BLUE, 1), width: 1, height: 1, x: 1, delayNum: 25, delayDen: 0 },
        ],
    });
}

beforeAll(async () => {
    await init();
});

describe("animation", () => {
    it("decodes the frames as stored", () => {
        const animation = decodeAnimation(redThenBlue());
        expect(animation.header).toEqual(rgba(2, 1));
        expect(animation.numPlays).toBe(3);
        expect(animation.defaultImage).toBeUndefined();
        expect(animation.frames).toEqual([
            { width: 2, height: 1, x: 0, y: 0, delayNum: 1, delayDen: 2, dispose: "none", blend: "source", data: pixels(RED, 2) },
            { width: 1, height: 1, x: 1, y: 0, delayNum: 25, delayDen: 0, dispose: "none", blend: "source", data: pixels(BLUE, 1) },
        ]);
    });

    it("draws each frame onto the canvas", () => {
        const animation = decodeAnimationRgba8(redThenBlue());
        expect([animation.width, animation.height, animation.numPlays]).toEqual([2, 1, 3]);
        expect(animation.frames.map((frame) => [...frame.data])).toEqual([[...RED, ...RED], [...RED, ...BLUE]]);
        expect(animation.frames[0].data).toBeInstanceOf(Uint8ClampedArray);
        expect(animation.frames.map(frameDelayMs)).toEqual([500, 250]);
    });

    it("applies disposal and blending", () => {
        const half = [0, 0, 255, 128];
        const png = encodeAnimation({
            header: rgba(2, 1),
            frames: [
                { data: pixels(RED, 2) },
                { data: Uint8Array.from(half), width: 1, height: 1, blend: "over", dispose: "previous" },
                { data: pixels(CLEAR, 1), width: 1, height: 1, x: 1, dispose: "background" },
                { data: pixels(CLEAR, 1), width: 1, height: 1, blend: "over" },
            ],
        });
        const frames = decodeAnimationRgba8(png).frames.map((frame) => [...frame.data]);
        expect(frames[1].slice(0, 4)).toEqual([127, 0, 128, 255]); // blue at half alpha over red
        expect(frames[2]).toEqual([...RED, ...CLEAR]); // frame 1 put back, then cleared on the right
        expect(frames[3]).toEqual([...RED, ...CLEAR]); // frame 2's area cleared; a clear pixel drawn over changes nothing
    });

    it("leaves still images to decode", () => {
        const still = encodeRgba8({ width: 1, height: 1, data: pixels(RED, 1) });
        expect(() => decodeAnimation(still)).toThrow(PngError);
        expect(() => decodeAnimationRgba8(still)).toThrow(/isn't animated/);
        expect(readChunks(still).animationControl).toBeUndefined();
        expect(readChunks(still).frameControls).toEqual([]);
    });

    it("shows the first frame to viewers without APNG support", () => {
        const png = redThenBlue();
        expect([...decodeRgba8(png).data]).toEqual([...RED, ...RED]);
        expect(decode(png).header).toEqual(rgba(2, 1));
    });

    it("keeps a separate default image", () => {
        const png = encodeAnimation({
            header: rgba(1, 1),
            defaultImage: pixels(BLUE, 1),
            frames: [{ data: pixels(RED, 1) }],
        });
        expect([...decodeRgba8(png).data]).toEqual(BLUE);
        const animation = decodeAnimation(png);
        expect(animation.defaultImage).toEqual(pixels(BLUE, 1));
        expect(animation.frames).toHaveLength(1);
        expect(decodeAnimation(encodeAnimation(animation))).toEqual(animation);
    });

    it("reads the animation chunks without decoding", () => {
        const png = readChunks(redThenBlue());
        expect(png.animationControl).toEqual({ numFrames: 2, numPlays: 3 });
        expect(png.frameControls).toEqual([
            { sequenceNumber: 0, width: 2, height: 1, x: 0, y: 0, delayNum: 1, delayDen: 2, dispose: "none", blend: "source" },
            { sequenceNumber: 1, width: 1, height: 1, x: 1, y: 0, delayNum: 25, delayDen: 0, dispose: "none", blend: "source" },
        ]);
        expect(png.chunks.map((chunk) => chunk.type)).toEqual(["IHDR", "acTL", "fcTL", "IDAT", "fcTL", "fdAT", "IEND"]);
        expect(png.chunks.every((chunk) => chunk.known)).toBe(true);
    });

    it("round trips losslessly, 16-bit and indexed included", () => {
        const gray16: PngHeader = { width: 2, height: 1, bitDepth: 16, colorType: "grayscale", interlaced: false };
        const png16 = encodeAnimation({
            header: gray16,
            frames: [{ data: Uint8Array.of(0x12, 0x34, 0xfe, 0xdc) }, { data: Uint8Array.of(0xab, 0xcd, 0x00, 0x01), dispose: "background" }],
        });
        const animation16 = decodeAnimation(png16);
        expect(animation16.frames[1].data).toEqual(Uint8Array.of(0xab, 0xcd, 0x00, 0x01));
        expect(encodeAnimation(animation16)).toEqual(png16);

        const indexed: PngHeader = { width: 2, height: 1, bitDepth: 1, colorType: "indexed", interlaced: false };
        const pngIndexed = encodeAnimation({
            header: indexed,
            palette: [[255, 0, 0], [0, 0, 255]],
            transparency: { kind: "palette", alpha: Uint8Array.of(255, 128) },
            frames: [{ data: Uint8Array.of(0b0100_0000) }, { data: Uint8Array.of(0b1000_0000) }],
        });
        const animationIndexed = decodeAnimation(pngIndexed);
        expect(animationIndexed.palette).toEqual([[255, 0, 0], [0, 0, 255]]);
        expect(animationIndexed.transparency).toEqual({ kind: "palette", alpha: Uint8Array.of(255, 128) });
        expect(decodeAnimationRgba8(pngIndexed).frames[1].data.slice(0, 4)).toEqual(Uint8ClampedArray.of(0, 0, 255, 128));
        expect(encodeAnimation(animationIndexed)).toEqual(pngIndexed);
    });

    it("keeps metadata and chunks, without the animation's own", () => {
        const png = encodeAnimation({
            header: rgba(1, 1),
            frames: [{ data: pixels(RED, 1) }, { data: pixels(BLUE, 1) }],
            metadata: { srgb: "perceptual", text: [{ keyword: "Title", text: "flash" }] },
            chunks: [{ type: "ruSt", data: Uint8Array.of(1, 2, 3), position: "after-image-data" }],
        });
        const options = { preserveMetadata: true, preserveChunks: true };
        for (const animation of [decodeAnimation(png, options), decodeAnimationRgba8(png, options)]) {
            expect(animation.metadata.srgb).toBe("perceptual");
            expect(animation.metadata.text[0].text).toBe("flash");
            expect(animation.chunks.map((chunk) => chunk.type)).not.toContain("fdAT");
            expect(animation.chunks.find((chunk) => chunk.type === "ruSt")?.data).toEqual(Uint8Array.of(1, 2, 3));
        }
        expect(decodeAnimation(png).metadata).toEqual({ text: [] });
    });

    it("re-encodes the frames a viewer shows, cropped to what changed", () => {
        // A 32×32 canvas of whole frames, each a moving 4×4 square: what decoding a GIF gives.
        const frames = Array.from({ length: 6 }, (_, i) => {
            const data = pixels(RED, 32 * 32);
            for (let y = 0; y < 4; y++) data.set(pixels(BLUE, 4), ((y + 10) * 32 + i * 4) * 4);
            return { data, delayNum: 1, delayDen: 10 };
        });
        const whole = encodeAnimationRgba8({ width: 32, height: 32, frames });
        const cropped = encodeAnimationRgba8({ width: 32, height: 32, frames }, { cropFrames: true });
        expect(cropped.length).toBeLessThan(whole.length);
        expect(decodeAnimation(cropped).frames[1]).toMatchObject({ width: 8, height: 4, x: 0, y: 10 });

        const shown = decodeAnimationRgba8(cropped);
        expect(shown.frames.map((frame) => [...frame.data])).toEqual(frames.map((frame) => [...frame.data]));
        // A decoded RgbaAnimation encodes as it is.
        expect(decodeAnimationRgba8(encodeAnimationRgba8(shown, { cropFrames: true }))).toEqual(shown);
    });

    it("converts animations with few colors to a palette", () => {
        const png = encodeAnimationRgba8(
            { width: 4, height: 4, frames: [{ data: pixels(RED, 16) }, { data: pixels(BLUE, 16) }] },
            { palette: "auto" },
        );
        expect(readChunks(png).header.colorType).toBe("indexed");
        expect(decodeAnimationRgba8(png).frames[1].data).toEqual(new Uint8ClampedArray(pixels(BLUE, 16)));
    });

    it("rejects frames that don't fit", () => {
        const frames = [{ data: pixels(RED, 4) }, { data: pixels(BLUE, 4), width: 2, height: 2, x: 1 }];
        expect(() => encodeAnimation({ header: rgba(2, 2), frames })).toThrow(PngError);
        expect(() => encodeAnimation({ header: rgba(2, 2), frames: [] })).toThrow(PngError);
        expect(() => encodeAnimation({ header: rgba(2, 2), frames: [{ data: pixels(RED, 1), width: 1, height: 1 }] })).toThrow(PngError);
        expect(() => encodeAnimation({ header: rgba(1, 1), frames: [{ data: pixels(RED, 1), dispose: "sideways" as "none" }] })).toThrow(/dispose op/);
    });

    it("reuses a decoder and an encoder", () => {
        const encoder = new PngEncoder({ cropFrames: true, compression: 9 });
        const decoder = new PngDecoder({ preserveMetadata: true });
        const png = encoder.encodeAnimationRgba8({ width: 2, height: 1, frames: [{ data: pixels(RED, 2) }, { data: pixels(BLUE, 2) }] });
        expect(encoder.encodeAnimation(decoder.decodeAnimation(png))).toEqual(png);
        expect(decoder.decodeAnimationRgba8(png).frames[1].data).toEqual(new Uint8ClampedArray(pixels(BLUE, 2)));
        encoder.free();
        decoder.free();
    });

    it("gives frame delays in milliseconds", () => {
        expect(frameDelayMs({ delayNum: 1, delayDen: 10 })).toBe(100);
        expect(frameDelayMs({ delayNum: 7, delayDen: 0 })).toBe(70);
        expect(frameDelayMs({ delayNum: 0, delayDen: 30 })).toBe(0);
    });
});
