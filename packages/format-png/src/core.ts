import initWasm, * as wasm from "./wasm/format_png_wasm.js";
import wasmBase64 from "./wasm/format_png_wasm_bg.wasm.base64.js";

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

/** `iCCP`: an embedded ICC color profile. */
export interface IccProfile {
    /** Only meaningful to people, for example "ICC Profile". 1 to 79 characters of printable Latin-1. */
    name: string;
    /** The ICC profile, decompressed. Pass it to a color management library to apply it. */
    profile: Uint8Array;
}

/**
 * `cICP`: the color space as ITU-T H.273 code points, as video uses. sRGB is
 * primaries 1 and transfer 13; Display P3 is 12 and 13; HDR PQ is 9 and 16.
 * Takes precedence over every other color chunk.
 */
export interface Cicp {
    colorPrimaries: number;
    transferFunction: number;
    /** Always 0 (RGB) in PNG. */
    matrixCoefficients: number;
    /** Whether samples use the full range, as almost all PNGs do, rather than video's narrow range. */
    fullRange: boolean;
}

/** `eXIf`: Exif metadata, such as the camera and orientation, kept raw. */
export interface PngExif {
    /** Starts with a TIFF header; pass it to an Exif library to read the tags. */
    data: Uint8Array;
    byteOrder: "big-endian" | "little-endian";
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
    iccProfile?: IccProfile;
    cicp?: Cicp;
    exif?: PngExif;
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

/**
 * Text to write as a `tEXt`, `zTXt` or `iTXt` chunk. A `PngText` from decoding
 * works as it is.
 */
export interface PngTextInput {
    /** 1 to 79 characters of printable Latin-1, for example "Title" or "Author". */
    keyword: string;
    /** Latin-1 only for `tEXt` and `zTXt`; any Unicode for `iTXt`. */
    text: string;
    /** Default "tEXt". `zTXt` is always compressed. */
    chunkType?: PngText["chunkType"];
    /** `iTXt` only: whether to zlib-compress the text. Default false. */
    compressed?: boolean;
    /** `iTXt` only, for example "en" or "nb-NO". */
    languageTag?: string;
    /** `iTXt` only: the keyword in that language. */
    translatedKeyword?: string;
}

/** The metadata chunks to write. A `PngMetadata` from decoding works as it is. */
export interface PngMetadataInput {
    gamma?: number;
    chromaticities?: Chromaticities;
    srgb?: RenderingIntent;
    physicalDimensions?: PhysicalDimensions;
    time?: PngTime;
    /** Written in order. */
    text?: PngTextInput[];
    /** The profile is given uncompressed; the encoder compresses it. */
    iccProfile?: IccProfile;
    cicp?: Cicp;
    /** Its TIFF header is checked; `byteOrder` is read from it, so it can be left out. */
    exif?: { data: Uint8Array; byteOrder?: PngExif["byteOrder"] };
}

/**
 * An image to encode, in the PNG's own pixel format: rows top to bottom with
 * each padded to a whole byte, 16-bit samples big-endian, pixels under 8 bits
 * packed most significant bits first, and palette indices for indexed images.
 */
export interface PngImage {
    header: PngHeader;
    data: Uint8Array;
    /** `PLTE`, as `[r, g, b]` entries. Indexed images need one; grayscale images must not have one. */
    palette?: [number, number, number][];
    /** `tRNS`. Images with an alpha channel must not have one. */
    transparency?: PngTransparency;
    metadata?: PngMetadataInput;
    /** Raw ancillary chunks, written at their positions; see `EncodeOptions.keepUnsafeChunks`. */
    chunks?: PngChunk[];
}

/**
 * An image decoded in the file's own format by `decode`, without conversion:
 * 16-bit samples stay 16-bit (big-endian bytes, as in the file), so passing it
 * to `encode` writes the same pixels back.
 */
export interface RawImage extends PngImage {
    /** Empty unless decoded with `preserveMetadata`. */
    metadata: PngMetadata;
    /** In file order. Empty unless decoded with `preserveChunks`. */
    chunks: PngChunk[];
}

/** 8-bit RGBA pixels to encode. An `RgbaImage` from decoding, or an `ImageData`, works as it is. */
export interface RgbaImageInput {
    width: number;
    height: number;
    /** `width * height * 4` bytes, rows packed with no padding. */
    data: Uint8Array | Uint8ClampedArray;
    metadata?: PngMetadataInput;
    chunks?: PngChunk[];
    /** Write Adam7 interlaced. Default false. */
    interlaced?: boolean;
}

export type FilterType = "none" | "sub" | "up" | "average" | "paeth";

export interface EncodeOptions {
    /** 0 (none) to 9 (smallest). Default 6. */
    compression?: number;
    /**
     * The kind of DEFLATE blocks. "dynamic" (the default) gives the smallest
     * files, "fixed" is a little faster, "stored" doesn't compress.
     */
    compressionStrategy?: "dynamic" | "fixed" | "stored";
    /**
     * How each row is filtered before compressing. "adaptive" (the default)
     * picks a filter per row; the others use that filter for every row.
     */
    filter?: "adaptive" | FilterType;
    /**
     * Also write raw chunks that aren't safe to copy, such as `bKGD`, whose data
     * depends on the pixels. Default false. Turn it on when re-encoding an image
     * with its pixels, header and palette unchanged.
     */
    keepUnsafeChunks?: boolean;
    /**
     * "auto" writes 8-bit RGB and RGBA images with at most 256 colors, counting
     * alpha, as indexed color at the smallest bit depth that fits. Lossless, and
     * often several times smaller for logos, icons and screenshots; unsafe-to-copy
     * chunks are then dropped, as they describe the old color type. Default "keep".
     */
    palette?: PaletteMode;
    /** Which ancillary chunks to leave out to make the file smaller. Default "keep". */
    strip?: StripChunks;
    /**
     * How the image data is compressed. "single" (the default here) compresses
     * it as one stream: the smallest file. "auto" compresses it in independent
     * 1 MiB segments, as the format-png crate's `Threads::Auto` does natively;
     * the file is a little larger. A worker pool splits those segments across
     * its workers, so its encoder defaults to "auto". WebAssembly has no
     * threads, so on its own "auto" is no faster: use it to get the same bytes
     * as a pool.
     */
    threads?: "single" | "auto";
}

export type PaletteMode = "keep" | "auto";

/**
 * Which ancillary chunks the encoder leaves out. `tRNS` and an indexed image's
 * palette are always kept.
 *
 * - "keep": write everything given.
 * - "safe": keep what changes how the image looks: `cICP`, `iCCP`, `sRGB`,
 *   `gAMA`, `cHRM` and `pHYs`. Drop text, `tIME`, `eXIf`, raw chunks and an
 *   RGB image's suggested palette. Exif orientation is lost with it.
 * - "all": keep nothing optional, for the smallest file. Colors may look
 *   different in color-managed viewers such as browsers.
 */
export type StripChunks = "keep" | "safe" | "all";

/** Thrown for malformed PNGs; `message` says what's wrong. */
export class PngError extends Error {
    override name = "PngError";
}

let ready: Promise<void> | undefined;
let initialized = false;

/**
 * Loads the WebAssembly module. Call it once before anything else; later calls
 * return the same promise.
 *
 * With no argument it uses the copy embedded in this package, in browsers,
 * bundlers and Node alike: nothing is fetched. You can instead pass a
 * `WebAssembly.Module` compiled from it, for example one a page compiled once
 * and posted to its workers.
 */
export function init(source?: BufferSource | WebAssembly.Module | Response | Promise<Response>): Promise<void> {
    ready ??= initWasm({ module_or_path: source ?? decodeBase64(wasmBase64) })
        .then(() => {
            initialized = true;
        })
        .catch((error) => {
            ready = undefined; // allow a retry
            throw error;
        });
    return ready;
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function call<T>(fn: () => T): T {
    if (!initialized) throw new PngError("format-png: call init() first");
    try {
        return fn();
    } catch (error) {
        throw new PngError(error instanceof Error ? error.message : String(error), { cause: error });
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

    const profile = source.iccProfile;
    if (profile) metadata.iccProfile = { name: source.iccProfileName!, profile };

    const cicp = source.cicp;
    if (cicp) {
        metadata.cicp = { colorPrimaries: cicp[0], transferFunction: cicp[1], matrixCoefficients: cicp[2], fullRange: cicp[3] === 1 };
    }

    const exif = source.exif;
    if (exif) metadata.exif = { data: exif, byteOrder: source.exifByteOrder as PngExif["byteOrder"] };
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
        if (palette) result.palette = toPalette(palette);
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

/** Turns a flat `r, g, b, …` array into `[r, g, b]` entries. */
function toPalette(flat: Uint8Array): [number, number, number][] {
    return Array.from({ length: flat.length / 3 }, (_, i) => [flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]]);
}

function toRawImage(decoded: wasm.RawImage): RawImage {
    const header = toHeader(decoded.header());
    const { palette, transparencyKind, transparencyValues } = decoded;
    const metadata = takeMetadata(decoded);
    const chunks = decoded.takeChunks().map(toChunk);
    const data = decoded.intoData(); // copies out of wasm memory and frees `decoded`
    const image: RawImage = { header, data, metadata, chunks };
    if (palette) image.palette = toPalette(palette);
    if (transparencyKind && transparencyValues) image.transparency = toTransparency(transparencyKind, transparencyValues);
    return image;
}

/**
 * Decodes a PNG in its own format, without conversion: every bit depth and
 * color type as stored, with its palette and transparency. Pass the result to
 * `encode` to re-encode it losslessly. Use `decodeRgba8` to display it.
 */
export function decode(bytes: Uint8Array, options: DecodeOptions = {}): RawImage {
    return call(() => toRawImage(wasm.decode(bytes, ...decoderArgs(options))));
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

function encoderArgs(options: EncodeOptions): [number, string, string, boolean, string, string, string] {
    return [
        options.compression ?? 6,
        options.compressionStrategy ?? "dynamic",
        options.filter ?? "adaptive",
        options.keepUnsafeChunks ?? false,
        options.palette ?? "keep",
        options.strip ?? "keep",
        options.threads ?? "single",
    ];
}

function toEncodeImage(image: PngImage): wasm.EncodeImage {
    const { header, data, palette, transparency, metadata, chunks = [] } = image;
    const target = new wasm.EncodeImage(header.width, header.height, header.bitDepth, header.colorType, header.interlaced, data);
    try {
        if (palette) target.setPalette(Uint8Array.from(palette.flat()));
        if (transparency) {
            const values = transparency.kind === "palette" ? transparency.alpha : transparency.kind === "gray" ? [transparency.value] : transparency.value;
            target.setTransparency(transparency.kind, Uint16Array.from(values));
        }
        if (metadata) {
            const { gamma, chromaticities: c, srgb, physicalDimensions: p, time: t, text = [], iccProfile, cicp, exif } = metadata;
            if (cicp) target.setCicp(cicp.colorPrimaries, cicp.transferFunction, cicp.matrixCoefficients, cicp.fullRange);
            if (iccProfile) target.setIccProfile(iccProfile.name, iccProfile.profile);
            if (exif) target.setExif(exif.data);
            if (gamma !== undefined) target.setGamma(gamma);
            if (c) target.setChromaticities(new Float64Array([c.white.x, c.white.y, c.red.x, c.red.y, c.green.x, c.green.y, c.blue.x, c.blue.y]));
            if (srgb) target.setSrgb(srgb);
            if (p) target.setPhysicalDimensions(p.x, p.y, p.unit);
            if (t) target.setTime(t.year, t.month, t.day, t.hour, t.minute, t.second);
            for (const entry of text) {
                target.addText(entry.chunkType ?? "tEXt", entry.keyword, entry.text, entry.languageTag ?? "", entry.translatedKeyword ?? "", entry.compressed ?? false);
            }
        }
        for (const chunk of chunks) target.addChunk(chunk.type, chunk.data, chunk.position);
        return target;
    } catch (error) {
        target.free();
        throw error;
    }
}

/** `image` as `encode` takes it. Internal: for the worker pool. */
export function rgbaToPngImage(image: RgbaImageInput): PngImage {
    const { width, height, data, metadata, chunks, interlaced = false } = image;
    return {
        header: { width, height, bitDepth: 8, colorType: "rgba", interlaced },
        // A view of the same bytes, so a Uint8ClampedArray isn't copied here.
        data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        metadata,
        chunks,
    };
}

/** Encodes `image`, then frees the wasm copy of it. */
function encodeWith(image: PngImage, encode: (image: wasm.EncodeImage) => Uint8Array): Uint8Array {
    const target = toEncodeImage(image);
    try {
        return encode(target);
    } finally {
        target.free();
    }
}

/**
 * Encodes an image in any PNG pixel format, with its palette, transparency,
 * metadata and raw chunks.
 */
export function encode(image: PngImage, options: EncodeOptions = {}): Uint8Array {
    return call(() => encodeWith(image, (target) => wasm.encode(target, ...encoderArgs(options))));
}

/**
 * Encodes 8-bit RGBA pixels: the reverse of `decodeRgba8`. Pass a decoded
 * `RgbaImage` to re-encode it with its metadata and chunks, or the `ImageData`
 * of a canvas.
 */
export function encodeRgba8(image: RgbaImageInput, options: EncodeOptions = {}): Uint8Array {
    return encode(rgbaToPngImage(image), options);
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

    /** Like the `decode` function. */
    decode(bytes: Uint8Array): RawImage {
        return call(() => toRawImage(this.#inner.decode(bytes)));
    }

    /** Like the `readChunks` function. Only the `validateCrc` and `strictAncillary` options apply. */
    readChunks(bytes: Uint8Array): PngChunks {
        return call(() => toChunks(this.#inner.readChunks(bytes), bytes));
    }

    free(): void {
        this.#inner.free();
    }
}

/**
 * An encoder for many images: it keeps its compressor and buffers in wasm
 * memory between calls. Call `free()` when you're done with it.
 */
export class PngEncoder {
    #inner: wasm.Encoder;

    constructor(options: EncodeOptions = {}) {
        this.#inner = call(() => new wasm.Encoder(...encoderArgs(options)));
        wasmEncoders.set(this, this.#inner);
    }

    /** Like the `encode` function, with this encoder's options. */
    encode(image: PngImage): Uint8Array {
        return call(() => encodeWith(image, (target) => this.#inner.encode(target)));
    }

    /** Like the `encodeRgba8` function, with this encoder's options. */
    encodeRgba8(image: RgbaImageInput): Uint8Array {
        return this.encode(rgbaToPngImage(image));
    }

    free(): void {
        this.#inner.free();
    }
}
// Internal: for the worker pool, which splits one image's compression across
// its workers. Not exported from index.ts.

/** Each `PngEncoder`'s wasm encoder, for `prepare`. */
const wasmEncoders = new WeakMap<PngEncoder, wasm.Encoder>();

/**
 * Everything `encoder.encode(image)` does except compress the image data,
 * which is left in segments. Call `free()` on the result when done with it.
 */
export function prepare(encoder: PngEncoder, image: PngImage): wasm.Prepared {
    const inner = wasmEncoders.get(encoder)!;
    return call(() => {
        const target = toEncodeImage(image);
        try {
            return inner.prepare(target);
        } finally {
            target.free();
        }
    });
}

/** Compresses one segment of a `Prepared`, with its `compressionLevel` and `compressionStrategy`. */
export function compressSegment(segment: Uint8Array, level: number, strategy: string): Uint8Array {
    return call(() => wasm.compressSegment(segment, level, strategy));
}

/** The PNG, from `prepared` and its segments compressed in order. `prepared` still needs `free()`. */
export function finish(prepared: wasm.Prepared, compressed: Uint8Array[]): Uint8Array {
    return call(() => {
        for (const segment of compressed) prepared.pushCompressed(segment);
        return prepared.finish();
    });
}
