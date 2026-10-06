// The messages between a WorkerPool and its workers. The same in browsers and
// Node; only how a message is posted differs (see spawn-*.ts and port-*.ts).
//
// Each worker runs one job at a time:
//   pool → worker  { id, op, args, returnInput }   input buffers transferred
//   worker → pool  { id, ok: true, value }          output buffers transferred
//                  { id, ok: false, error, retire } retire: the worker can't be trusted anymore

export type Op = "decode" | "decodeRgba8" | "readChunks" | "readHeader" | "parseText" | "encode" | "encodeRgba8";

export interface Request {
    id: number;
    op: Op;
    args: unknown[];
    /** `readChunks` only: send the input back, as the chunks' data are views into it. */
    returnInput?: boolean;
}

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
