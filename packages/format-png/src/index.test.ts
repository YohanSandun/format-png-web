import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PngDecoder, PngError, decodeRgba8, init, parseText, pixelsPerInch, readChunks, readHeader } from "./index.js";

const fixture = (name: string) =>
    readFileSync(new URL(`../../../../format-png/tests/data/${name}`, import.meta.url));

beforeAll(async () => {
    await init(readFileSync(new URL("./wasm/format_png_wasm_bg.wasm", import.meta.url)));
});

describe("format-png", () => {
    it("decodes to RGBA", () => {
        const image = decodeRgba8(fixture("valid/rgba_8_1x1.png"));
        expect([image.width, image.height]).toEqual([1, 1]);
        expect([...image.data]).toEqual([0, 53, 106, 159]); // generate.py: c * 53
    });

    it("reads the header", () => {
        expect(readHeader(fixture("valid/gray_16_adam7.png"))).toEqual({
            width: 13, height: 7, bitDepth: 16, colorType: "grayscale", interlaced: true,
        });
    });

    it("reuses a decoder", () => {
        const decoder = new PngDecoder();
        expect(decoder.decodeRgba8(fixture("valid/rgb_8.png")).data.length).toBe(13 * 7 * 4);
        expect(decoder.decodeRgba8(fixture("valid/gray_1.png")).data.length).toBe(13 * 7 * 4);
        decoder.free();
    });

    it("reads metadata only when asked", () => {
        expect(decodeRgba8(fixture("valid/metadata.png")).metadata).toEqual({ text: [] });

        const { metadata } = decodeRgba8(fixture("valid/metadata.png"), { preserveMetadata: true });
        expect(metadata.srgb).toBe("perceptual");
        expect(metadata.gamma).toBe(0.45455);
        expect(metadata.chromaticities?.white).toEqual({ x: 0.3127, y: 0.329 });
        expect(metadata.chromaticities?.blue.y).toBe(0.06);
        expect(metadata.physicalDimensions).toEqual({ x: 3780, y: 3780, unit: "meter" });
        expect(pixelsPerInch(metadata.physicalDimensions!)?.x).toBeCloseTo(96, 0);
        expect(metadata.time).toEqual({ year: 2026, month: 9, day: 30, hour: 12, minute: 34, second: 56 });
    });

    it("keeps raw chunks in file order", () => {
        const decoder = new PngDecoder({ preserveChunks: true });
        const { chunks } = decoder.decodeRgba8(fixture("valid/ancillary_after_idat.png"));
        decoder.free();

        const text = chunks.at(-1)!;
        expect(text.type).toBe("tEXt");
        expect(text.position).toBe("after-image-data");
        expect(new TextDecoder().decode(text.data)).toBe("Author\0format-png");
        expect(decodeRgba8(fixture("valid/ancillary_chunks.png"), { preserveChunks: true }).chunks.map((c) => c.type))
            .toEqual(["gAMA", "pHYs", "tEXt", "zTXt", "ruSt"]);
    });

    it("reads text metadata", () => {
        const { metadata } = decodeRgba8(fixture("valid/ancillary_chunks.png"), { preserveMetadata: true });
        expect(metadata.text).toEqual([
            { keyword: "Title", text: "format-png test image", languageTag: "", translatedKeyword: "", chunkType: "tEXt", compressed: false },
            { keyword: "Comment", text: "compressed text", languageTag: "", translatedKeyword: "", chunkType: "zTXt", compressed: true },
        ]);
    });

    it("reads every chunk without decoding", () => {
        const bytes = fixture("valid/ancillary_chunks.png");
        const png = readChunks(bytes);
        expect(png.header).toEqual({ width: 13, height: 7, bitDepth: 8, colorType: "rgba", interlaced: false });
        expect(png.chunks.map((c) => c.type)).toEqual(["IHDR", "gAMA", "pHYs", "tEXt", "zTXt", "ruSt", "IDAT", "IEND"]);
        expect(png.metadata.gamma).toBe(0.45455);
        expect(png.metadata.text.map((t) => t.keyword)).toEqual(["Title", "Comment"]);

        const [ihdr, , , text, , rust] = png.chunks;
        expect(ihdr).toMatchObject({ offset: 8, crc: expect.any(Number), known: true, critical: true, public: true });
        expect(ihdr.data.length).toBe(13);
        expect(rust).toMatchObject({ known: false, critical: false, public: false, safeToCopy: true });
        expect(new TextDecoder().decode(rust.data)).toBe("private safe-to-copy chunk");
        expect(parseText("tEXt", text.data).text).toBe("format-png test image");
        // Each chunk is 12 bytes plus its data, back to back to the end of the file.
        const last = png.chunks.at(-1)!;
        expect(last.offset + 12 + last.data.length).toBe(bytes.length);
    });

    it("reads the palette and transparency", () => {
        const decoder = new PngDecoder();
        const indexed = decoder.readChunks(fixture("valid/indexed_2_trns.png"));
        expect(indexed.palette).toHaveLength(4);
        expect(indexed.transparency).toEqual({ kind: "palette", alpha: new Uint8Array([0, 85, 170]) });
        expect(decoder.readChunks(fixture("valid/rgb_8_trns.png")).transparency).toEqual({ kind: "rgb", value: [0, 53, 106] });
        expect(decoder.readChunks(fixture("valid/gray_8_trns.png")).transparency).toEqual({ kind: "gray", value: 37 });
        expect(decoder.readChunks(fixture("valid/rgb_8.png")).palette).toBeUndefined();
        decoder.free();
    });

    it("throws PngError for bad input", () => {
        expect(() => decodeRgba8(fixture("invalid/ihdr_crc_wrong.png"))).toThrow(PngError);
        expect(() => decodeRgba8(new Uint8Array([1, 2, 3]))).toThrow(/signature/);
        expect(() => readChunks(fixture("invalid/ihdr_crc_wrong.png"))).toThrow(PngError);
        expect(() => parseText("zTXt", new Uint8Array([0x41, 0, 0, 1, 2]))).toThrow(PngError);
    });
});