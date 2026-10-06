// The messages between a WorkerPool and its workers. The same in browsers and
// Node; only how a message is posted differs (see spawn-*.ts and port-*.ts).
//
// Each worker runs one task at a time:
//   pool → worker  { id, op, args, returnInput, split, handle }   input buffers transferred
//   worker → pool  { id, ok: true, value }          output buffers transferred
//                  { id, ok: false, error, retire } retire: the worker can't be trusted anymore
//
// Most jobs are one task. An encode with `split` is several, so one image is
// compressed by every worker:
//   1. "encode"/"encodeRgba8", split, handle h, on any worker A. A prepares the
//      image. With no segments it returns { png }. Otherwise it keeps the
//      prepared image as h and returns { segments, level, strategy }.
//   2. "compressSegment" [segment, level, strategy] for each, on any worker.
//   3. "finish" [h, compressed] on A: the PNG. A drops h, whatever happens.
//   Or "free" [h] on A, if the job failed or was cancelled first.
// A worker holding prepared images still runs other tasks between these.

export type Op =
    | "decode" | "decodeRgba8" | "readChunks" | "readHeader" | "parseText" | "encode" | "encodeRgba8"
    | "compressSegment" | "finish" | "free"
    /** How many prepared images the worker holds: for tests. */
    | "handles";

export interface Request {
    id: number;
    op: Op;
    args: unknown[];
    /** `readChunks` only: send the input back, as the chunks' data are views into it. */
    returnInput?: boolean;
    /** `encode` and `encodeRgba8`: prepare the image, keeping it as `handle`, rather than encode it. */
    split?: boolean;
    handle?: number;
}

/** What an `encode` with `split` returns. */
export type Prepared =
    | { png: Uint8Array }
    | { segments: Uint8Array[]; level: number; strategy: string };

export interface SerializedError {
    name: string;
    message: string;
}

export type Response =
    | { id: number; ok: true; value: unknown }
    | { id: number; ok: false; error: SerializedError; retire: boolean };

/**
 * The buffers of every typed array in `value`, to transfer rather than copy.
 * Only call it on values whose buffers nothing else uses.
 */
export function buffersIn(value: unknown, found = new Set<ArrayBuffer>()): ArrayBuffer[] {
    if (ArrayBuffer.isView(value)) {
        if (value.buffer instanceof ArrayBuffer) found.add(value.buffer);
    } else if (Array.isArray(value)) {
        for (const item of value) buffersIn(item, found);
    } else if (value !== null && typeof value === "object") {
        for (const item of Object.values(value)) buffersIn(item, found);
    }
    return [...found];
}
