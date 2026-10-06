// Starts a WorkerPool worker in Node, with worker_threads.
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

export function spawnWorker(): Worker {
    return new Worker(new URL("./worker.js", import.meta.url));
}

export function defaultSize(): number {
    return availableParallelism();
}
