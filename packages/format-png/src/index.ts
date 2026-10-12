// The sync API. Types all; values by name, as core.ts also has internals for the worker pool.
export type * from "./core.js";
export {
    PngDecoder, PngEncoder, PngError, decode, decodeAnimation, decodeAnimationRgba8, decodeRgba8, encode, encodeAnimation, encodeAnimationRgba8,
    encodeRgba8, frameDelayMs, init, parseText, pixelsPerInch, readChunks, readHeader, toImageData,
} from "./core.js";
export { createWorkerPool, WorkerPoolError } from "./pool.js";
export type { JobOptions, NodeWorkerLike, WorkerPool, WorkerPoolOptions } from "./pool.js";
export {
    decodeAnimationAsync, decodeAnimationRgba8Async, decodeAsync, decodeRgba8Async, defaultWorkerPool, encodeAnimationAsync,
    encodeAnimationRgba8Async, encodeAsync, encodeRgba8Async, parseTextAsync, readChunksAsync, readHeaderAsync, terminateDefaultWorkerPool,
} from "./async.js";
