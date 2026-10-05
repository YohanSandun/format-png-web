// Encodes PNGs for the Minimize section off the main thread. Each worker has
// its own copy of the wasm module, so several encode at once.
//
// Messages in:
// - `{ kind: "image", run, image }`: the image the jobs of `run` encode. Sent
//   once per run, so the pixels aren't copied for every job.
// - `{ kind: "job", run, id, options }`: encode the image with `options`.
// Messages out:
// - `{ run, id, png, elapsed }`, with `png`'s buffer transferred, or
//   `{ run, id, error }`.

import { PngEncoder, init, type EncodeOptions, type PngImage } from "format-png";

export type WorkerRequest =
    | { kind: "image"; run: number; image: PngImage }
    | { kind: "job"; run: number; id: number; options: EncodeOptions };

export type WorkerResponse =
    | { run: number; id: number; png: Uint8Array; elapsed: number }
    | { run: number; id: number; error: string };

const ready = init();
let current: { run: number; image: PngImage } | undefined;

self.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
    const request = event.data;
    if (request.kind === "image") {
        current = { run: request.run, image: request.image };
        return;
    }

    const { run, id, options } = request;
    let response: WorkerResponse;
    try {
        await ready;
        if (current?.run !== run) throw new Error(`no image for run ${run}`);
        const encoder = new PngEncoder(options);
        try {
            const start = performance.now();
            const png = encoder.encode(current.image);
            response = { run, id, png, elapsed: performance.now() - start };
        } finally {
            encoder.free();
        }
    } catch (error) {
        response = { run, id, error: error instanceof Error ? error.message : String(error) };
    }
    self.postMessage(response, { transfer: "png" in response ? [response.png.buffer] : [] });
});
