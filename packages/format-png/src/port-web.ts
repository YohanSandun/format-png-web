// The worker side of a WorkerPool in browsers: a Web Worker's `self`.
import type { Request } from "./protocol.js";

const scope = self as unknown as {
    addEventListener(type: "message", listener: (event: MessageEvent<Request>) => void): void;
    postMessage(message: unknown, transfer: Transferable[]): void;
};

export function listen(handler: (request: Request) => void): void {
    scope.addEventListener("message", (event) => handler(event.data));
}

export function post(message: unknown, transfer: ArrayBuffer[]): void {
    scope.postMessage(message, transfer);
}
