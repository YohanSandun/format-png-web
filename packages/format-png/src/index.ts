// The sync API. Types all; values by name, as core.ts also has internals for the worker pool.
export type * from "./core.js";
export {
    PngDecoder, PngEncoder, PngError, decode, decodeRgba8, encode, encodeRgba8, init, parseText, pixelsPerInch, readChunks, readHeader,
    toImageData,
} from "./core.js";
export { createWorkerPool, WorkerPoolError } from "./pool.js";
export type { JobOptions, NodeWorkerLike, WorkerPool, WorkerPoolOptions } from "./pool.js";
export {
    decodeAsync, decodeRgba8Async, defaultWorkerPool, encodeAsync, encodeRgba8Async, parseTextAsync, readChunksAsync, readHeaderAsync,
    terminateDefaultWorkerPool,
} from "./async.js";
