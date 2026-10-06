// A WorkerPool worker: runs one task at a time with the sync API. It keeps its
// decoders and encoders between tasks, so a batch keeps the crate's buffer
// reuse, and the images it prepared until they're finished or freed. See
// protocol.ts for the messages.

import { listen, post } from "#port";
import {
    PngDecoder, PngEncoder, PngError, compressSegment, finish, init, parseText, prepare, readHeader, rgbaToPngImage,
    type DecodeOptions, type EncodeOptions, type PngChunks, type PngImage, type PngText, type ReadChunksOptions, type RgbaImageInput,
} from "./core.js";
import { buffersIn, type Prepared, type Request, type Response } from "./protocol.js";

/** The most recently used decoders or encoders, one per set of options. */
class Cache<T extends { free(): void }> {
    #entries = new Map<string, T>();

    get(key: string, create: () => T): T {
        let entry = this.#entries.get(key);
        if (entry) {
            this.#entries.delete(key); // moved to the end: most recently used
        } else {
            entry = create();
            if (this.#entries.size === 4) {
                const [oldest, value] = this.#entries.entries().next().value!;
                this.#entries.delete(oldest);
                value.free();
            }
        }
        this.#entries.set(key, entry);
        return entry;
    }
}

const decoders = new Cache<PngDecoder>();
const encoders = new Cache<PngEncoder>();
let ready: Promise<void> | undefined;
let loaded = false;

function decoder(options: DecodeOptions): PngDecoder {
    const { validateCrc = true, preserveMetadata = false, preserveChunks = false, strictAncillary = false } = options;
    const key = [validateCrc, preserveMetadata, preserveChunks, strictAncillary].join();
    return decoders.get(key, () => new PngDecoder({ validateCrc, preserveMetadata, preserveChunks, strictAncillary }));
}

function encoder(options: EncodeOptions): PngEncoder {
    const { compression, compressionStrategy, filter, keepUnsafeChunks, palette, strip, threads } = options;
    const normalized = { compression, compressionStrategy, filter, keepUnsafeChunks, palette, strip, threads };
    return encoders.get(JSON.stringify(normalized), () => new PngEncoder(normalized));
}

/** The images this worker prepared, by handle, until they're finished or freed. */
const handles = new Map<number, ReturnType<typeof prepare>>();

/** Prepares `image`, keeping it as `handle` if it has segments to compress. */
function prepareImage(image: PngImage, options: EncodeOptions, handle: number): Prepared {
    const prepared = prepare(encoder(options), image);
    try {
        if (prepared.segmentCount === 0) return { png: finish(prepared, []) };
        const segments = Array.from({ length: prepared.segmentCount }, (_, i) => prepared.segment(i));
        const result = { segments, level: prepared.compressionLevel, strategy: prepared.compressionStrategy };
        handles.set(handle, prepared);
        return result;
    } finally {
        if (!handles.has(handle)) prepared.free();
    }
}

/** Takes the prepared image `handle` out of `handles`, so it's freed whatever happens next. */
function takeHandle(handle: number): ReturnType<typeof prepare> {
    const prepared = handles.get(handle);
    if (!prepared) throw new Error(`format-png: no prepared image ${handle} in this worker`);
    handles.delete(handle);
    return prepared;
}

/** The chunks' data are views into the input; they're sent as lengths and rebuilt on the other side. */
function withoutChunkData(chunks: PngChunks): unknown {
    return { ...chunks, chunks: chunks.chunks.map((chunk) => ({ ...chunk, data: chunk.data.byteLength })) };
}

function run(request: Request): unknown {
    const { op, args } = request;
    switch (op) {
        case "decode":
            return decoder(args[1] as DecodeOptions).decode(args[0] as Uint8Array);
        case "decodeRgba8":
            return decoder(args[1] as DecodeOptions).decodeRgba8(args[0] as Uint8Array);
        case "readChunks": {
            const { validateCrc, strictAncillary } = args[1] as ReadChunksOptions;
            const chunks = withoutChunkData(decoder({ validateCrc, strictAncillary }).readChunks(args[0] as Uint8Array));
            return request.returnInput ? { chunks, input: args[0] } : { chunks };
        }
        case "readHeader":
            return readHeader(args[0] as Uint8Array);
        case "parseText":
            return parseText(args[0] as PngText["chunkType"], args[1] as Uint8Array);
        case "encode":
        case "encodeRgba8": {
            const image = op === "encode" ? (args[0] as PngImage) : rgbaToPngImage(args[0] as RgbaImageInput);
            const options = args[1] as EncodeOptions;
            if (request.split) return prepareImage(image, options, request.handle!);
            return encoder(options).encode(image);
        }
        case "compressSegment":
            return compressSegment(args[0] as Uint8Array, args[1] as number, args[2] as string);
        case "finish": {
            const prepared = takeHandle(args[0] as number);
            try {
                return finish(prepared, args[1] as Uint8Array[]);
            } finally {
                prepared.free();
            }
        }
        case "free":
            takeHandle(args[0] as number).free();
            return null;
        case "handles":
            return handles.size;
    }
}

listen(async (request: Request) => {
    let response: Response;
    try {
        await (ready ??= init());
        loaded = true;
        const value = run(request);
        post({ id: request.id, ok: true, value } satisfies Response, buffersIn(value));
        return;
    } catch (error) {
        // A trap (a Rust panic, or running out of memory) can leave the wasm
        // instance broken, and a worker whose module didn't load is no use, so
        // the pool replaces this worker.
        const cause = error instanceof PngError ? error.cause : error;
        const retire = cause instanceof WebAssembly.RuntimeError || !loaded;
        response = {
            id: request.id,
            ok: false,
            error: error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) },
            retire,
        };
    }
    post(response, []);
});
