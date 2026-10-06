import { defaultSize, spawnWorker } from "#spawn";
import {
    PngError,
    type DecodeOptions, type EncodeOptions, type PngChunks, type PngHeader, type PngImage, type PngText, type RawImage,
    type ReadChunksOptions, type RgbaImage, type RgbaImageInput,
} from "./core.js";
import type { Op, Request, Response, SerializedError } from "./protocol.js";

/** The parts of a Node `worker_threads` `Worker` a pool uses. */
export interface NodeWorkerLike {
    postMessage(value: unknown, transferList?: readonly ArrayBuffer[]): void;
    on(event: "message" | "error" | "messageerror" | "exit", listener: (value: any) => void): unknown;
    terminate(): unknown;
    ref?(): void;
    unref?(): void;
}

export interface WorkerPoolOptions {
    /**
     * The most workers to run at once. Default: the number of CPU cores
     * (`navigator.hardwareConcurrency`, or `os.availableParallelism()` in Node),
     * at most 8.
     */
    size?: number;
    /**
     * Starts a worker running format-png's worker script, instead of the pool
     * starting one itself. Only needed with bundlers that don't bundle
     * `new Worker(new URL("./worker.js", import.meta.url))`, such as esbuild, or
     * to start workers your own way.
     */
    createWorker?: () => Worker | NodeWorkerLike;
}

/** Options for one job, taken by every `WorkerPool` method alongside its usual options. */
export interface JobOptions {
    /**
     * Move the input's `ArrayBuffer` to the worker instead of copying it.
     * Default false. The buffer is detached as soon as the method is called:
     * the input, and every other view of the same buffer, becomes empty. It
     * must be a plain `ArrayBuffer`, not a `SharedArrayBuffer`. For `encode`
     * and `encodeRgba8` this applies to `image.data`; the rest is copied.
     */
    transfer?: boolean;
    /**
     * Cancels the job, rejecting it with `signal.reason`. A queued job is taken
     * off the queue; a running one has its worker stopped and replaced.
     */
    signal?: AbortSignal;
}

/**
 * Runs format-png in Web Workers (or worker_threads in Node), so decoding and
 * encoding don't block the calling thread. Each method takes the same
 * arguments as the function of the same name and resolves to the same result,
 * or rejects with the same `PngError`.
 *
 * Workers start when jobs need them, at most `size`, and stay alive between
 * jobs until `terminate()`. Jobs queue when every worker is busy and start in
 * the order they were submitted.
 */
export interface WorkerPool {
    /** The most workers this pool runs at once. */
    readonly size: number;
    decode(bytes: Uint8Array, options?: DecodeOptions & JobOptions): Promise<RawImage>;
    decodeRgba8(bytes: Uint8Array, options?: DecodeOptions & JobOptions): Promise<RgbaImage>;
    /**
     * As with the `readChunks` function, each chunk's `data` is a view into
     * `bytes`; with `transfer: true`, into a buffer moved back from the worker.
     */
    readChunks(bytes: Uint8Array, options?: ReadChunksOptions & JobOptions): Promise<PngChunks>;
    readHeader(bytes: Uint8Array, options?: JobOptions): Promise<PngHeader>;
    parseText(type: PngText["chunkType"], data: Uint8Array, options?: JobOptions): Promise<PngText>;
    encode(image: PngImage, options?: EncodeOptions & JobOptions): Promise<Uint8Array>;
    encodeRgba8(image: RgbaImageInput, options?: EncodeOptions & JobOptions): Promise<Uint8Array>;
    /**
     * Stops every worker. Queued and running jobs, and every later call, reject
     * with a `WorkerPoolError` whose `code` is "terminated".
     */
    terminate(): Promise<void>;
}

/**
 * A job that failed because of the pool rather than the PNG: "terminated" if
 * the pool was terminated, "worker-crashed" if its worker stopped unexpectedly
 * (the pool replaces it).
 */
export class WorkerPoolError extends Error {
    override name = "WorkerPoolError";

    constructor(readonly code: "terminated" | "worker-crashed", message: string) {
        super(message);
    }
}

const terminated = () => new WorkerPoolError("terminated", "format-png: the worker pool was terminated");

/** Creates a pool of workers. Nothing starts until the first job. */
export function createWorkerPool(options: WorkerPoolOptions = {}): WorkerPool {
    const size = options.size ?? Math.min(Math.max(defaultSize(), 1), 8);
    if (!Number.isInteger(size) || size < 1) throw new RangeError(`format-png: a worker pool's size must be a whole number of at least 1, not ${size}`);
    return new Pool(size, options.createWorker ?? spawnWorker);
}

interface Job {
    request: Request;
    transfer: ArrayBuffer[];
    finish(value: unknown): unknown;
    resolve(value: unknown): void;
    reject(error: unknown): void;
    signal?: AbortSignal;
    onAbort?: () => void;
}

/** A worker, in either environment. */
interface Handle {
    post(request: Request, transfer: ArrayBuffer[]): void;
    terminate(): Promise<void>;
    /** In Node, whether the worker keeps the process alive. */
    keepAlive(on: boolean): void;
}

interface Slot {
    handle: Handle;
    job?: Job;
    retired: boolean;
}

function isNodeWorker(worker: Worker | NodeWorkerLike): worker is NodeWorkerLike {
    return typeof (worker as NodeWorkerLike).on === "function";
}

function wrap(worker: Worker | NodeWorkerLike, onResponse: (response: Response) => void, onCrash: (message: string) => void): Handle {
    if (isNodeWorker(worker)) {
        worker.on("message", onResponse);
        worker.on("error", (error: unknown) => onCrash(error instanceof Error ? error.message : String(error)));
        worker.on("messageerror", () => onCrash("a message from the worker couldn't be read"));
        worker.on("exit", (code: number) => onCrash(`the worker exited with code ${code}`));
        return {
            post: (request, transfer) => worker.postMessage(request, transfer),
            terminate: async () => void (await worker.terminate()),
            keepAlive: (on) => (on ? worker.ref?.() : worker.unref?.()),
        };
    }
    worker.addEventListener("message", (event) => onResponse(event.data));
    worker.addEventListener("error", (event) => {
        event.preventDefault();
        onCrash(event.message || "the worker failed to start or threw an uncaught error");
    });
    worker.addEventListener("messageerror", () => onCrash("a message from the worker couldn't be read"));
    return {
        post: (request, transfer) => worker.postMessage(request, transfer),
        terminate: async () => worker.terminate(),
        keepAlive: () => {},
    };
}

const errorClasses: Record<string, ErrorConstructor> = { TypeError, RangeError, SyntaxError, ReferenceError };

function toError({ name, message }: SerializedError): Error {
    if (name === "PngError") return new PngError(message);
    const error = new (errorClasses[name] ?? Error)(message);
    error.name = name;
    return error;
}

/**
 * A copy of `bytes` the pool owns, with a buffer of its own: copied, or moved
 * with `transfer`, which detaches the caller's buffer now rather than when the
 * job starts.
 */
function own<T extends Uint8Array | Uint8ClampedArray>(bytes: T, transfer: boolean | undefined): T & { buffer: ArrayBuffer } {
    // Uint8Array or Uint8ClampedArray, never a subclass: a Node Buffer's `slice` doesn't copy.
    const Type = (bytes instanceof Uint8ClampedArray ? Uint8ClampedArray : Uint8Array) as unknown as {
        new (source: ArrayLike<number>): T & { buffer: ArrayBuffer };
        new (buffer: ArrayBuffer, byteOffset: number, length: number): T & { buffer: ArrayBuffer };
    };
    if (!transfer) return new Type(bytes);
    const { buffer, byteOffset, length } = bytes;
    if (!(buffer instanceof ArrayBuffer)) throw new TypeError("format-png: `transfer` needs an ArrayBuffer; a SharedArrayBuffer can't be transferred");
    return new Type(structuredClone(buffer, { transfer: [buffer] }), byteOffset, length);
}

/** The options to send to the worker: without `transfer` and `signal`, which can't be cloned. */
function workerOptions<T extends object>(options: T & JobOptions): T {
    const { transfer: _transfer, signal: _signal, ...rest } = options;
    return rest as T;
}

class Pool implements WorkerPool {
    readonly size: number;
    #createWorker: () => Worker | NodeWorkerLike;
    #slots: Slot[] = [];
    #queue: Job[] = [];
    #nextId = 1;
    #terminated = false;

    constructor(size: number, createWorker: () => Worker | NodeWorkerLike) {
        this.size = size;
        this.#createWorker = createWorker;
    }

    async decode(bytes: Uint8Array, options: DecodeOptions & JobOptions = {}): Promise<RawImage> {
        this.#check(options);
        const input = own(bytes, options.transfer);
        return this.#submit("decode", [input, workerOptions(options)], [input.buffer], options) as Promise<RawImage>;
    }

    async decodeRgba8(bytes: Uint8Array, options: DecodeOptions & JobOptions = {}): Promise<RgbaImage> {
        this.#check(options);
        const input = own(bytes, options.transfer);
        return this.#submit("decodeRgba8", [input, workerOptions(options)], [input.buffer], options) as Promise<RgbaImage>;
    }

    async readChunks(bytes: Uint8Array, options: ReadChunksOptions & JobOptions = {}): Promise<PngChunks> {
        this.#check(options);
        const input = own(bytes, options.transfer);
        const returnInput = options.transfer ?? false;
        return this.#submit("readChunks", [input, workerOptions(options)], [input.buffer], options, (value) => {
            // The worker sent each chunk's data as its length. Rebuilt as views
            // into the caller's bytes, as `readChunks` returns, or into the
            // input moved back from the worker.
            const { chunks, input: returned } = value as { chunks: PngChunks; input?: Uint8Array };
            const base = returned ?? bytes;
            for (const chunk of chunks.chunks) {
                const length = chunk.data as unknown as number;
                chunk.data = base.subarray(chunk.offset + 8, chunk.offset + 8 + length);
            }
            return chunks;
        }, returnInput) as Promise<PngChunks>;
    }

    async readHeader(bytes: Uint8Array, options: JobOptions = {}): Promise<PngHeader> {
        this.#check(options);
        const input = own(bytes, options.transfer);
        return this.#submit("readHeader", [input], [input.buffer], options) as Promise<PngHeader>;
    }

    async parseText(type: PngText["chunkType"], data: Uint8Array, options: JobOptions = {}): Promise<PngText> {
        this.#check(options);
        const input = own(data, options.transfer);
        return this.#submit("parseText", [type, input], [input.buffer], options) as Promise<PngText>;
    }

    async encode(image: PngImage, options: EncodeOptions & JobOptions = {}): Promise<Uint8Array> {
        this.#check(options);
        const data = own(image.data, options.transfer);
        return this.#submit("encode", [{ ...image, data }, workerOptions(options)], [data.buffer], options) as Promise<Uint8Array>;
    }

    async encodeRgba8(image: RgbaImageInput, options: EncodeOptions & JobOptions = {}): Promise<Uint8Array> {
        this.#check(options);
        // Only the fields `encodeRgba8` reads: an `ImageData` would otherwise be cloned whole.
        const { width, height, metadata, chunks, interlaced } = image;
        const data = own(image.data, options.transfer);
        const input: RgbaImageInput = { width, height, data, metadata, chunks, interlaced };
        return this.#submit("encodeRgba8", [input, workerOptions(options)], [data.buffer], options) as Promise<Uint8Array>;
    }

    async terminate(): Promise<void> {
        this.#terminated = true;
        for (const job of this.#queue.splice(0)) this.#settle(job, () => job.reject(terminated()));
        await Promise.all(this.#slots.splice(0).map((slot) => {
            const { job } = slot;
            if (job) this.#settle(job, () => job.reject(terminated()));
            return this.#retire(slot);
        }));
    }

    /** Throws if the job can't start, before its input is copied or detached. */
    #check(options: JobOptions): void {
        if (this.#terminated) throw terminated();
        if (options.signal?.aborted) throw options.signal.reason;
    }

    #submit(op: Op, args: unknown[], transfer: ArrayBuffer[], options: JobOptions, finish: (value: unknown) => unknown = (value) => value, returnInput?: boolean): Promise<unknown> {
        const { signal } = options;
        return new Promise((resolve, reject) => {
            const request: Request = { id: this.#nextId++, op, args };
            if (returnInput) request.returnInput = true;
            const job: Job = { request, transfer, finish, resolve, reject, signal };
            if (signal) {
                job.onAbort = () => this.#abort(job);
                signal.addEventListener("abort", job.onAbort, { once: true });
            }
            this.#queue.push(job);
            this.#pump();
        });
    }

    /** Starts queued jobs, in order, on idle workers, starting workers as needed. */
    #pump(): void {
        while (this.#queue.length > 0) {
            let slot = this.#slots.find((candidate) => !candidate.job);
            if (!slot) {
                if (this.#slots.length >= this.size) return;
                try {
                    slot = this.#spawn();
                } catch (error) {
                    const job = this.#queue.shift()!;
                    this.#settle(job, () => job.reject(error));
                    continue;
                }
            }
            const job = this.#queue.shift()!;
            slot.job = job;
            slot.handle.keepAlive(true);
            try {
                slot.handle.post(job.request, job.transfer);
            } catch (error) {
                slot.job = undefined;
                slot.handle.keepAlive(false);
                this.#settle(job, () => job.reject(error));
            }
        }
    }

    #spawn(): Slot {
        const slot: Slot = { handle: undefined!, retired: false };
        slot.handle = wrap(
            this.#createWorker(),
            (response) => this.#onResponse(slot, response),
            (message) => this.#onCrash(slot, message),
        );
        slot.handle.keepAlive(false);
        this.#slots.push(slot);
        return slot;
    }

    #onResponse(slot: Slot, response: Response): void {
        const { job } = slot;
        if (slot.retired || !job || job.request.id !== response.id) return;
        slot.job = undefined;
        slot.handle.keepAlive(false);
        if (!response.ok && response.retire) void this.#retire(slot);
        this.#settle(job, () => {
            if (!response.ok) {
                job.reject(toError(response.error));
                return;
            }
            try {
                job.resolve(job.finish(response.value));
            } catch (error) {
                job.reject(error);
            }
        });
        this.#pump();
    }

    #onCrash(slot: Slot, message: string): void {
        if (slot.retired) return;
        const { job } = slot;
        void this.#retire(slot);
        if (job) this.#settle(job, () => job.reject(new WorkerPoolError("worker-crashed", `format-png: a worker crashed: ${message}`)));
        this.#pump();
    }

    #abort(job: Job): void {
        const reason = job.signal!.reason;
        const queued = this.#queue.indexOf(job);
        if (queued >= 0) {
            this.#queue.splice(queued, 1);
        } else {
            // Running: wasm can't be interrupted, so its worker goes.
            const slot = this.#slots.find((candidate) => candidate.job === job);
            if (!slot) return; // already settled
            void this.#retire(slot);
        }
        this.#settle(job, () => job.reject(reason));
        this.#pump();
    }

    #retire(slot: Slot): Promise<void> {
        slot.retired = true;
        slot.job = undefined;
        const index = this.#slots.indexOf(slot);
        if (index >= 0) this.#slots.splice(index, 1);
        return slot.handle.terminate().catch(() => {});
    }

    #settle(job: Job, settle: () => void): void {
        if (job.onAbort) job.signal!.removeEventListener("abort", job.onAbort);
        settle();
    }
}
