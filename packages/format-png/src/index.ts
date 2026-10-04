import initWasm, * as wasm from "./wasm/format_png_wasm.js";

export type ColorType = "grayscale" | "rgb" | "indexed" | "grayscale-alpha" | "rgba";

export interface PngHeader {
    width: number;
    height: number;
    bitDepth: number;
    colorType: ColorType;
    interlaced: boolean;
}

export type RenderingIntent = "perceptual" | "relative-colorimetric" | "saturation" | "absolute-colorimetric";

/** A CIE 1931 chromaticity, for example `{ x: 0.3127, y: 0.329 }`. */
export interface Chromaticity {
    x: number;
    y: number;
}

/** `cHRM`: the chromaticities of the white point and the primaries. */
export interface Chromaticities {
    white: Chromaticity;
    red: Chromaticity;
    green: Chromaticity;
    blue: Chromaticity;
}

/**
 * `pHYs`: pixels per unit. With unit "meter" this is the intended pixel size;
 * with "unknown" only the ratio of `x` to `y` means anything.
 */
export interface PhysicalDimensions {
    x: number;
    y: number;
    unit: "meter" | "unknown";
}

/** `tIME`: when the image was last modified, in UTC. `month` is 1 to 12. */
export interface PngTime {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
}

/** A `tEXt`, `zTXt` or `iTXt` chunk, decoded to a string whatever its encoding. */
export interface PngText {
    /** For example "Title", "Author" or "Comment". */
    keyword: string;
    text: string;
    /** `iTXt` only, for example "en" or "nb-NO"; otherwise empty. */
    languageTag: string;
    /** `iTXt` only: the keyword in that language; otherwise empty. */
    translatedKeyword: string;
    chunkType: "tEXt" | "zTXt" | "iTXt";
    /** Whether the text was zlib-compressed in the file. */
    compressed: boolean;
}

/**
 * The known ancillary chunks, parsed. A field is absent if the image doesn't
 * have that chunk, or if it was invalid or misplaced and `strictAncillary` is off.
 */
export interface PngMetadata {
    /** `gAMA`, for example 0.45455 (1/2.2). */
    gamma?: number;
    chromaticities?: Chromaticities;
    /** `sRGB`: the image is sRGB, with this rendering intent. */
    srgb?: RenderingIntent;
    physicalDimensions?: PhysicalDimensions;
    time?: PngTime;
    /** `tEXt`, `zTXt` and `iTXt`, in file order. A keyword may repeat. */
    text: PngText[];
}

export type ChunkPosition = "before-palette" | "before-image-data" | "after-image-data";

/** A raw ancillary chunk, including private and unknown ones. */
export interface PngChunk {
    /** The four-letter type, for example "tEXt". */
    type: string;
    /** The chunk's data, without length, type and CRC. */
    data: Uint8Array;
    /** Where the chunk was relative to `PLTE` and the image data. */
    position: ChunkPosition;
}

/** One chunk as it is in the file, from `readChunks`. */
export interface PngRawChunk {
    /** The four-letter type, for example "IHDR" or "tEXt". */
    type: string;
    /** Where the chunk starts in the input: its length field. */
    offset: number;
    /** The chunk's data, without length, type and CRC. A view into the input, not a copy. */
    data: Uint8Array;
    /** The CRC stored in the file. */
    crc: number;
    /** Whether format-png parses this chunk type. */
    known: boolean;
    /** Uppercase first letter: needed to display the image. */
    critical: boolean;
    /** Uppercase second letter: defined or registered by the PNG spec, not private. */
    public: boolean;
    /** Lowercase fourth letter: editors may copy it even after changing the image. */
    safeToCopy: boolean;
}

/**
 * `tRNS`: one fully transparent gray value or RGB color, in the image's bit
 * depth, or an alpha per palette entry (entries past the end are opaque).
 */
export type PngTransparency =
    | { kind: "gray"; value: number }
    | { kind: "rgb"; value: [number, number, number] }
    | { kind: "palette"; alpha: Uint8Array };

/** Every chunk of a PNG, read and parsed without decompressing the image data. */
export interface PngChunks {
    header: PngHeader;
    /** `PLTE`, as `[r, g, b]` entries in index order. Indexed images always have one. */
    palette?: [number, number, number][];
    transparency?: PngTransparency;
    /** Always collected, whatever `preserveMetadata` says. */
    metadata: PngMetadata;
    /** Every chunk from `IHDR` to `IEND`, in file order, including unknown ones. */
    chunks: PngRawChunk[];
}

/** Options for `readChunks`. */
export interface ReadChunksOptions {
    /** Check each chunk's CRC. Default true. */
    validateCrc?: boolean;
    /** Throw for an invalid, misplaced or repeated metadata chunk instead of skipping it. Default false. */
    strictAncillary?: boolean;
}

export interface DecodeOptions {
    /** Check each chunk's CRC. Default true. */
    validateCrc?: boolean;
    /** Parse known ancillary chunks into `metadata`. Default false. */
    preserveMetadata?: boolean;
    /** Keep a raw copy of every ancillary chunk in `chunks`. Default false. */
    preserveChunks?: boolean;
    /** Throw for an invalid, misplaced or repeated metadata chunk instead of skipping it. Default false. */
    strictAncillary?: boolean;
}

/** 8-bit RGBA pixels, not premultiplied, rows packed with no padding. */
export interface RgbaImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
    /** Empty unless decoded with `preserveMetadata`. */
    metadata: PngMetadata;
    /** In file order. Empty unless decoded with `preserveChunks`. */
    chunks: PngChunk[];
}

/** Thrown for malformed PNGs; `message` says what's wrong. */
export class PngError extends Error {
    override name = "PngError";
}

let ready: Promise<void> | undefined;
let initialized = false;

/**
 * Loads the WebAssembly module. Call it once before anything else; later calls
 * return the same promise. In browsers and bundlers, call it with no argument.
 * In Node, pass the `.wasm` file's bytes.
 */
export function init(source?: BufferSource | WebAssembly.Module | URL | string): Promise<void> {
    ready ??= initWasm(source === undefined ? undefined : { module_or_path: source })
        .then(() => {
            initialized = true;
        })
        .catch((error) => {
            ready = undefined; // allow a retry
            throw error;
        });
    return ready;
}

function call<T>(fn: () => T): T {
    if (!initialized) throw new PngError("format-png: call init() first");
    try {
        return fn();
    } catch (error) {
        throw new PngError(error instanceof Error ? error.message : String(error));
    }
}

function decoderArgs(options: DecodeOptions): [boolean, boolean, boolean, boolean] {
    return [
        options.validateCrc ?? true,
        options.preserveMetadata ?? false,
        options.preserveChunks ?? false,
        options.strictAncillary ?? false,
    ];
}

function toText(source: wasm.Text): PngText {
    try {
        return {
            keyword: source.keyword,
            text: source.text,
            languageTag: source.languageTag,
            translatedKeyword: source.translatedKeyword,
            chunkType: source.chunkType as PngText["chunkType"],
            compressed: source.compressed,
        };
    } finally {
        source.free();
    }
}

function toMetadata(source: wasm.Metadata): PngMetadata {
    const metadata: PngMetadata = { text: source.text().map(toText) };
    if (source.gamma !== undefined) metadata.gamma = source.gamma;
    if (source.srgb !== undefined) metadata.srgb = source.srgb as RenderingIntent;

    const c = source.chromaticities;
    if (c) {
        metadata.chromaticities = {
            white: { x: c[0], y: c[1] },
            red: { x: c[2], y: c[3] },
            green: { x: c[4], y: c[5] },
            blue: { x: c[6], y: c[7] },
        };
    }

    const physical = source.physicalPixelsPerUnit;
    if (physical) {
        metadata.physicalDimensions = {
            x: physical[0],
            y: physical[1],
            unit: source.physicalUnit as PhysicalDimensions["unit"],
        };
    }

    const t = source.time;
    if (t) metadata.time = { year: t[0], month: t[1], day: t[2], hour: t[3], minute: t[4], second: t[5] };
    return metadata;
}

function toChunk(chunk: wasm.Chunk): PngChunk {
    const { chunkType: type, position } = chunk;
    return { type, position: position as ChunkPosition, data: chunk.intoData() }; // `intoData` frees `chunk`
}

/** Reads `source.metadata()` and frees the wasm copy. */
function takeMetadata(source: { metadata(): wasm.Metadata }): PngMetadata {
    const metadata = source.metadata();
    try {
        return toMetadata(metadata);
    } finally {
        metadata.free();
    }
}

function toHeader(header: wasm.Header): PngHeader {
    try {
        return {
            width: header.width,
            height: header.height,
            bitDepth: header.bitDepth,
            colorType: header.colorType as ColorType,
            interlaced: header.interlaced,
        };
    } finally {
        header.free();
    }
}

function toTransparency(kind: string, values: Uint16Array): PngTransparency {
    switch (kind) {
        case "gray":
            return { kind, value: values[0] };
        case "rgb":
            return { kind, value: [values[0], values[1], values[2]] };
        default:
            return { kind: "palette", alpha: Uint8Array.from(values) };
    }
}

const isUpper = (char: string) => char >= "A" && char <= "Z";

function toChunks(list: wasm.ChunkList, bytes: Uint8Array): PngChunks {
    try {
        const { types, offsets, lengths, crcs, known, palette, transparencyKind, transparencyValues } = list;
        const result: PngChunks = {
            header: toHeader(list.header()),
            metadata: takeMetadata(list),
            chunks: Array.from(offsets, (offset, i) => {
                const type = types.slice(i * 4, i * 4 + 4);
                return {
                    type,
                    offset,
                    data: bytes.subarray(offset + 8, offset + 8 + lengths[i]),
                    crc: crcs[i],
                    known: known[i] === 1,
                    critical: isUpper(type[0]),
                    public: isUpper(type[1]),
                    safeToCopy: !isUpper(type[3]),
                };
            }),
        };
        if (palette) {
            result.palette = Array.from({ length: palette.length / 3 }, (_, i) => [palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]]);
        }
        if (transparencyKind && transparencyValues) result.transparency = toTransparency(transparencyKind, transparencyValues);
        return result;
    } finally {
        list.free();
    }
}

function toImage(decoded: wasm.DecodedImage): RgbaImage {
    const { width, height } = decoded;
    const metadata = takeMetadata(decoded);
    const chunks = decoded.takeChunks().map(toChunk);
    const pixels = decoded.intoPixels(); // copies out of wasm memory and frees `decoded`
    // A fresh ArrayBuffer, so viewing it as clamped bytes copies nothing.
    const data = new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, pixels.byteLength);
    return { width, height, data, metadata, chunks };
}

/** Decodes a PNG to 8-bit RGBA. Pass options to also read metadata or raw chunks. */
export function decodeRgba8(bytes: Uint8Array, options: DecodeOptions = {}): RgbaImage {
    return call(() => toImage(wasm.decodeRgba8(bytes, ...decoderArgs(options))));
}

/**
 * Reads and parses every chunk without decompressing the image data, which is
 * much faster than decoding. Known chunks are parsed; every chunk, including
 * private and unknown ones, is also returned raw in file order.
 */
export function readChunks(bytes: Uint8Array, options: ReadChunksOptions = {}): PngChunks {
    return call(() => toChunks(wasm.readChunks(bytes, options.validateCrc ?? true, options.strictAncillary ?? false), bytes));
}

/** Parses the data of a `tEXt`, `zTXt` or `iTXt` chunk on its own, for example one from `readChunks`. */
export function parseText(type: PngText["chunkType"], data: Uint8Array): PngText {
    return call(() => toText(wasm.parseText(type, data)));
}

/** Pixels per inch from `pHYs`, or undefined if its unit isn't meters. */
export function pixelsPerInch(dimensions: PhysicalDimensions): { x: number; y: number } | undefined {
    if (dimensions.unit !== "meter") return undefined;
    return { x: dimensions.x * 0.0254, y: dimensions.y * 0.0254 };
}

/** Reads the image header without decoding pixels. */
export function readHeader(bytes: Uint8Array): PngHeader {
    return call(() => toHeader(wasm.readHeader(bytes)));
}

/** Wraps an image for `CanvasRenderingContext2D.putImageData`. Browser only. */
export function toImageData(image: RgbaImage): ImageData {
    return new ImageData(image.data as Uint8ClampedArray<ArrayBuffer>, image.width, image.height);
}

/**
 * A decoder for many images: it keeps its buffers in wasm memory between calls.
 * Call `free()` when you're done with it.
 */
export class PngDecoder {
    #inner: wasm.Decoder;

    constructor(options: DecodeOptions = {}) {
        this.#inner = call(() => new wasm.Decoder(...decoderArgs(options)));
    }

    decodeRgba8(bytes: Uint8Array): RgbaImage {
        return call(() => toImage(this.#inner.decodeRgba8(bytes)));
    }

    /** Like the `readChunks` function. Only the `validateCrc` and `strictAncillary` options apply. */
    readChunks(bytes: Uint8Array): PngChunks {
        return call(() => toChunks(this.#inner.readChunks(bytes), bytes));
    }

    free(): void {
        this.#inner.free();
    }
}