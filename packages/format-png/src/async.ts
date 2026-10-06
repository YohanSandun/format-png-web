// The async functions: the sync API's functions, run on a worker pool shared
// by all of them and created on first use. For control over the workers, use
// `createWorkerPool` instead.
import type {
    DecodeOptions, EncodeOptions, PngChunks, PngHeader, PngImage, PngText, RawImage, ReadChunksOptions, RgbaImage, RgbaImageInput,
} from "./core.js";
import { createWorkerPool, type JobOptions, type WorkerPool } from "./pool.js";

let shared: WorkerPool | undefined;

/**
 * The pool behind the async functions, created on first use with the default
 * size. Its workers start as jobs need them, and in Node an idle pool doesn't
 * keep the process alive.
 */
export function defaultWorkerPool(): WorkerPool {
    return (shared ??= createWorkerPool());
}

/**
 * Terminates the shared pool, freeing its workers and their memory. Its
 * pending jobs reject with a `WorkerPoolError`; the next async call starts a
 * new pool.
 */
export async function terminateDefaultWorkerPool(): Promise<void> {
    const pool = shared;
    shared = undefined;
    await pool?.terminate();
}

/** `decode`, in a worker. */
export function decodeAsync(bytes: Uint8Array, options?: DecodeOptions & JobOptions): Promise<RawImage> {
    return defaultWorkerPool().decode(bytes, options);
}

/** `decodeRgba8`, in a worker. */
export function decodeRgba8Async(bytes: Uint8Array, options?: DecodeOptions & JobOptions): Promise<RgbaImage> {
    return defaultWorkerPool().decodeRgba8(bytes, options);
}

/** `readChunks`, in a worker. */
export function readChunksAsync(bytes: Uint8Array, options?: ReadChunksOptions & JobOptions): Promise<PngChunks> {
    return defaultWorkerPool().readChunks(bytes, options);
}

/** `readHeader`, in a worker. */
export function readHeaderAsync(bytes: Uint8Array, options?: JobOptions): Promise<PngHeader> {
    return defaultWorkerPool().readHeader(bytes, options);
}

/** `parseText`, in a worker. */
export function parseTextAsync(type: PngText["chunkType"], data: Uint8Array, options?: JobOptions): Promise<PngText> {
    return defaultWorkerPool().parseText(type, data, options);
}

/** `encode`, in a worker. */
export function encodeAsync(image: PngImage, options?: EncodeOptions & JobOptions): Promise<Uint8Array> {
    return defaultWorkerPool().encode(image, options);
}

/** `encodeRgba8`, in a worker. */
export function encodeRgba8Async(image: RgbaImageInput, options?: EncodeOptions & JobOptions): Promise<Uint8Array> {
    return defaultWorkerPool().encodeRgba8(image, options);
}
