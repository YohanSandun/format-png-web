import { defaultSize, spawnWorker } from "#spawn";
import {
    PngError,
    type DecodeOptions, type EncodeOptions, type PngChunks, type PngHeader, type PngImage, type PngText, type RawImage,
    type ReadChunksOptions, type RgbaImage, type RgbaImageInput,
} from "./core.js";
import type { Op, Prepared, Request, Response, SerializedError } from "./protocol.js";

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

/**
 * A call to a pool method. Most are one task; an encode split across the
 * workers is a task to prepare the image, one per segment to compress it, and
 * one to finish it.
 */
interface Job {
    /** Tasks waiting for any worker, in order. */
    queue: Task[];
    /** The workers running this job's tasks now. */
    running: Set<Slot>;
    /** Where this job's prepared image is kept, once there is one. */
    prepared?: { slot: Slot; handle: number };
    /** Its "finish" task is on its way: the worker frees the prepared image then, whatever happens. */
    finishing: boolean;
    settled: boolean;
    resolve(value: unknown): void;
    reject(error: unknown): void;
    signal?: AbortSignal;
    onAbort?: () => void;
}

/** One message to a worker, and what to do with the answer. */
interface Task {
    job: Job;
    op: Op;
    args: unknown[];
    transfer: ArrayBuffer[];
    /** More of the request: `returnInput`, `split` and `handle`. */
    request?: Partial<Request>;
    /** The answer, even after the job settled, so a prepared image can still be freed. */
    done(value: unknown, slot: Slot): void;
    /** Runs when the worker answers, whether it succeeded or failed. */
    after?(): void;
}

/** A worker, in either environment. */
interface Connection {
    post(request: Request, transfer: ArrayBuffer[]): void;
    terminate(): Promise<void>;
    /** In Node, whether the worker keeps the process alive. */
    keepAlive(on: boolean): void;
}

interface Slot {
    worker: Connection;
    /** The task it's running, if any, and that request's id. */
    task?: Task;
    taskId?: number;
    /** Tasks only this worker can run, as it holds their prepared images: "finish" and "free". They go first. */
    pinned: Task[];
    /** The jobs whose prepared images this worker holds. */
    holds: Set<Job>;
    retired: boolean;
}

function isNodeWorker(worker: Worker | NodeWorkerLike): worker is NodeWorkerLike {
    return typeof (worker as NodeWorkerLike).on === "function";
}

function wrap(worker: Worker | NodeWorkerLike, onResponse: (response: Response) => void, onCrash: (message: string) => void): Connection {
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

const crashed = (message: string) => new WorkerPoolError("worker-crashed", `format-png: a worker crashed: ${message}`);

/**
 * Schedules tasks on workers. A worker runs one task at a time. When one is
 * free, it first runs its pinned tasks, then the next task of the next job, in
 * turn: a job split into many segments doesn't hold up the jobs after it.
 * Nothing waits while holding a worker, so nothing can deadlock: a prepared
 * image waiting for its segments only takes memory in the worker that holds
 * it, which runs other tasks meanwhile, including those segments.
 */
class Pool implements WorkerPool {
    readonly size: number;
    #createWorker: () => Worker | NodeWorkerLike;
    #slots: Slot[] = [];
    /** Jobs with queued tasks, in order; `#next` is the one whose turn it is. */
    #jobs: Job[] = [];
    #next = 0;
    /** Every job not settled yet. */
    #active = new Set<Job>();
    #nextId = 1;
    #nextHandle = 1;
    #terminated = false;

    constructor(size: number, createWorker: () => Worker | NodeWorkerLike) {
        this.size = size;
        this.#createWorker = createWorker;
    }

    async decode(bytes: Uint8Array, options: DecodeOptions & JobOptions = {}): Promise<RawImage> {
        this.#check(options);
        const input = own(bytes, options.transfer);
        return this.#single("decode", [input, workerOptions(options)], [input.buffer], options) as Promise<RawImage>;
    }

    async decodeRgba8(bytes: Uint8Array, options: DecodeOptions & JobOptions = {}): Promise<RgbaImage> {
        this.#check(options);
        const input = own(bytes, options.transfer);
        return this.#single("decodeRgba8", [input, workerOptions(options)], [input.buffer], options) as Promise<RgbaImage>;
    }

    async readChunks(bytes: Uint8Array, options: ReadChunksOptions & JobOptions = {}): Promise<PngChunks> {
        this.#check(options);
        const input = own(bytes, options.transfer);
        const returnInput = options.transfer ?? false;
        return this.#single("readChunks", [input, workerOptions(options)], [input.buffer], options, (value) => {
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
        return this.#single("readHeader", [input], [input.buffer], options) as Promise<PngHeader>;
    }

    async parseText(type: PngText["chunkType"], data: Uint8Array, options: JobOptions = {}): Promise<PngText> {
        this.#check(options);
        const input = own(data, options.transfer);
        return this.#single("parseText", [type, input], [input.buffer], options) as Promise<PngText>;
    }

    async encode(image: PngImage, options: EncodeOptions & JobOptions = {}): Promise<Uint8Array> {
        this.#check(options);
        const data = own(image.data, options.transfer);
        return this.#encode("encode", { ...image, data }, data.buffer, options);
    }

    async encodeRgba8(image: RgbaImageInput, options: EncodeOptions & JobOptions = {}): Promise<Uint8Array> {
        this.#check(options);
        // Only the fields `encodeRgba8` reads: an `ImageData` would otherwise be cloned whole.
        const { width, height, metadata, chunks, interlaced } = image;
        const data = own(image.data, options.transfer);
        return this.#encode("encodeRgba8", { width, height, data, metadata, chunks, interlaced }, data.buffer, options);
    }

    async terminate(): Promise<void> {
        this.#terminated = true;
        for (const job of this.#active) this.#fail(job, terminated());
        await Promise.all(this.#slots.splice(0).map((slot) => this.#retire(slot)));
    }

    /** Throws if the job can't start, before its input is copied or detached. */
    #check(options: JobOptions): void {
        if (this.#terminated) throw terminated();
        if (options.signal?.aborted) throw options.signal.reason;
    }

    /** A job of one task, whose answer `finish` turns into the result. */
    #single(op: Op, args: unknown[], transfer: ArrayBuffer[], options: JobOptions, finish: (value: unknown) => unknown = (value) => value, returnInput?: boolean): Promise<unknown> {
        return this.#submit(options, (job) => ({
            job, op, args, transfer,
            request: returnInput ? { returnInput } : undefined,
            done: (value) => this.#succeed(job, finish(value)),
        }));
    }

    /**
     * Encodes on one worker with `threads: "single"`. Otherwise, by default,
     * prepares the image on one worker and compresses its segments on all of
     * them: the same bytes as `threads: "auto"`.
     */
    #encode(op: "encode" | "encodeRgba8", image: PngImage | RgbaImageInput, buffer: ArrayBuffer, options: EncodeOptions & JobOptions): Promise<Uint8Array> {
        const threads = options.threads ?? "auto";
        const args = [image, { ...workerOptions(options), threads }];
        if (threads === "single") return this.#single(op, args, [buffer], options) as Promise<Uint8Array>;
        const handle = this.#nextHandle++;
        return this.#submit(options, (job) => ({
            job, op, args, transfer: [buffer],
            request: { split: true, handle },
            done: (value, slot) => this.#prepared(job, slot, handle, value as Prepared),
        })) as Promise<Uint8Array>;
    }

    /** A split encode's image is prepared: queues its segments, then its "finish" on the worker that prepared it. */
    #prepared(job: Job, slot: Slot, handle: number, value: Prepared): void {
        if ("png" in value) {
            this.#succeed(job, value.png); // small enough to have no segments
            return;
        }
        job.prepared = { slot, handle };
        slot.holds.add(job);
        if (job.settled) {
            this.#free(job); // cancelled while it was being prepared
            return;
        }
        const { segments, level, strategy } = value;
        const compressed: Uint8Array[] = new Array(segments.length);
        let remaining = segments.length;
        job.queue = segments.map((segment, i): Task => ({
            job,
            op: "compressSegment",
            args: [segment, level, strategy],
            transfer: [segment.buffer as ArrayBuffer],
            done: (result) => {
                if (job.settled) return;
                compressed[i] = result as Uint8Array;
                if (--remaining > 0) return;
                job.finishing = true;
                slot.pinned.push({
                    job,
                    op: "finish",
                    args: [handle, compressed],
                    transfer: compressed.map((part) => part.buffer as ArrayBuffer),
                    after: () => {
                        slot.holds.delete(job);
                        job.prepared = undefined;
                    },
                    done: (png) => this.#succeed(job, png),
                });
            },
        }));
        this.#jobs.push(job);
    }

    /** Frees the job's prepared image, if it has one that "finish" won't free. */
    #free(job: Job): void {
        const { prepared } = job;
        if (!prepared || job.finishing) return;
        job.prepared = undefined;
        const { slot, handle } = prepared;
        slot.pinned.push({ job, op: "free", args: [handle], transfer: [], after: () => slot.holds.delete(job), done: () => {} });
    }

    #submit(options: JobOptions, first: (job: Job) => Task): Promise<unknown> {
        const { signal } = options;
        return new Promise((resolve, reject) => {
            const job: Job = { queue: [], running: new Set(), finishing: false, settled: false, resolve, reject, signal };
            job.queue.push(first(job));
            if (signal) {
                job.onAbort = () => this.#abort(job);
                signal.addEventListener("abort", job.onAbort, { once: true });
            }
            this.#active.add(job);
            this.#jobs.push(job);
            this.#pump();
        });
    }

    /** Starts tasks on idle workers, starting workers as needed. */
    #pump(): void {
        for (;;) {
            for (const slot of this.#slots) {
                if (!slot.task && slot.pinned.length > 0) this.#run(slot, slot.pinned.shift()!);
            }
            if (this.#jobs.length === 0) return;
            let slot = this.#slots.find((candidate) => !candidate.task);
            if (!slot) {
                if (this.#slots.length >= this.size) return;
                try {
                    slot = this.#spawn();
                } catch (error) {
                    this.#fail(this.#jobs[0], error);
                    continue;
                }
            }
            // Round robin: the next job's next task.
            if (this.#next >= this.#jobs.length) this.#next = 0;
            const job = this.#jobs[this.#next];
            const task = job.queue.shift()!;
            if (job.queue.length === 0) this.#jobs.splice(this.#next, 1);
            else this.#next++;
            this.#run(slot, task);
        }
    }

    #run(slot: Slot, task: Task): void {
        const id = this.#nextId++;
        slot.task = task;
        slot.taskId = id;
        task.job.running.add(slot);
        slot.worker.keepAlive(true);
        try {
            slot.worker.post({ id, op: task.op, args: task.args, ...task.request }, task.transfer);
        } catch (error) {
            slot.task = undefined;
            task.job.running.delete(slot);
            slot.worker.keepAlive(false);
            task.after?.();
            this.#fail(task.job, error);
        }
    }

    #spawn(): Slot {
        const slot: Slot = { worker: undefined!, pinned: [], holds: new Set(), retired: false };
        slot.worker = wrap(
            this.#createWorker(),
            (response) => this.#onResponse(slot, response),
            (message) => this.#onCrash(slot, message),
        );
        slot.worker.keepAlive(false);
        this.#slots.push(slot);
        return slot;
    }

    #onResponse(slot: Slot, response: Response): void {
        const { task } = slot;
        if (slot.retired || !task || slot.taskId !== response.id) return;
        slot.task = undefined;
        task.job.running.delete(slot);
        slot.worker.keepAlive(false);
        task.after?.();
        if (!response.ok) {
            this.#fail(task.job, toError(response.error));
            // A trap: the worker goes, with any other job's prepared image.
            if (response.retire) void this.#retire(slot, crashed("its WebAssembly instance failed"));
        } else {
            try {
                task.done(response.value, slot);
            } catch (error) {
                this.#fail(task.job, error);
            }
        }
        this.#pump();
    }

    #onCrash(slot: Slot, message: string): void {
        if (slot.retired) return;
        void this.#retire(slot, crashed(message));
        this.#pump();
    }

    #abort(job: Job): void {
        if (job.settled) return;
        // Running tasks: wasm can't be interrupted, so their workers go, unless
        // a worker holds prepared images, which would go with it. Then its task
        // finishes, and the result is dropped.
        const stop = [...job.running].filter((slot) => slot.holds.size === 0);
        this.#fail(job, job.signal!.reason);
        for (const slot of stop) void this.#retire(slot);
        this.#pump();
    }

    /** Rejects the job, drops its queued tasks, and frees its prepared image. */
    #fail(job: Job, error: unknown): void {
        if (job.settled) return;
        this.#settle(job);
        job.reject(error);
        job.queue.length = 0;
        const index = this.#jobs.indexOf(job);
        if (index >= 0) {
            this.#jobs.splice(index, 1);
            if (index < this.#next) this.#next--;
        }
        this.#free(job);
    }

    #succeed(job: Job, value: unknown): void {
        if (job.settled) return;
        this.#settle(job);
        job.resolve(value);
    }

    #settle(job: Job): void {
        job.settled = true;
        this.#active.delete(job);
        if (job.onAbort) job.signal!.removeEventListener("abort", job.onAbort);
    }

    /**
     * Stops a worker. With `error`, the job it was running and every job whose
     * prepared image it held reject with it.
     */
    #retire(slot: Slot, error?: Error): Promise<void> {
        slot.retired = true;
        const index = this.#slots.indexOf(slot);
        if (index >= 0) this.#slots.splice(index, 1);
        const { task } = slot;
        slot.task = undefined;
        if (task) {
            task.job.running.delete(slot);
            if (error) this.#fail(task.job, error);
        }
        for (const job of slot.holds) {
            job.prepared = undefined; // gone with the worker
            if (error) this.#fail(job, error);
        }
        slot.holds.clear();
        slot.pinned.length = 0;
        return slot.worker.terminate().catch(() => {});
    }
}
