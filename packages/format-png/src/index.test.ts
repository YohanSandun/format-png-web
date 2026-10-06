import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
    PngDecoder, PngEncoder, PngError, decode, decodeRgba8, encode, encodeRgba8, init, parseText, pixelsPerInch, readChunks, readHeader,
} from "./index.js";

const fixture = (name: string) =>
    readFileSync(new URL(`../../../../format-png/tests/data/${name}`, import.meta.url));

beforeAll(async () => {
    await init(); // the embedded module
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

    it("encodes RGBA and decodes it back", () => {
        const data = Uint8ClampedArray.from({ length: 5 * 3 * 4 }, (_, i) => (i * 37) % 256);
        const png = encodeRgba8({ width: 5, height: 3, data });
        expect(readHeader(png)).toEqual({ width: 5, height: 3, bitDepth: 8, colorType: "rgba", interlaced: false });
        expect(readChunks(png).chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
        expect(decodeRgba8(png).data).toEqual(data);

        const interlaced = encodeRgba8({ width: 5, height: 3, data, interlaced: true });
        expect(readHeader(interlaced).interlaced).toBe(true);
        expect(decodeRgba8(interlaced).data).toEqual(data);
    });

    it("re-encodes a decoded image with its metadata and chunks", () => {
        const options = { preserveMetadata: true, preserveChunks: true };
        const original = decodeRgba8(fixture("valid/ancillary_chunks.png"), options);
        const copy = decodeRgba8(encodeRgba8(original), options);
        expect(copy.data).toEqual(original.data);
        expect(copy.metadata).toEqual(original.metadata);
        // Typed metadata goes in the encoder's own order, so only the set of chunks is the same.
        expect(copy.chunks.map((c) => c.type).sort()).toEqual(["gAMA", "pHYs", "ruSt", "tEXt", "zTXt"]);
        const rust = copy.chunks.find((c) => c.type === "ruSt")!;
        expect(new TextDecoder().decode(rust.data)).toBe("private safe-to-copy chunk");
    });

    it("writes metadata", () => {
        const metadata = {
            gamma: 0.45455,
            srgb: "perceptual" as const,
            chromaticities: {
                white: { x: 0.3127, y: 0.329 }, red: { x: 0.64, y: 0.33 }, green: { x: 0.3, y: 0.6 }, blue: { x: 0.15, y: 0.06 },
            },
            physicalDimensions: { x: 3780, y: 3780, unit: "meter" as const },
            time: { year: 2026, month: 10, day: 5, hour: 8, minute: 30, second: 0 },
            text: [
                { keyword: "Title", text: "Plain" },
                { keyword: "Comment", text: "Compressed", chunkType: "zTXt" as const },
                { keyword: "Title", text: "Tittel på norsk", chunkType: "iTXt" as const, compressed: true, languageTag: "nb", translatedKeyword: "Tittel" },
            ],
        };
        const png = readChunks(encodeRgba8({ width: 1, height: 1, data: new Uint8Array(4), metadata }));
        expect(png.metadata).toMatchObject({ ...metadata, text: metadata.text.map((t) => expect.objectContaining(t)) });
        expect(png.metadata.text.map((t) => t.compressed)).toEqual([false, true, true]);
    });

    it("encodes indexed images with a palette and transparency", () => {
        const image = {
            header: { width: 4, height: 1, bitDepth: 2, colorType: "indexed" as const, interlaced: false },
            data: new Uint8Array([0b00_01_10_11]),
            palette: [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]] as [number, number, number][],
            transparency: { kind: "palette" as const, alpha: new Uint8Array([0, 128]) },
        };
        const png = encode(image);
        const chunks = readChunks(png);
        expect(chunks.palette).toEqual(image.palette);
        expect(chunks.transparency).toEqual(image.transparency);
        expect([...decodeRgba8(png).data]).toEqual([255, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255, 255, 255, 255, 255]);
    });

    it("applies encoder options", () => {
        const data = new Uint8Array(64 * 64 * 4).fill(200);
        const stored = encodeRgba8({ width: 64, height: 64, data }, { compressionStrategy: "stored" });
        const best = encodeRgba8({ width: 64, height: 64, data }, { compression: 9, filter: "paeth" });
        expect(stored.length).toBeGreaterThan(data.length);
        expect(best.length).toBeLessThan(200);
        expect(decodeRgba8(best).data).toEqual(new Uint8ClampedArray(data));

        const encoder = new PngEncoder({ compression: 1 });
        expect(decodeRgba8(encoder.encodeRgba8({ width: 64, height: 64, data })).data.length).toBe(data.length);
        encoder.free();
    });

    it("skips unsafe-to-copy chunks unless asked", () => {
        const chunks = [{ type: "myBK", data: new Uint8Array([1]), position: "before-image-data" as const }];
        const image = { width: 1, height: 1, data: new Uint8Array(4), chunks };
        expect(readChunks(encodeRgba8(image)).chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
        expect(readChunks(encodeRgba8(image, { keepUnsafeChunks: true })).chunks.map((c) => c.type)).toEqual(["IHDR", "myBK", "IDAT", "IEND"]);
    });

    it("writes and reads iCCP, cICP and eXIf", () => {
        const exif = new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0]); // little-endian TIFF header, no entries
        const metadata = {
            iccProfile: { name: "Test profile", profile: Uint8Array.from({ length: 300 }, (_, i) => i % 7) },
            cicp: { colorPrimaries: 12, transferFunction: 13, matrixCoefficients: 0, fullRange: true },
            exif: { data: exif },
        };
        const png = encodeRgba8({ width: 1, height: 1, data: new Uint8Array(4), metadata });
        const read = readChunks(png);
        expect(read.chunks.map((c) => c.type)).toEqual(["IHDR", "cICP", "iCCP", "eXIf", "IDAT", "IEND"]);
        expect(read.metadata.iccProfile).toEqual(metadata.iccProfile);
        expect(read.metadata.cicp).toEqual(metadata.cicp);
        expect(read.metadata.exif).toEqual({ data: exif, byteOrder: "little-endian" });
        expect(decodeRgba8(png, { preserveMetadata: true }).metadata.cicp?.colorPrimaries).toBe(12);

        expect(() => encodeRgba8({ width: 1, height: 1, data: new Uint8Array(4), metadata: { exif: { data: new Uint8Array(8) } } })).toThrow(PngError);
    });

    it("converts images with few colors to a palette", () => {
        // Four colors, one of them translucent.
        const colors = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 128], [255, 255, 255, 255]];
        // A scattered pattern, so indexed color clearly wins.
        const data = Uint8Array.from(Array.from({ length: 64 * 64 }, (_, i) => colors[((i * 2654435761) >>> 13) % 4]).flat());
        const image = { width: 64, height: 64, data };

        const rgba = encodeRgba8(image);
        const indexed = encodeRgba8(image, { palette: "auto" });
        expect(readHeader(indexed)).toMatchObject({ colorType: "indexed", bitDepth: 2 });
        expect(readChunks(indexed).palette).toHaveLength(4);
        expect(readChunks(indexed).transparency).toEqual({ kind: "palette", alpha: new Uint8Array([128]) });
        expect(indexed.length).toBeLessThan(rgba.length);
        expect(decodeRgba8(indexed).data).toEqual(decodeRgba8(rgba).data);

        // Too many colors: written as it is.
        const noisy = Uint8Array.from({ length: 32 * 32 * 4 }, (_, i) => (i * 2654435761) >>> 24);
        expect(readHeader(encodeRgba8({ width: 32, height: 32, data: noisy }, { palette: "auto" })).colorType).toBe("rgba");
    });

    it("never makes a tiny image bigger with a palette", () => {
        // Tiny and perfectly regular: the palette's chunks cost more than they save.
        const colors = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 128], [255, 255, 255, 255]];
        const data = Uint8Array.from(Array.from({ length: 16 * 16 }, (_, i) => colors[(i + (i >> 4)) % 4]).flat());
        const image = { width: 16, height: 16, data };

        const auto = encodeRgba8(image, { palette: "auto" });
        expect(auto.length).toBeLessThanOrEqual(encodeRgba8(image).length);
        expect(decodeRgba8(auto).data).toEqual(new Uint8ClampedArray(data));
    });

    it("decodes in the file's own format and re-encodes losslessly", () => {
        for (const name of ["rgba_16.png", "gray_16_adam7.png", "rgb_16_trns.png", "gray_1.png", "indexed_2_trns.png", "rgb_8_plte.png"]) {
            const original = decode(fixture(`valid/${name}`));
            const copy = decode(encode(original));
            expect(copy.header, name).toEqual(original.header);
            expect(copy.data, name).toEqual(original.data);
            expect(copy.palette, name).toEqual(original.palette);
            expect(copy.transparency, name).toEqual(original.transparency);
        }

        const rgba16 = decode(fixture("valid/rgba_16.png"));
        expect(rgba16.header).toMatchObject({ bitDepth: 16, colorType: "rgba" });
        expect(rgba16.data.length).toBe(13 * 7 * 8); // 4 channels of 2 bytes, big-endian
        expect(decode(fixture("valid/gray_1.png")).data.length).toBe(7 * 2); // 13 pixels packed into 2 bytes a row

        const indexed = decode(fixture("valid/indexed_2_trns.png"));
        expect(indexed.palette).toHaveLength(4);
        expect(indexed.transparency).toEqual({ kind: "palette", alpha: new Uint8Array([0, 85, 170]) });
    });

    it("keeps metadata and chunks when decoding raw", () => {
        const decoder = new PngDecoder({ preserveMetadata: true, preserveChunks: true });
        const image = decoder.decode(fixture("valid/ancillary_chunks.png"));
        decoder.free();
        expect(image.metadata.text.map((t) => t.keyword)).toEqual(["Title", "Comment"]);
        expect(readChunks(encode(image)).chunks.map((c) => c.type)).toContain("ruSt");
        expect(() => decode(new Uint8Array([1, 2, 3]))).toThrow(PngError);
    });

    it("strips chunks by level", () => {
        const options = { preserveMetadata: true, preserveChunks: true };
        const image = decodeRgba8(fixture("valid/metadata.png"), options);
        const types = (strip: "keep" | "safe" | "all") => readChunks(encodeRgba8(image, { strip })).chunks.map((c) => c.type);

        expect(types("keep")).toContain("tIME");
        expect(types("safe")).toEqual(expect.arrayContaining(["sRGB", "gAMA", "cHRM", "pHYs"]));
        expect(types("safe")).not.toContain("tIME");
        expect(types("all")).toEqual(["IHDR", "IDAT", "IEND"]);

        const withText = { ...image, metadata: { text: [{ keyword: "Title", text: "x" }] }, chunks: [{ type: "ruSt", data: new Uint8Array(1), position: "after-image-data" as const }] };
        expect(readChunks(encodeRgba8(withText, { strip: "safe" })).chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    });

    it("throws PngError for images it can't encode", () => {
        expect(() => encodeRgba8({ width: 2, height: 2, data: new Uint8Array(3) })).toThrow(PngError);
        expect(() => encodeRgba8({ width: 1, height: 1, data: new Uint8Array(4), metadata: { text: [{ keyword: "", text: "x" }] } })).toThrow(PngError);
        expect(() => encodeRgba8({ width: 1, height: 1, data: new Uint8Array(4) }, { compression: 10 })).toThrow(/0 to 9/);
        expect(() => encodeRgba8({ width: 1, height: 1, data: new Uint8Array(4), chunks: [{ type: "IDAT", data: new Uint8Array(), position: "after-image-data" }] })).toThrow(PngError);
        const header = { width: 1, height: 1, bitDepth: 8, colorType: "indexed" as const, interlaced: false };
        expect(() => encode({ header, data: new Uint8Array(1) })).toThrow(/PLTE/);
    });
});
