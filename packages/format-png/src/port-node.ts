// The worker side of a WorkerPool in Node: worker_threads' `parentPort`.
import { parentPort } from "node:worker_threads";
import type { Request } from "./protocol.js";

const port = parentPort!;

export function listen(handler: (request: Request) => void): void {
    port.on("message", handler);
}

export function post(message: unknown, transfer: ArrayBuffer[]): void {
    port.postMessage(message, transfer);
}
