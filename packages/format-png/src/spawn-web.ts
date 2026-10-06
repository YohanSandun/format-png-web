// Starts a WorkerPool worker in browsers, bundlers and Web Workers. Written as
// `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })` so
// bundlers such as Vite and webpack find and bundle the worker.

export function spawnWorker(): Worker {
    return new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
}

export function defaultSize(): number {
    return globalThis.navigator?.hardwareConcurrency || 4;
}
